/**
 * 卷舍 · 质量 L0 零成本预门禁 / AI 味检测器(纯 TS,零 LLM 成本)
 *
 * 在烧 judge token 之前先做确定性机检,踩红线的稿子直接打回返修。
 * 复用 anti-slop 词表 + 句长 burstiness(humanize-chinese 在 HC3-Chinese 上验证的最强信号)。
 *
 * 方法学综合自公开研究(humanize-chinese N-gram困惑度 / EQ-Bench slop / 检测器 perplexity-burstiness),
 * 实现为本项目原创纯函数,可单测。
 */
import { CN_SLOP_WORDS, CN_FILLER_PHRASES, CN_TELLING_EMOTION, EN_TELLING_EMOTION } from "../agents/anti-slop.js"
import { sentenceLengths, coefficientOfVariation } from "./text-metrics.js"

export interface SlopSignals {
  /** 句长变异系数 CV(stddev/mean):越低越像 AI;真人通常 > 0.5 */
  burstiness: number
  /** 句长过于均匀(大量 15–25 字等长句)= 最强 AI 信号 */
  uniformSentences: boolean
  /** 空洞美文词命中数 / 句子数 */
  slopDensity: number
  /** 套话/机械连接词命中次数 */
  fillerHits: number
  /** 重复 4-gram 占比(自我复读 / 模板感) */
  repetitionRatio: number
  /** 直接命名情绪(telling-not-showing)命中次数:把情绪当结论报出来,而非用动作/感官演出来 */
  tellingEmotionHits: number
  /** 踩红线的问题(非空 = L0 直接打回,不进 LLM judge) */
  redFlags: string[]
}

// 分句 / 标准差 / 变异系数已统一到 quality/text-metrics.ts(节奏的"同一把尺")

function countOccurrences(text: string, terms: readonly string[]): number {
  let n = 0
  for (const t of terms) {
    let i = text.indexOf(t)
    while (i !== -1) { n++; i = text.indexOf(t, i + t.length) }
  }
  return n
}

function countRegexHits(text: string, patterns: readonly RegExp[]): number {
  let n = 0
  for (const re of patterns) {
    const m = text.match(re)
    if (m) n += m.length
  }
  return n
}

function repetition4gram(text: string): number {
  const clean = text.replace(/\s+/g, "")
  if (clean.length < 8) return 0
  const grams = new Map<string, number>()
  for (let i = 0; i + 4 <= clean.length; i++) {
    const g = clean.slice(i, i + 4)
    grams.set(g, (grams.get(g) ?? 0) + 1)
  }
  let repeated = 0
  for (const c of grams.values()) if (c > 1) repeated += c - 1
  const total = clean.length - 3
  return total > 0 ? repeated / total : 0
}

export function detectSlop(text: string): SlopSignals {
  const lens = sentenceLengths(text)
  const burstiness = coefficientOfVariation(lens) // = stddev/mean,与全局节奏标尺同源
  const inBand = lens.filter((n) => n >= 15 && n <= 25).length
  const uniformSentences = lens.length >= 6 && inBand / lens.length > 0.7 && burstiness < 0.4

  const slopHits = countOccurrences(text, CN_SLOP_WORDS)
  const slopDensity = lens.length ? slopHits / lens.length : 0
  const fillerHits = countOccurrences(text, CN_FILLER_PHRASES)
  const repetitionRatio = repetition4gram(text)
  const tellingEmotionHits = countRegexHits(text, CN_TELLING_EMOTION) + countRegexHits(text, EN_TELLING_EMOTION)
  const tellingDensity = lens.length ? tellingEmotionHits / lens.length : 0

  const redFlags: string[] = []
  if (uniformSentences) redFlags.push("句长过于均匀(15–25 字等长句堆叠,典型 AI 节奏)")
  if (burstiness > 0 && burstiness < 0.3) redFlags.push("句长几乎无变化,缺少真人长短交错")
  if (slopDensity > 0.6) redFlags.push("空洞美文词过密(淋漓尽致/缓缓/一抹…堆叠)")
  if (fillerHits >= 4) redFlags.push("套话/机械连接词过多(然而/此外/值得注意的是…)")
  if (repetitionRatio > 0.06) redFlags.push("重复片段偏多,有模板/自我复读感")
  if (tellingEmotionHits >= 4 && tellingDensity > 0.25) redFlags.push("直接命名情绪过多(感到/涌起+恐惧/愤怒…),情绪该用动作与感官演出来,而非当结论报出来")

  return { burstiness, uniformSentences, slopDensity, fillerHits, repetitionRatio, tellingEmotionHits, redFlags }
}

/** 把信号折成 0–100 的"去AI味"扣分(供综合质量分参考;0=干净,越高越AI) */
export function slopPenalty(s: SlopSignals): number {
  let p = 0
  if (s.uniformSentences) p += 30
  else if (s.burstiness < 0.3) p += 18
  else if (s.burstiness < 0.45) p += 8
  p += Math.min(25, Math.round(s.slopDensity * 30))
  p += Math.min(15, s.fillerHits * 3)
  p += Math.min(20, Math.round(s.repetitionRatio * 200))
  p += Math.min(18, s.tellingEmotionHits * 4)
  return Math.min(100, p)
}
