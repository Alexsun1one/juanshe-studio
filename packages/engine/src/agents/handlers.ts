/**
 * 卷舍 · 阶段处理器(把状态机各阶段真正实现出来)
 *
 * makeHandlers(llm) 返回 7 个阶段的 StageHandler;注入 LlmClient,因此可单测、可换底座。
 * 每个阶段做的事:
 *   planning  规划师 → 结构化写作蓝图(节拍/情绪/伏笔/钩子)
 *   writing   写手   → 按蓝图流式写正文(组装提示词时已注入去AI味 + 题材/平台知识)
 *   reviewing 质检   → judgeChapter(L0+L1 联防)产出门禁(pass/revise/regenerate)
 *   revising  修订   → 按 mustFix 定向改稿(无必修项直通;局部问题走 PATCH 补丁、结构问题走整章修订)
 *   polishing 润色   → 文字层 humanize,PATCH 定点补丁模式(已干净且 L0 无信号的章直通,不重洗)
 *   verifying 终审   → 再判一次 + 篇幅终检,可回退返修(由 nextStage 计返修轮次)
 *   publishing 签发  → 确定性组装章节对象(无 LLM)
 *
 * 数据流:不可变种子在 state.input;各阶段产物经 driver 存入 state.artifacts[stage];
 * "当前工作稿"取 polishing→revising→writing 中最新的 draft。
 */
import { z } from "zod"
import type {
  StageHandler,
  GateDecision,
  GateVerdict,
  WriteStage,
  RunState,
} from "../orchestration/pipeline.js"
import { buildSystemPrompt } from "./assemble.js"
import { applySpotFixPatches, extractTaggedBlocks } from "./patches.js"
import { judgeChapter, type JudgeResult } from "../quality/judge.js"
import { detectSlop, slopPenalty } from "../quality/pregate.js"
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
}

export function makeHandlers(opts: HandlerOptions): Record<WriteStage, StageHandler> {
  const { llm } = opts
  const passThreshold = opts.passThreshold ?? 85

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
      const system = buildSystemPrompt("writer", { genreId: input.genreId, platformId: input.platformId, lang: input.lang })
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
      return { artifacts: { draft, wordCount: countWords(draft) }, gate: pass() }
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
      return {
        artifacts: { score: r.score, mustFix: r.mustFix, rationale: r.rationale, l0Flags: r.l0.redFlags },
        gate: scoreToGate(r),
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
      const reviewScore = artifact<{ score?: QualityScore }>(ctx.state, "reviewing")?.score
      const l0 = detectSlop(draft)
      if ((reviewScore?.dimensions.deAiTell ?? 0) >= 90 && slopPenalty(l0) <= 8 && l0.redFlags.length === 0) {
        return { artifacts: { draft, wordCount: countWords(draft), skipped: true }, gate: pass() }
      }
      const system = buildSystemPrompt("polisher", { genreId: input.genreId, platformId: input.platformId, lang: input.lang })
      // user 指令与 polisher 角色契约对齐(PATCH 模式):旧版命令"输出完整正文"与 system 的
      // "绝对禁止输出整章"直接矛盾,模型遵从 system 时补丁文本被当 draft 入库、判官对补丁块打分。
      const user = [
        `待润色章节(第 ${chapterNumber} 章)原文:\n${draft}`,
        l0.redFlags.length ? `L0 确定性检测命中,优先定点处理这些问题:\n- ${l0.redFlags.join("\n- ")}` : "",
        "请按 PATCH 模式做文字层精修:只输出定点补丁(首行 `=== PATCHES ===`,每条 `--- PATCH n ---` / TARGET_TEXT / REPLACEMENT_TEXT / `--- END PATCH ---`),3-15 条;TARGET_TEXT 必须逐字摘原文、能唯一命中。重点:句长长短交错(破除均匀节奏)、删套话与空洞美文词、清禁用句式。不改情节、不改人物、不动事实;绝不返回整章正文、不要 JSON、不要解释。整章确实够好就只输出 `=== PATCHES ===`,不要凑数硬改。",
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
      const mustFix = lengthOff
        ? [
            ...r.mustFix,
            `篇幅${lengthSevere ? "严重偏离" : "偏离"}目标(${wc}/${target} 字,应落在 ${Math.round(target * LENGTH_BAND.soft[0])}–${Math.round(target * LENGTH_BAND.soft[1])} 字),${wc < target ? "扩写" : "精简"}至接近目标`,
          ]
        : r.mustFix
      const verdict: GateVerdict = r.score.overall >= r.score.passThreshold && !lengthOff ? "pass" : "revise"
      const rationale = r.rationale + (lengthOff ? `;篇幅 ${wc}/${target}` : "")
      return {
        artifacts: { score: r.score, mustFix, rationale, wordCount: wc },
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
