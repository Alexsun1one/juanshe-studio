/**
 * 卷舍 · 阶段处理器(把状态机各阶段真正实现出来)
 *
 * makeHandlers(llm) 返回 7 个阶段的 StageHandler;注入 LlmClient,因此可单测、可换底座。
 * 每个阶段做的事:
 *   planning  规划师 → 结构化写作蓝图(节拍/情绪/伏笔/钩子)
 *   writing   写手   → 按蓝图流式写正文(组装提示词时已注入去AI味 + 题材/平台知识;
 *                      本书 ≥3 章签发成稿时再注入风格指纹,贴合已成形的作者声音)
 *   reviewing 质检   → judgeChapter(L0+L1 联防)产出门禁(pass/revise/regenerate);
 *                      judge 分落边缘带时加跑读者评审官第二信号(追读/弃书视角,不改分数门禁)
 *   revising  修订   → 按 mustFix 定向改稿(无必修项直通;局部问题走 PATCH 补丁、结构问题走整章修订)
 *   polishing 润色   → 文字层 humanize,PATCH 定点补丁模式;跳过门三态:全干净直通、
 *                      无红旗但 warning 攒多走轻量 PATCH 只修点名处、有红旗正常润色
 *   verifying 终审   → 再判一次 + 篇幅终检,可回退返修(由 nextStage 计返修轮次);
 *                      另对风格指纹算契合度入 artifacts(观察期,不进 verdict);
 *                      边缘带同样加跑读者评审官,弃书点(带前缀)进终审必修
 *   publishing 签发  → 确定性组装章节对象(无 LLM)
 *
 * 数据流:不可变种子在 state.input;各阶段产物经 driver 存入 state.artifacts[stage];
 * "当前工作稿"取 polishing→revising→writing 中最新的 draft。
 */
import { z } from "zod"
import type {
  StageHandler,
  StageContext,
  GateDecision,
  GateVerdict,
  WriteStage,
  RunState,
  AbortLike,
} from "../orchestration/pipeline.js"
import { buildSystemPrompt } from "./assemble.js"
import { ROLE_PROMPTS } from "./prompts.js"
import { applySpotFixPatches, extractTaggedBlocks } from "./patches.js"
import { judgeChapter, type JudgeResult } from "../quality/judge.js"
import { detectSlop, slopPenalty } from "../quality/pregate.js"
import { extractStyle } from "../style/extract.js"
import { mergeStyle } from "../style/merge.js"
import { scoreStyleAdherence } from "../style/score.js"
import { StyleProfile } from "../style/profile.js"
import type { LlmClient } from "../llm/client.js"
import type { QualityScore } from "../models/index.js"

// ── 规划阶段的结构化产物 ───────────────────────────────────
// 新字段一律 .default() 向后兼容:旧 RunState 恢复时缺字段不报错,renderPlan 对空值静默跳过。
const ChapterPlan = z.object({
  openingHook: z.string().default(""),
  povCharacter: z.string().optional(),
  beats: z.array(z.string()).default([]),
  emotionArc: z.string().default(""),
  foreshadowPlant: z.array(z.string()).default([]),
  foreshadowPayoff: z.array(z.string()).default([]),
  /** 章尾定格:停在"动作已发、结果未现"的哪个画面(此前章尾钩子完全没人规划) */
  endingHook: z.string().default(""),
  /** 本章禁忌:剧情禁忌 + 至少一条去 AI 句式禁令 */
  mustNotDo: z.array(z.string()).default([]),
})
type ChapterPlanT = z.infer<typeof ChapterPlan>

// ── 字数口径单一事实源 ─────────────────────────────────────
// 旧三套口径互相矛盾(writer 提示词 ±5% / writing 指令 0.75–1.3x / verifying 0.6–1.6x),写手被夹击、
// 超写 56% 也能签发。现在 writing 指令与 verifying 必修触发都用 soft 区间,超出 hard 区间措辞升级为
// "严重偏离";调带宽只改这一行(writer system prompt 的 ±15% 措辞与 soft 对齐)。
const LENGTH_BAND = { soft: [0.85, 1.15], hard: [0.7, 1.4] } as const

// ── polishing 跳过门三态阈值(全干净直通 / warning 轻润 / red 正常润)──
// 旧门只消费 redFlags:deAiTell 达标 + L0 penalty 低 + 无红旗就直通,warning 档(单处禁用句式/
// 对白内命中/密度偏高)无人消费。现在分层闭环:无红旗但 warning 攒到 POLISH_WARN_LIGHT_AT 条,
// 不再直通也不做整章精修——走一次轻量 PATCH 只修点名处(warning 值得顺手修,但绝不值得
// 整章重洗冒事实漂移风险);红旗/分不达标仍走正常 PATCH 润色。
const POLISH_SKIP_DEAITELL_MIN = 90
const POLISH_SKIP_PENALTY_MAX = 8
const POLISH_WARN_LIGHT_AT = 3

// ── 风格指纹软接线(本书嗓音收敛;观察期,不进硬门禁)────────
// ≥3 章已签发成稿才提炼(样本太少指纹噪声大,前几章保持现状空槽);取最近 ≤5 章旧→新逐章
// extractStyle→mergeStyle,EMA 让指纹偏向最新的作者声音。extractStyle 主体是确定性文本统计,
// 仅 POV/母题/descriptor 走一次 fast 模型补全(失败自动降级为确定性默认),逐章重算成本可控;
// 产出的 profile 存 writing.artifacts,verifying 复用同一份做契合度观测——同一把尺,免重复提炼。
const STYLE_SAMPLE_MIN = 3
const STYLE_SAMPLE_MAX = 5
async function deriveStyleProfile(
  samples: readonly string[],
  llm: LlmClient,
  opts: { lang?: "zh" | "en"; bookId?: string },
): Promise<StyleProfile | undefined> {
  const usable = samples.filter((s) => s.trim().length > 0)
  if (usable.length < STYLE_SAMPLE_MIN) return undefined
  let profile: StyleProfile | undefined
  for (const sample of usable.slice(-STYLE_SAMPLE_MAX)) {
    const next = await extractStyle(sample, llm, opts)
    profile = mergeStyle(profile, next, { weightByConfidence: true })
  }
  return profile
}

// ── 读者评审官第二信号(reviewing/verifying 的追读/弃书视角;软接线)──
// judge 是唯一 L1 信号时,"分数过得去但读者会弃书"的章会被静默放行——prompts.ts 里的
// reader-critic 角色提示词一直没人跑。这里接进管线:judge 打分后,只对 overall 落在
// 边缘带 [low, high] 的章用 fast 模型加跑一次。成本取舍(为什么只跑边缘带):
//   · overall < low:judge 已给出明确返修/重写方向,读者票改变不了任何决策,纯烧 token;
//   · overall > high:明显过线直接放行,同理不浪费;
//   · 边缘带才是"工整但可能没人追"的高风险区,读者票在这里才有信息增量。
// 结果只写 artifacts + 判弃书时把弃书点(带「读者评审官:」前缀)追加进 mustFix +
// rationale 带一句,**不改 judge 分数、不动门禁阈值**(与风格契合观测同款软接线哲学)。
const READER_CRITIC_BAND = { low: 70, high: 95 } as const

// 输出契约(与 prompts.ts reader-critic outputContract 同源):维度容错裸数字/字符串分,
// 顶层容错 snake_case,超长字符串截断而非整条 parse 失败——judge 的教训:严格 schema 会让
// "内容齐全但形态略歪"的好评审整份丢掉。彻底缺维度/缺追读票仍判失败,走静默降级。
const ReaderCriticDimension = z.preprocess(
  (v) => (typeof v === "number" || typeof v === "string" ? { score: v, notes: "" } : v),
  z.object({
    score: z.preprocess((v) => {
      const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN
      return Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : v
    }, z.number().int().min(1).max(10)),
    notes: z.preprocess((v) => (typeof v === "string" ? v.slice(0, 240) : ""), z.string()),
  }),
)
const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())
const ReaderCriticOutput = z.preprocess(
  (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v
    const o: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[snakeToCamel(k)] = val
    if (typeof o.wouldContinue === "string") o.wouldContinue = o.wouldContinue.trim().toLowerCase()
    if (typeof o.readerVoice === "string") o.readerVoice = o.readerVoice.slice(0, 320)
    if (Array.isArray(o.painPoints)) {
      o.painPoints = o.painPoints
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        .map((p) => p.slice(0, 240))
        .slice(0, 6)
    }
    return o
  },
  z.object({
    immersion: ReaderCriticDimension, // 沉浸感
    anticipation: ReaderCriticDimension, // 期待感(追读 + 钩子兑现)
    motivation: ReaderCriticDimension, // 人物动机清晰度
    emotional: ReaderCriticDimension, // 情感共鸣
    wouldContinue: z.enum(["next", "maybe", "drop"]), // 最关键的追读票
    readerVoice: z.string().min(1), // 第一人称真实感受
    painPoints: z.array(z.string()).max(6).default([]), // 可执行弃书点,从重到轻
  }),
)

// 极简模板渲染(只支持 {{var}} 与 {{#if var}}…{{/if}},够 reader-critic 用):
// userTemplate 已在 prompts.ts 写死,这里照用而非另写一份,保持提示词单一事实源。
function renderUserTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl
    .replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, k: string, body: string) => ((vars[k] ?? "").trim() ? body : ""))
    .replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

interface ReaderCriticSignal {
  /** 入 artifacts.readerCritic 的完整裁决(含派生 overall/verdict;解析失败时只有 {degraded:true})*/
  readonly verdict: Record<string, unknown>
  /** 判弃书时要追加进门禁 mustFix 的弃书点(已带「读者评审官:」前缀);否则空 */
  readonly mustFix: string[]
  /** 判弃书时给 gate rationale 追加的一句;否则空串 */
  readonly rationale: string
}

async function runReaderCritic(
  llm: LlmClient,
  args: {
    draft: string
    chapterNumber: number
    genreId?: string
    lang?: "zh" | "en"
    chapterGoal?: string
    priorContext?: string
    signal?: AbortLike
  },
): Promise<ReaderCriticSignal> {
  // 角色提示词走 assemble 唯一缝(GENRE_ROLES 含 reader-critic,题材知识一并注入)
  const system = buildSystemPrompt("reader-critic", { genreId: args.genreId, lang: args.lang })
  const tpl = ROLE_PROMPTS["reader-critic"]?.userTemplate
  const user = tpl
    ? renderUserTemplate(tpl, {
        chapterNumber: String(args.chapterNumber),
        chapterContent: args.draft,
        chapterMemo: args.chapterGoal ?? "",
        prevHookSummary: args.priorContext ?? "",
      })
    : `## 第 ${args.chapterNumber} 章正文(请当成一个真读者,完整读一遍再评)\n${args.draft}\n\n严格按系统提示的 JSON 契约返回,只返回那个 JSON,不要任何额外文字。`
  try {
    const res = await llm.generateStructured({
      system,
      messages: [{ role: "user", content: user }],
      temperature: 0.4, // 比判官(0.2)略松:要的是真读者的直觉票,不是复读 rubric
      modelTier: "fast", // 成本意识:第二信号只配快模型,强模型留给判官
      schema: ReaderCriticOutput,
      signal: args.signal,
    })
    const d = res.data
    // 派生由编排层计算(契约规定:不让 LLM 自己算均值算错);overall 保留 1 位小数
    const overall = Math.round(((d.immersion.score + d.anticipation.score + d.motivation.score + d.emotional.score) / 4) * 10) / 10
    const dropping = d.wouldContinue === "drop"
    const mustFix = dropping
      ? (d.painPoints.length ? d.painPoints : [`定位并修复弃书点(读者原话:${d.readerVoice})`]).map((p) => `读者评审官:${p}`)
      : []
    return {
      verdict: { ...d, overall, verdict: overall >= 7 ? "pass" : "needs-revise" },
      mustFix,
      rationale: dropping ? `;读者评审官判弃书(追读票 drop,读者综合 ${overall}/10),弃书点已列入必修` : "",
    }
  } catch (e) {
    // 中断上抛(与 judge 同款:绝不把用户停止吞成降级);其余解析失败/拒答静默降级——
    // 第二信号挂了不阻塞管线,judge 单信号照常走,只在 artifacts 留 degraded 标记可观测。
    if ((e as { name?: string } | undefined)?.name === "AbortError" || args.signal?.aborted) throw e
    return { verdict: { degraded: true }, mustFix: [], rationale: "" }
  }
}

// ── 小工具 ────────────────────────────────────────────────
function pass(): GateDecision {
  return { verdict: "pass", mustFix: [] }
}

function countWords(text: string): number {
  const clean = text.replace(/\s+/g, "")
  const cjk = (clean.match(/[一-鿿]/g) ?? []).length
  if (cjk > clean.length * 0.3) {
    // 主要是中文 → 数"真实内容字":汉字 + 西文字母数字,排除中英文标点
    // (旧版返回 clean.length 把标点也计入,篇幅统计系统性偏高约 10–15%,影响 lengthOff 判定)。
    const alnum = (clean.match(/[A-Za-z0-9]/g) ?? []).length
    return cjk + alnum
  }
  return text.trim().split(/\s+/).filter(Boolean).length // 英文 → 按词
}

function artifact<T = Record<string, unknown>>(state: RunState, stage: WriteStage): T | undefined {
  return state.artifacts[stage] as T | undefined
}

function latestDraft(state: RunState): string {
  const d = (s: WriteStage) => (state.artifacts[s] as { draft?: string } | undefined)?.draft
  return d("polishing") ?? d("revising") ?? d("writing") ?? ""
}

function latestMustFix(state: RunState): string[] {
  const m = (s: WriteStage) => (state.artifacts[s] as { mustFix?: string[] } | undefined)?.mustFix
  return m("verifying") ?? m("reviewing") ?? []
}

function renderPlan(p: ChapterPlanT): string {
  return [
    p.openingHook ? `开篇钩子:${p.openingHook}` : "",
    p.povCharacter ? `POV:${p.povCharacter}` : "",
    p.beats.length ? `场景节拍:\n${p.beats.map((b, i) => `${i + 1}. ${b}`).join("\n")}` : "",
    p.emotionArc ? `情绪曲线:${p.emotionArc}` : "",
    p.foreshadowPlant.length ? `本章埋下:${p.foreshadowPlant.join(";")}` : "",
    p.foreshadowPayoff.length ? `本章回收:${p.foreshadowPayoff.join(";")}` : "",
    p.endingHook ? `章尾定格(必须停在"动作已发、结果未现"):${p.endingHook}` : "",
    p.mustNotDo.length ? `本章禁忌(一条都不许犯):\n${p.mustNotDo.map((m) => `- ${m}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

// 把判官结果折成门禁:达标 pass / 差一点 revise / 崩坏 regenerate
function scoreToGate(r: JudgeResult): GateDecision {
  const t = r.score.passThreshold
  const o = r.score.overall
  const verdict: GateVerdict = o >= t ? "pass" : o >= t - 12 ? "revise" : "regenerate"
  return { verdict, score: r.score, mustFix: r.mustFix, rationale: r.rationale }
}

// ── 工厂 ──────────────────────────────────────────────────
export interface HandlerOptions {
  readonly llm: LlmClient
  /** 过线分(默认 85,与 Book.targetScore 对齐)*/
  readonly passThreshold?: number
  /** 已渲染好的经验回灌块(retrieveLearnings→renderLearnings 产出);注入 planner 系统提示词,闭合 Step 3 学习环 */
  readonly learnings?: string
  /** 读者评审官第二信号开关(默认开):reviewing/verifying 对落在边缘带的 judge 分加跑追读评审 */
  readonly readerCritic?: boolean
}

export function makeHandlers(opts: HandlerOptions): Record<WriteStage, StageHandler> {
  const { llm } = opts
  const passThreshold = opts.passThreshold ?? 85
  const readerCriticOn = opts.readerCritic ?? true

  // judge 之后的第二信号成本闸门:开关开着且 overall 落在边缘带才真跑(取舍见 READER_CRITIC_BAND 注释)
  const maybeReaderCritic = async (ctx: StageContext, r: JudgeResult): Promise<ReaderCriticSignal | undefined> => {
    const o = r.score.overall
    if (!readerCriticOn || o < READER_CRITIC_BAND.low || o > READER_CRITIC_BAND.high) return undefined
    const { input, chapterNumber } = ctx.state
    return runReaderCritic(llm, {
      draft: latestDraft(ctx.state),
      chapterNumber,
      genreId: input.genreId,
      lang: input.lang,
      chapterGoal: input.chapterGoal,
      priorContext: input.priorContext,
      signal: ctx.signal,
    })
  }

  const planning: StageHandler = {
    stage: "planning",
    role: "planner",
    modelTier: "strong",
    async run(ctx) {
      const { input, chapterNumber } = ctx.state
      // 用引擎管线专用规划提示词(输出契约 = ChapterPlan JSON):完整版 planner 要求 YAML+8 节 memo,
      // 与 generateStructured 的 JSON schema 直接矛盾,模型遵从 system 就解析失败 → 蓝图静默降级成一行话。
      const system = buildSystemPrompt("planner-pipeline", { genreId: input.genreId, platformId: input.platformId, lang: input.lang, learnings: opts.learnings })
      const user = [
        input.bookBible ? `设定集:\n${input.bookBible}` : "",
        input.priorContext ? `前情提要:\n${input.priorContext}` : "",
        `本章(第 ${chapterNumber} 章${input.chapterTitle ? `《${input.chapterTitle}》` : ""})目标:${input.chapterGoal ?? "推进主线,写出精彩、有钩子的一章"}`,
        `目标篇幅:约 ${input.targetWordCount} 字。`,
        input.chapterGoal ? "硬要求:蓝图必须忠实落实上面的【本章目标】——目标点名的人物、事件、动作必须成为本章主线;设定集只是背景,不得拿设定集里的情节替换或改写目标指定的这场戏。" : "",
        "请产出本章写作蓝图 JSON:开篇钩子、POV、场景节拍、情绪曲线、本章要埋/要还的伏笔、章尾定格(endingHook)、本章禁忌(mustNotDo,含至少一条去AI句式禁令)。",
      ]
        .filter(Boolean)
        .join("\n\n")
      let data: ChapterPlanT
      let degraded = false
      try {
        const res = await llm.generateStructured({
          system,
          messages: [{ role: "user", content: user }],
          temperature: 0.7,
          modelTier: "strong",
          schema: ChapterPlan,
          signal: ctx.signal,
        })
        data = res.data
      } catch (e) {
        // 中断上抛;其余(模型拒答 / JSON 不可解析)降级为最小蓝图,让 writing 凭目标直接开写,而非整章 error。
        if ((e as { name?: string } | undefined)?.name === "AbortError" || ctx.signal?.aborted) throw e
        degraded = true
        data = ChapterPlan.parse({ beats: input.chapterGoal ? [input.chapterGoal] : [] })
      }
      // 降级不再静默:artifacts 标 planDegraded + rationale 写明,让前端工作流面板看得见"本章蓝图降级"。
      return {
        artifacts: degraded ? { plan: data, planDegraded: true } : { plan: data },
        gate: degraded
          ? { verdict: "pass", mustFix: [], rationale: "蓝图降级:规划产出不可解析,回退为最小蓝图(仅本章目标),写手凭目标直接开写" }
          : pass(),
      }
    },
  }

  const writing: StageHandler = {
    stage: "writing",
    role: "writer",
    modelTier: "strong",
    async run(ctx) {
      const { input, chapterNumber } = ctx.state
      // 过一遍 ChapterPlan 再渲染:旧 RunState 恢复的 plan 可能缺新字段(endingHook/mustNotDo),
      // .default() 在这里兜底;形态彻底不对就当无蓝图,凭目标直接写。
      const rawPlan = artifact<{ plan?: unknown }>(ctx.state, "planning")?.plan
      const parsedPlan = rawPlan ? ChapterPlan.safeParse(rawPlan) : undefined
      const plan = parsedPlan?.success ? parsedPlan.data : undefined
      // 本书嗓音指纹:已有 ≥3 章签发成稿时提炼 StyleProfile,经 assemble.ts 的唯一缝
      // (renderStyleProfile,STYLE_ROLES 含 writer)注入写手提示词;不足 3 章保持现状(空槽)。
      const styleProfile = await deriveStyleProfile(input.styleSamples ?? [], llm, { lang: input.lang, bookId: ctx.state.bookId })
      const system = buildSystemPrompt("writer", { genreId: input.genreId, platformId: input.platformId, lang: input.lang, styleProfile })
      const user = [
        input.bookBible ? `设定:\n${input.bookBible}` : "",
        input.priorContext ? `前情:\n${input.priorContext}` : "",
        input.chapterGoal ? `本章目标(必须落实这场戏):${input.chapterGoal}` : "",
        plan ? `本章蓝图:\n${renderPlan(plan)}` : "",
        `按蓝图写出第 ${chapterNumber} 章正文。篇幅落在 ${Math.round(input.targetWordCount * LENGTH_BAND.soft[0])}–${Math.round(input.targetWordCount * LENGTH_BAND.soft[1])} 字之间(目标 ${input.targetWordCount} 字);写够这场戏就收,不注水、不硬截、更不要大幅超篇(超写既偏离配额又拖慢出稿)。`,
        input.chapterGoal ? "硬要求:必须写出本章目标指定的那场戏——目标点名的人物、事件、动作要在本章真实发生,不得另起炉灶换成别的情节。" : "",
        "只输出正文本身——不要标题、不要大纲、不要任何解释、不要状态标记。",
      ]
        .filter(Boolean)
        .join("\n\n")
      const { text } = await llm.generate({
        system,
        messages: [{ role: "user", content: user }],
        temperature: 0.9,
        modelTier: "strong",
        onToken: ctx.onToken,
        signal: ctx.signal,
        maxOutputTokens: ctx.budget.maxTokens,
      })
      const draft = text.trim()
      // styleProfile 入 artifacts:verifying 复用同一份指纹做契合度观测(不重复提炼)
      return { artifacts: { draft, wordCount: countWords(draft), ...(styleProfile ? { styleProfile } : {}) }, gate: pass() }
    },
  }

  const reviewing: StageHandler = {
    stage: "reviewing",
    role: "quality-reporter",
    modelTier: "strong",
    async run(ctx) {
      const { input } = ctx.state
      const draft = latestDraft(ctx.state)
      const r = await judgeChapter(draft, llm, {
        genreId: input.genreId,
        platformId: input.platformId,
        chapterGoal: input.chapterGoal,
        priorContext: input.priorContext,
        lang: input.lang,
        passThreshold,
        signal: ctx.signal,
      })
      // 第二信号:边缘带加跑读者评审官(verdict 仍由 judge 分折算,只追加弃书必修与 rationale)
      const rc = await maybeReaderCritic(ctx, r)
      const gate = scoreToGate(r)
      const mustFix = rc?.mustFix.length ? [...r.mustFix, ...rc.mustFix] : r.mustFix
      const rationale = r.rationale + (rc?.rationale ?? "")
      return {
        artifacts: {
          score: r.score,
          mustFix,
          rationale,
          l0Flags: r.l0.redFlags,
          ...(rc ? { readerCritic: rc.verdict } : {}),
        },
        gate: { ...gate, mustFix, rationale },
      }
    },
  }

  const revising: StageHandler = {
    stage: "revising",
    role: "reviser",
    modelTier: "strong",
    async run(ctx) {
      const { input } = ctx.state
      const draft = latestDraft(ctx.state)
      const mustFix = latestMustFix(ctx.state)
      if (mustFix.length === 0) {
        // 没有必修项(审稿已 pass)→ 直通,不烧 token
        return { artifacts: { draft, wordCount: countWords(draft), skipped: true }, gate: pass() }
      }
      const system = buildSystemPrompt("reviser", { genreId: input.genreId, platformId: input.platformId, lang: input.lang })
      // 含篇幅类必修项时,放开"保持篇幅"硬约束——否则 verifying 要求扩写/精简、revising 又被命令保持原篇幅,
      // 篇幅永远修不动、白烧返修轮。
      const lengthFix = mustFix.some((m) => /篇幅|扩写|精简|字数/.test(m))
      // 修法分流(与 reviser 角色契约对齐):全是局部文字问题 → PATCHES 定点补丁;
      // 含结构/语义/篇幅级问题或类型拿不准 → REVISED_CONTENT 整章修订(保守侧,等同旧行为)。
      const LOCAL_FIX = /套话|句长|等长|句式|措辞|AI ?味|排比|意象|对话|腔|用词|重复|赘|废话|美文词|节奏/
      const STRUCT_FIX = /人设|OOC|崩|主线|大纲|偏题|结构|逻辑|矛盾|时间线|视角|动机|冲突|爽点|伏笔|拖沓|赶进度|流水账|篇幅|扩写|精简|字数/
      const patchOnly = mustFix.every((m) => LOCAL_FIX.test(m) && !STRUCT_FIX.test(m))
      const user = [
        input.bookBible ? `设定(修复不得与之矛盾):\n${input.bookBible}` : "",
        input.priorContext ? `前情:\n${input.priorContext}` : "",
        input.chapterGoal ? `本章目标:${input.chapterGoal}` : "",
        `原稿:\n${draft}`,
        lengthFix
          ? `必须修复(定向改这些,保持情节人物不变;含篇幅项时按要求把篇幅调到接近目标):\n- ${mustFix.join("\n- ")}`
          : `必须修复(只针对这些定向改,别动其它部分,保持情节与篇幅):\n- ${mustFix.join("\n- ")}`,
        patchOnly
          ? "本轮修法分流:patch-only——清单全部是局部文字问题。按区块输出 `=== FIXED_ISSUES ===`(逐条交代修了什么)与 `=== PATCHES ===`(定点补丁,TARGET_TEXT 必须逐字摘原稿、能唯一命中);不要 REVISED_CONTENT,补丁之外的字一个不动。"
          : "本轮修法分流:rewrite-only——清单含结构/语义级问题。按区块输出 `=== FIXED_ISSUES ===` 与 `=== REVISED_CONTENT ===`(修订后的完整正文);不要 PATCHES。",
        "所有修改不得与上面的设定与前情冲突,不得引入新人物、新设定。不要解释。",
      ]
        .filter(Boolean)
        .join("\n\n")
      // 不接 onToken:区块化产出(FIXED_ISSUES/PATCHES/UPDATED_*)直接流给前端会把内部标记漏到正文画布。
      const { text } = await llm.generate({
        system,
        messages: [{ role: "user", content: user }],
        temperature: 0.8,
        modelTier: "strong",
        signal: ctx.signal,
      })
      // 解析区块剥壳:只让正文相关部分入库(FIXED_ISSUES/UPDATED_STATE 等绝不混进 draft)。
      const raw = text.trim()
      const blocks = extractTaggedBlocks(raw)
      const hasBlocks = Object.keys(blocks).length > 0
      const revisedBlock = (blocks["REVISED_CONTENT"] ?? "").trim()
      const patchBlock = blocks["PATCHES"] ?? (!hasBlocks && /---\s*PATCH(?:\s*\d+)?\s*---/.test(raw) ? raw : "")
      const fixedIssues = (blocks["FIXED_ISSUES"] ?? "").split("\n").map((s) => s.trim()).filter(Boolean)
      let revised = draft
      let patchStats: Record<string, unknown> = {}
      if (revisedBlock) {
        revised = revisedBlock
      } else if (patchBlock.trim()) {
        const out = applySpotFixPatches(draft, patchBlock)
        revised = out.text
        patchStats = {
          appliedPatchCount: out.appliedCount,
          skippedPatchCount: out.skippedCount,
          // 补丁全失配 → 回退原稿并标记,绝不把补丁文本当 draft
          ...(out.totalCount > 0 && out.appliedCount === 0 ? { patchFallback: true } : {}),
        }
      } else if (!hasBlocks) {
        revised = raw // 模型未按区块输出(旧契约直接给正文)→ 整段视为修订正文
      } else {
        patchStats = { patchFallback: true } // 区块齐全但既无补丁也无重写 → 本轮未修,保留原稿
      }
      return {
        artifacts: {
          draft: revised,
          wordCount: countWords(revised),
          ...(fixedIssues.length ? { fixedIssues } : {}),
          ...patchStats,
        },
        gate: pass(),
      }
    },
  }

  const polishing: StageHandler = {
    stage: "polishing",
    role: "polisher",
    modelTier: "fast",
    async run(ctx) {
      const { input, chapterNumber } = ctx.state
      const draft = latestDraft(ctx.state)
      // 确定性跳过门(零 LLM 成本,与 revising"无必修项直通"同构):reviewing 已认定干净且 L0 无信号的章,
      // 不再被 fast 模型重洗一遍——整章重洗是管线里事实漂移风险最高的一步,纯增退化风险。
      // warning 分层:无红旗但警告攒到 POLISH_WARN_LIGHT_AT 条 → 不直通,降级走轻量 PATCH 只修点名处。
      const reviewScore = artifact<{ score?: QualityScore }>(ctx.state, "reviewing")?.score
      const l0 = detectSlop(draft)
      const warnings = l0.warnings ?? []
      const cleanByJudge = (reviewScore?.dimensions.deAiTell ?? 0) >= POLISH_SKIP_DEAITELL_MIN && l0.redFlags.length === 0
      if (cleanByJudge && slopPenalty(l0) <= POLISH_SKIP_PENALTY_MAX && warnings.length < POLISH_WARN_LIGHT_AT) {
        return { artifacts: { draft, wordCount: countWords(draft), skipped: true }, gate: pass() }
      }
      const lightPatchOnly = cleanByJudge && warnings.length >= POLISH_WARN_LIGHT_AT
      const system = buildSystemPrompt("polisher", { genreId: input.genreId, platformId: input.platformId, lang: input.lang })
      // user 指令与 polisher 角色契约对齐(PATCH 模式):旧版命令"输出完整正文"与 system 的
      // "绝对禁止输出整章"直接矛盾,模型遵从 system 时补丁文本被当 draft 入库、判官对补丁块打分。
      // warning 档与红旗同构渲染成定点打击清单(含 L0 摘出的原句片段),但措辞降级为"顺手修"。
      const user = [
        `待润色章节(第 ${chapterNumber} 章)原文:\n${draft}`,
        l0.redFlags.length ? `L0 确定性检测命中,优先定点处理这些问题:\n- ${l0.redFlags.join("\n- ")}` : "",
        warnings.length ? `L0 警告档定点打击目标(警告档:顺手修,无需大动):\n- ${warnings.join("\n- ")}` : "",
        lightPatchOnly
          ? "请按 PATCH 模式做轻量定点润色:只输出定点补丁(首行 `=== PATCHES ===`,每条 `--- PATCH n ---` / TARGET_TEXT / REPLACEMENT_TEXT / `--- END PATCH ---`),1-6 条;TARGET_TEXT 必须逐字摘原文、能唯一命中。只修上面警告档点名处,点名之外一个字都不要动;不改情节、不改人物、不动事实;绝不返回整章正文、不要 JSON、不要解释。点名处确实无需改就只输出 `=== PATCHES ===`,不要凑数硬改。"
          : "请按 PATCH 模式做文字层精修:只输出定点补丁(首行 `=== PATCHES ===`,每条 `--- PATCH n ---` / TARGET_TEXT / REPLACEMENT_TEXT / `--- END PATCH ---`),3-15 条;TARGET_TEXT 必须逐字摘原文、能唯一命中。重点:句长长短交错(破除均匀节奏)、删套话与空洞美文词、清禁用句式。不改情节、不改人物、不动事实;绝不返回整章正文、不要 JSON、不要解释。整章确实够好就只输出 `=== PATCHES ===`,不要凑数硬改。",
      ]
        .filter(Boolean)
        .join("\n\n")
      // 不接 onToken:补丁文本直接流给前端会把内部标记漏到正文画布。
      const { text } = await llm.generate({
        system,
        messages: [{ role: "user", content: user }],
        temperature: 0.8,
        modelTier: "fast",
        signal: ctx.signal,
      })
      const raw = text.trim()
      const out = applySpotFixPatches(draft, raw)
      if (out.totalCount > 0 || out.sawPatchMarker) {
        // PATCH 契约产出:应用补丁得全文;补丁全失配 → 回退原稿并标记,绝不把补丁文本当 draft。
        const polished = out.appliedCount > 0 ? out.text : draft
        return {
          artifacts: {
            draft: polished,
            wordCount: countWords(polished),
            appliedPatchCount: out.appliedCount,
            skippedPatchCount: out.skippedCount,
            ...(lightPatchOnly ? { lightPatch: true } : {}),
            ...(out.totalCount > 0 && out.appliedCount === 0 ? { patchFallback: true } : {}),
            ...(out.notes.length ? { polisherNotes: out.notes } : {}),
          },
          gate: pass(),
        }
      }
      // 模型违约没走 PATCH 契约:像整章正文才接受(降级为旧行为),否则回退原稿——绝不把元说明当正文。
      const fellBackToRewrite = raw.length >= draft.length * 0.5 && !raw.startsWith("===")
      const polished = fellBackToRewrite ? raw : draft
      return {
        artifacts: {
          draft: polished,
          wordCount: countWords(polished),
          ...(lightPatchOnly ? { lightPatch: true } : {}),
          ...(fellBackToRewrite ? { fellBackToRewrite: true } : { patchFallback: true }),
        },
        gate: pass(),
      }
    },
  }

  const verifying: StageHandler = {
    stage: "verifying",
    role: "editor-in-chief",
    modelTier: "strong",
    async run(ctx) {
      const { input } = ctx.state
      const draft = latestDraft(ctx.state)
      const r = await judgeChapter(draft, llm, {
        genreId: input.genreId,
        platformId: input.platformId,
        chapterGoal: input.chapterGoal,
        priorContext: input.priorContext,
        lang: input.lang,
        passThreshold,
        signal: ctx.signal,
      })
      // 篇幅终检(length-governor 职责并入):与 writing 指令共用 LENGTH_BAND 单一口径,
      // 出 soft 区间即触发必修,出 hard 区间措辞升级为"严重偏离"。
      const wc = countWords(draft)
      const target = input.targetWordCount
      const lengthOff = target > 0 && (wc < target * LENGTH_BAND.soft[0] || wc > target * LENGTH_BAND.soft[1])
      const lengthSevere = target > 0 && (wc < target * LENGTH_BAND.hard[0] || wc > target * LENGTH_BAND.hard[1])
      const mustFixBase = lengthOff
        ? [
            ...r.mustFix,
            `篇幅${lengthSevere ? "严重偏离" : "偏离"}目标(${wc}/${target} 字,应落在 ${Math.round(target * LENGTH_BAND.soft[0])}–${Math.round(target * LENGTH_BAND.soft[1])} 字),${wc < target ? "扩写" : "精简"}至接近目标`,
          ]
        : r.mustFix
      // 第二信号:终审也对边缘带加跑读者评审官——弃书点追加进终审必修(verdict 仍只看 judge 分 + 篇幅)
      const rc = await maybeReaderCritic(ctx, r)
      const mustFix = rc?.mustFix.length ? [...mustFixBase, ...rc.mustFix] : mustFixBase
      // 风格契合观测(软接线):对 draft 与 writing 留下的同一份指纹算契合度(纯确定性,零 LLM)。
      // 只写 artifacts + rationale 带一句,**不改 verdict、不混入门禁 mustFix**——先收集数据,
      // 观察期过后再决定是否升级为硬门禁。
      const rawProfile = artifact<{ styleProfile?: unknown }>(ctx.state, "writing")?.styleProfile
      const styleTarget = rawProfile ? StyleProfile.safeParse(rawProfile) : undefined
      const styleReport = styleTarget?.success ? scoreStyleAdherence(draft, styleTarget.data, { lang: input.lang }) : undefined
      const verdict: GateVerdict = r.score.overall >= r.score.passThreshold && !lengthOff ? "pass" : "revise"
      const rationale =
        r.rationale +
        (lengthOff ? `;篇幅 ${wc}/${target}` : "") +
        (styleReport ? `;风格契合 ${styleReport.score}/100(观察期,不计入门禁)` : "") +
        (rc?.rationale ?? "")
      return {
        artifacts: {
          score: r.score,
          mustFix,
          rationale,
          wordCount: wc,
          ...(rc ? { readerCritic: rc.verdict } : {}),
          ...(styleReport
            ? { styleAdherence: { score: styleReport.score, perDimension: styleReport.perDimension, deviations: styleReport.drift, mustFix: styleReport.mustFix } }
            : {}),
        },
        gate: { verdict, score: r.score, mustFix, rationale },
      }
    },
  }

  const publishing: StageHandler = {
    stage: "publishing",
    role: "managing-editor",
    modelTier: "fast",
    async run(ctx) {
      const { input, chapterNumber } = ctx.state
      const draft = latestDraft(ctx.state)
      const finalScore = artifact<{ score: QualityScore }>(ctx.state, "verifying")?.score
      const chapter = {
        number: chapterNumber,
        title: input.chapterTitle ?? `第 ${chapterNumber} 章`,
        content: draft,
        wordCount: countWords(draft),
        quality: finalScore,
      }
      return { artifacts: { chapter }, gate: pass() }
    },
  }

  return { planning, writing, reviewing, revising, polishing, verifying, publishing }
}
