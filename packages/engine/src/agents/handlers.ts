/**
 * 卷舍 · 阶段处理器(把状态机各阶段真正实现出来)
 *
 * makeHandlers(llm) 返回 7 个阶段的 StageHandler;注入 LlmClient,因此可单测、可换底座。
 * 每个阶段做的事:
 *   planning  规划师 → 结构化写作蓝图(节拍/情绪/伏笔/钩子)
 *   writing   写手   → 按蓝图流式写正文(组装提示词时已注入去AI味 + 题材/平台知识)
 *   reviewing 质检   → judgeChapter(L0+L1 联防)产出门禁(pass/revise/regenerate)
 *   revising  修订   → 按 mustFix 定向改稿(无必修项则直通,不烧 token)
 *   polishing 润色   → 文字层 humanize(破句长均匀、删套话)
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
import { judgeChapter, type JudgeResult } from "../quality/judge.js"
import type { LlmClient } from "../llm/client.js"
import type { QualityScore } from "../models/index.js"

// ── 规划阶段的结构化产物 ───────────────────────────────────
const ChapterPlan = z.object({
  openingHook: z.string().default(""),
  povCharacter: z.string().optional(),
  beats: z.array(z.string()).default([]),
  emotionArc: z.string().default(""),
  foreshadowPlant: z.array(z.string()).default([]),
  foreshadowPayoff: z.array(z.string()).default([]),
})
type ChapterPlanT = z.infer<typeof ChapterPlan>

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
      const system = buildSystemPrompt("planner", { genreId: input.genreId, platformId: input.platformId, lang: input.lang, learnings: opts.learnings })
      const user = [
        input.bookBible ? `设定集:\n${input.bookBible}` : "",
        input.priorContext ? `前情提要:\n${input.priorContext}` : "",
        `本章(第 ${chapterNumber} 章${input.chapterTitle ? `《${input.chapterTitle}》` : ""})目标:${input.chapterGoal ?? "推进主线,写出精彩、有钩子的一章"}`,
        `目标篇幅:约 ${input.targetWordCount} 字。`,
        input.chapterGoal ? "硬要求:蓝图必须忠实落实上面的【本章目标】——目标点名的人物、事件、动作必须成为本章主线;设定集只是背景,不得拿设定集里的情节替换或改写目标指定的这场戏。" : "",
        "请产出本章写作蓝图:开篇钩子、POV、场景节拍、情绪曲线、本章要埋/要还的伏笔。",
      ]
        .filter(Boolean)
        .join("\n\n")
      let data: ChapterPlanT
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
        data = ChapterPlan.parse({ beats: input.chapterGoal ? [input.chapterGoal] : [] })
      }
      return { artifacts: { plan: data }, gate: pass() }
    },
  }

  const writing: StageHandler = {
    stage: "writing",
    role: "writer",
    modelTier: "strong",
    async run(ctx) {
      const { input, chapterNumber } = ctx.state
      const plan = artifact<{ plan: ChapterPlanT }>(ctx.state, "planning")?.plan
      const system = buildSystemPrompt("writer", { genreId: input.genreId, platformId: input.platformId, lang: input.lang })
      const user = [
        input.bookBible ? `设定:\n${input.bookBible}` : "",
        input.priorContext ? `前情:\n${input.priorContext}` : "",
        input.chapterGoal ? `本章目标(必须落实这场戏):${input.chapterGoal}` : "",
        plan ? `本章蓝图:\n${renderPlan(plan)}` : "",
        `按蓝图写出第 ${chapterNumber} 章正文。篇幅贴近 ${input.targetWordCount} 字(约 ${Math.round(input.targetWordCount * 0.75)}–${Math.round(input.targetWordCount * 1.3)} 字之间);写够这场戏就收,不注水、不硬截、更不要大幅超篇(超写既偏离配额又拖慢出稿)。`,
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
      const user = [
        `原稿:\n${draft}`,
        lengthFix
          ? `必须修复(定向改这些,保持情节人物不变;含篇幅项时按要求把篇幅调到接近目标):\n- ${mustFix.join("\n- ")}`
          : `必须修复(只针对这些定向改,别动其它部分,保持情节与篇幅):\n- ${mustFix.join("\n- ")}`,
        "只输出修订后的完整正文,不要解释。",
      ].join("\n\n")
      const { text } = await llm.generate({
        system,
        messages: [{ role: "user", content: user }],
        temperature: 0.8,
        modelTier: "strong",
        onToken: ctx.onToken,
        signal: ctx.signal,
      })
      const revised = text.trim()
      return { artifacts: { draft: revised, wordCount: countWords(revised) }, gate: pass() }
    },
  }

  const polishing: StageHandler = {
    stage: "polishing",
    role: "polisher",
    modelTier: "fast",
    async run(ctx) {
      const { input } = ctx.state
      const draft = latestDraft(ctx.state)
      const system = buildSystemPrompt("polisher", { genreId: input.genreId, platformId: input.platformId, lang: input.lang })
      const user = [
        "对下面这章做文字层精修:句子长短交错(破除均匀节奏)、删套话与空洞美文词、humanize 到像真人随手写的。",
        "不改情节、不改人物、不显著改变篇幅。只输出精修后的完整正文。",
        `\n${draft}`,
      ].join("\n\n")
      const { text } = await llm.generate({
        system,
        messages: [{ role: "user", content: user }],
        temperature: 0.8,
        modelTier: "fast",
        onToken: ctx.onToken,
        signal: ctx.signal,
      })
      const polished = text.trim()
      return { artifacts: { draft: polished, wordCount: countWords(polished) }, gate: pass() }
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
      // 篇幅终检(length-governor 职责并入)
      const wc = countWords(draft)
      const target = input.targetWordCount
      const lengthOff = target > 0 && (wc < target * 0.6 || wc > target * 1.6)
      const mustFix = lengthOff
        ? [...r.mustFix, `篇幅明显偏离目标(${wc}/${target} 字),${wc < target ? "扩写" : "精简"}至接近目标`]
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
