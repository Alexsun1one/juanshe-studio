/**
 * 卷舍 · 质量 L1 判官(锚定式 LLM-as-judge,与 L0 检测器联防)
 *
 * 设计依据(EQ-Bench / G-Eval 综合):LLM 当裁判最大问题是"手松 + 漂移"。
 * 对策:① 锚定式 rubric(把 90/75/60/<60 各档长什么样写死,逼判官据此校准);
 *       ② 低温 + 结构化输出(稳);③ L0 否决——确定性机检到的机械 AI 味,直接给 deAiTell 设硬上限,
 *          判官想给高分也压不上去(防"读着挺顺就放水")。
 *
 * 五维加权综合:文笔 0.25 / 去AI味 0.20 / 情感 0.20 / 一致性 0.20 / 节奏 0.15
 * (去AI味与文笔、情感占大头——贴合"像真人写的、好看、有张力"的产品价值)。
 */
import { z } from "zod"
import type { QualityScore } from "../models/index.js"
import { detectSlop, slopPenalty, type SlopSignals } from "./pregate.js"
import type { LlmClient } from "../llm/client.js"
import type { AbortLike } from "../orchestration/pipeline.js"

const WEIGHTS = { consistency: 0.2, pacing: 0.15, emotion: 0.2, prose: 0.25, deAiTell: 0.2 } as const

// 把任意一种"维度"返回形态归一成 {score,note}:裸数字 / 字符串数字 / {score|rating|value|评分|得分|分数: N} /
// 对象里任一个 1–100 的数字;note 从 note|reason|理由|依据|说明|评语 等键里挖。
// 不同模型(尤其 DeepSeek 无原生结构化输出,走提示词抽 JSON)对维度的键名/嵌套各不相同——旧严格 schema 会让
// reviewing 阶段直接崩,过窄的归一又会把真分丢成默认值(实测先后踩到这两种)。这里一律兜住:judge 永不因
// 维度形态而失败或无谓丢分。
function asFiniteNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN
  return Number.isFinite(n) ? n : null
}
function clampScore(n: number): number {
  return Math.max(0, Math.min(100, n))
}
function toScore(v: unknown): number {
  const direct = asFiniteNum(v)
  if (direct != null) return clampScore(direct)
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    for (const k of ["score", "rating", "value", "评分", "得分", "分数", "分"]) {
      const n = asFiniteNum(o[k])
      if (n != null) return clampScore(n)
    }
    for (const val of Object.values(o)) {
      const n = asFiniteNum(val)
      if (n != null && n >= 1 && n <= 100) return clampScore(n) // 末路兜底:跳过 0–1 置信度,取首个像分数的数
    }
  }
  return 60
}
function toNote(v: unknown): string {
  if (v && typeof v === "object") {
    for (const k of ["note", "reason", "理由", "依据", "说明", "评语"]) {
      const s = (v as Record<string, unknown>)[k]
      if (typeof s === "string") return s
    }
  }
  return ""
}
const Dim = z.preprocess(
  (v) => ({ score: toScore(v), note: toNote(v) }),
  z.object({ score: z.number().min(0).max(100), note: z.string().default("") }),
)
// mustFix 同样兜形态:模型常把"可执行修改"返成单串 / [{point|fix|建议:...}] / 混合数组——
// 旧严格 array<string> 会让"5 维分齐全但 mustFix 形态怪"的一份好稿被整条 parse 失败、降级成假分(与维度同类坑)。
const MustFix = z
  .preprocess((v) => {
    const pick = (x: unknown): string => {
      if (typeof x === "string") return x.trim()
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>
        return (toNote(o) || String(o.point ?? o.fix ?? o.建议 ?? o.item ?? o.text ?? o.content ?? "")).trim()
      }
      return x == null ? "" : String(x).trim()
    }
    if (Array.isArray(v)) return v.map(pick).filter((s) => s.length > 0)
    if (typeof v === "string") return v.trim() ? [v.trim()] : []
    if (v && typeof v === "object") {
      const s = pick(v)
      return s ? [s] : []
    }
    return []
  }, z.array(z.string()))
  .default([])

const DIM_KEYS = ["consistency", "pacing", "emotion", "prose", "deAiTell"] as const
// 模型偶尔把整份评分包一层(如 {scores:{...}} / {result:{...}} / {评分:{...}}):顶层没有维度键时,
// 下沉到第一个含维度键的子对象,避免五维静默全塌成默认分(实测真踩到一次全 60)。
function unwrapJudge(v: unknown): unknown {
  if (!v || typeof v !== "object") return v
  const o = v as Record<string, unknown>
  if (DIM_KEYS.some((k) => k in o)) return o
  for (const k of ["scores", "score", "result", "data", "评分", "ratings", "dimensions", "维度"]) {
    const c = o[k]
    if (c && typeof c === "object" && DIM_KEYS.some((dk) => dk in (c as Record<string, unknown>))) return c
  }
  for (const val of Object.values(o)) {
    if (val && typeof val === "object" && DIM_KEYS.some((dk) => dk in (val as Record<string, unknown>))) return val
  }
  return o
}

const JudgeShape = z.object({
  consistency: Dim,
  pacing: Dim,
  emotion: Dim,
  prose: Dim,
  deAiTell: Dim,
  /** 最关键的可执行修改建议(具体到问题,1–5 条) */
  mustFix: MustFix,
})
export const JudgeOutput = z.preprocess(unwrapJudge, JudgeShape)
export type JudgeOutput = z.infer<typeof JudgeShape>

export interface JudgeContext {
  readonly genreId?: string
  readonly platformId?: string
  readonly chapterGoal?: string
  readonly priorContext?: string
  readonly lang?: "zh" | "en"
  readonly passThreshold?: number
  /** 中断信号:用户点"停止"后,reviewing/verifying 不再把强模型判官跑到底空烧 token */
  readonly signal?: AbortLike
}

export interface JudgeResult {
  readonly score: QualityScore
  readonly mustFix: string[]
  readonly l0: SlopSignals
  readonly rationale: string
}

const RUBRIC_ZH = `你是卷舍编辑部的终审判官,只认稿子质量,不讲情面、不放水。
对给定章节按 5 个维度各打 0–100 分,每维度给一句**具体**依据(指出原文问题,不要泛泛)。

档位锚点(必须据此校准):
· 90–100:职业作家水准,可直接签发。
· 75–89:达标,仅少量可改。
· 60–74:能读,但明显业余或有 AI 腔,需返修。
· 0–59:崩坏(逻辑断裂 / 出戏 / 通篇套话 / 偏题),需重写。

五个维度:
1) consistency 一致性:人物、设定、前情有无矛盾;本章是否完成既定目标。
2) pacing 节奏:有无拖沓或赶进度;场景切换是否顺滑。
3) emotion 情感:情绪是否可信、有张力;还是悬浮的形容词堆砌。
4) prose 文笔:画面感、对白、细节是否具体可感;有无废话。
5) deAiTell 去AI味:句长是否长短交错(均匀等长=破绽);有无套话、空洞美文词、解释/总结/报告腔。读着像 AI 写的,此项必须低分。

mustFix:列出最关键的 1–5 条**可执行**修改(具体到段落/问题,能照着改)。
只输出符合 schema 的 JSON,不要任何额外文字。`

const RUBRIC_EN = `You are the final quality judge of the Juanshe editorial office. Be strict; never inflate.
Score the chapter on 5 dimensions (0–100 each) with one concrete reason each (cite the actual problem).

Anchors:
· 90–100: professional author level, ship as is.
· 75–89: passes, minor fixes only.
· 60–74: readable but amateur or AI-flavored, needs revision.
· 0–59: broken (logic breaks / out of character / wall-to-wall cliché / off-brief), rewrite.

Dimensions: consistency, pacing, emotion, prose, deAiTell (uniform sentence length / filler / purple words / explainer tone => low).
mustFix: 1–5 concrete, actionable fixes. Output JSON matching the schema only.`

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.filter((s) => s && s.trim().length > 0))]
}

/** 对一章正文做 L0+L1 联合质检,返回综合质量分 + 必修项 */
export async function judgeChapter(text: string, llm: LlmClient, ctx: JudgeContext = {}): Promise<JudgeResult> {
  const lang = ctx.lang ?? "zh"
  // ① L0 确定性机检(零成本)
  const l0 = detectSlop(text)
  const pen = slopPenalty(l0) // 0–100,越高越 AI
  const redFlags = l0.redFlags.length
    ? `【L0 确定性检测发现的 AI 味信号,务必采信、不得无视】\n- ${l0.redFlags.join("\n- ")}`
    : "【L0 未发现明显机械 AI 味,但仍需你独立判断】"

  // ② L1 判官(锚定 rubric + 低温 + 结构化)
  const user = [
    ctx.genreId ? `题材:${ctx.genreId}` : "",
    ctx.platformId ? `平台:${ctx.platformId}` : "",
    ctx.chapterGoal ? `本章应完成:${ctx.chapterGoal}` : "",
    ctx.priorContext ? `前情提要:${ctx.priorContext}` : "",
    redFlags,
    `\n===== 待评章节正文 =====\n${text}`,
  ].filter(Boolean).join("\n")

  let data: JudgeOutput
  let degraded = false
  try {
    const res = await llm.generateStructured({
      system: lang === "en" ? RUBRIC_EN : RUBRIC_ZH,
      messages: [{ role: "user", content: user }],
      temperature: 0.2,
      modelTier: "strong", // 判官必须用强模型,稳
      schema: JudgeOutput,
      signal: ctx.signal,
    })
    data = res.data
  } catch (e) {
    // 中断必须上抛(让 driver 走 aborted),绝不能被降级吞成"假装过线"
    if ((e as { name?: string } | undefined)?.name === "AbortError" || ctx.signal?.aborted) throw e
    // 判官降级:模型没返回可解析的结构化评分(形态太怪 / 拒答)。不让它崩掉整章——
    // 回退到"以 L0 机检为准 + 中性偏保守分 + 标记人工复核",让流水线能继续而非整章 error。
    degraded = true
    const base = Math.max(0, 100 - pen)
    data = {
      consistency: { score: 70, note: "判官降级:未获结构化终审" },
      pacing: { score: 70, note: "" },
      emotion: { score: 70, note: "" },
      prose: { score: 72, note: "" },
      deAiTell: { score: base, note: "以 L0 机检为准" },
      mustFix: ["判官终审降级(模型未返回可解析评分),建议人工复核本章质量"],
    }
  }

  // ③ L0 否决:机检到的机械 AI 味,给 deAiTell 设硬上限(判官压不上去)
  const deAiCapped = Math.min(data.deAiTell.score, 100 - pen)
  const dimensions = {
    consistency: data.consistency.score,
    pacing: data.pacing.score,
    emotion: data.emotion.score,
    prose: data.prose.score,
    deAiTell: deAiCapped,
  }
  const overall = Math.round(
    dimensions.consistency * WEIGHTS.consistency +
      dimensions.pacing * WEIGHTS.pacing +
      dimensions.emotion * WEIGHTS.emotion +
      dimensions.prose * WEIGHTS.prose +
      dimensions.deAiTell * WEIGHTS.deAiTell,
  )
  const passThreshold = ctx.passThreshold ?? 85
  const score: QualityScore = { overall, dimensions, passThreshold }

  const mustFix = dedupe([
    ...data.mustFix,
    ...(deAiCapped < data.deAiTell.score ? ["句长过于均匀 / 套话过多:按去AI味戒律重写句子节奏(长短交错、删空洞美文词)"] : []),
  ])
  const rationale =
    (degraded ? "[判官降级·以 L0 为准] " : "") +
    `综合 ${overall}(一致${dimensions.consistency}/节奏${dimensions.pacing}/情感${dimensions.emotion}/文笔${dimensions.prose}/去AI${dimensions.deAiTell})` +
    (data.prose.note || data.deAiTell.note ? `;${[data.prose.note, data.deAiTell.note].filter(Boolean).join(" ")}` : "")

  return { score, mustFix, l0, rationale }
}
