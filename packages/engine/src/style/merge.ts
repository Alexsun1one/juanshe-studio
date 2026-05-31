/**
 * 卷舍 · 风格沉淀(mergeStyle:指数移动平均 EMA 逐章收敛成作者自己的风格)
 *
 * 每写一章 extractStyle(本章) → mergeStyle(累积 profile, 本章):
 * 数值字段 EMA、枚举置信投票、数组(母题/descriptor/signatureNGram)TopK+衰减、confidence 累积。
 * 纯函数,无副作用(落盘由外层持久层负责)。
 */
import type { StyleProfile } from "./profile.js"

const round2 = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

function mergeStrArr(a: string[], b: string[], k: number): string[] {
  const score = new Map<string, number>()
  a.forEach((s, i) => score.set(s, (a.length - i) * 0.8)) // 旧项 *0.8 衰减
  b.forEach((s, i) => score.set(s, (score.get(s) ?? 0) + (b.length - i)))
  return [...score.entries()].sort((x, y) => y[1] - x[1]).slice(0, k).map(([s]) => s)
}
function mergeNGrams(a: { gram: string; z: number }[], b: { gram: string; z: number }[]): { gram: string; z: number }[] {
  const m = new Map<string, number>()
  for (const g of a) m.set(g.gram, g.z * 0.8)
  for (const g of b) m.set(g.gram, (m.get(g.gram) ?? 0) + g.z)
  return [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([gram, z]) => ({ gram, z: round2(z) }))
}

export function mergeStyle(
  prev: StyleProfile | undefined,
  next: StyleProfile,
  opts: { alpha?: number; weightByConfidence?: boolean } = {},
): StyleProfile {
  if (!prev) return structuredClone(next) // 冷启动
  const alpha = opts.alpha ?? 0.3
  const a = opts.weightByConfidence
    ? clamp(alpha * (next.confidence / ((prev.confidence + next.confidence) || 1)), 0.05, 0.6)
    : alpha
  const e = (x: number, y: number): number => round2(lerp(x, y, a))
  const dom = next.confidence >= prev.confidence // 高 confidence 方主导枚举

  return {
    schemaVersion: 1,
    bookId: next.bookId ?? prev.bookId,
    lang: dom ? next.lang : prev.lang,
    rhythm: {
      avgSentenceLen: e(prev.rhythm.avgSentenceLen, next.rhythm.avgSentenceLen),
      sentenceLenCV: e(prev.rhythm.sentenceLenCV, next.rhythm.sentenceLenCV),
      shortRatio: e(prev.rhythm.shortRatio, next.rhythm.shortRatio),
      longRatio: e(prev.rhythm.longRatio, next.rhythm.longRatio),
      midBandRatio: e(prev.rhythm.midBandRatio, next.rhythm.midBandRatio),
      standaloneShortFreq: e(prev.rhythm.standaloneShortFreq, next.rhythm.standaloneShortFreq),
      avgParagraphLen: e(prev.rhythm.avgParagraphLen, next.rhythm.avgParagraphLen),
    },
    lexical: {
      ttr: e(prev.lexical.ttr, next.lexical.ttr),
      hapaxRatio: e(prev.lexical.hapaxRatio, next.lexical.hapaxRatio),
      functionWordRatio: e(prev.lexical.functionWordRatio, next.lexical.functionWordRatio),
      avgWordLen: e(prev.lexical.avgWordLen, next.lexical.avgWordLen),
      signatureNGrams: mergeNGrams(prev.lexical.signatureNGrams, next.lexical.signatureNGrams),
    },
    syntax: {
      subordinationIndex: e(prev.syntax.subordinationIndex, next.syntax.subordinationIndex),
      clausesPerSentence: e(prev.syntax.clausesPerSentence, next.syntax.clausesPerSentence),
      parallelismRate: e(prev.syntax.parallelismRate, next.syntax.parallelismRate),
      fragmentRate: e(prev.syntax.fragmentRate, next.syntax.fragmentRate),
    },
    rhetoric: {
      simileDensity: e(prev.rhetoric.simileDensity, next.rhetoric.simileDensity),
      metaphorMarkers: e(prev.rhetoric.metaphorMarkers, next.rhetoric.metaphorMarkers),
      sensoryDensity: e(prev.rhetoric.sensoryDensity, next.rhetoric.sensoryDensity),
      abstractionRatio: e(prev.rhetoric.abstractionRatio, next.rhetoric.abstractionRatio),
    },
    dialogue: {
      dialogueRatio: e(prev.dialogue.dialogueRatio, next.dialogue.dialogueRatio),
      avgDialogueLen: e(prev.dialogue.avgDialogueLen, next.dialogue.avgDialogueLen),
      dialogueTagStyle: dom ? next.dialogue.dialogueTagStyle : prev.dialogue.dialogueTagStyle,
    },
    pov: {
      person: dom ? next.pov.person : prev.pov.person,
      tense: dom ? next.pov.tense : prev.pov.tense,
      interiorityRatio: e(prev.pov.interiorityRatio, next.pov.interiorityRatio),
    },
    punctuation: {
      emDashPerKchar: e(prev.punctuation.emDashPerKchar, next.punctuation.emDashPerKchar),
      ellipsisPerKchar: e(prev.punctuation.ellipsisPerKchar, next.punctuation.ellipsisPerKchar),
      exclamationRatio: e(prev.punctuation.exclamationRatio, next.punctuation.exclamationRatio),
      questionRatio: e(prev.punctuation.questionRatio, next.punctuation.questionRatio),
    },
    motifs: mergeStrArr(prev.motifs, next.motifs, 8),
    descriptors: mergeStrArr(prev.descriptors, next.descriptors, 12),
    sampleStats: {
      chars: prev.sampleStats.chars + next.sampleStats.chars,
      sentences: prev.sampleStats.sentences + next.sampleStats.sentences,
      mergedSamples: prev.sampleStats.mergedSamples + next.sampleStats.mergedSamples,
      updatedAt: next.sampleStats.updatedAt || prev.sampleStats.updatedAt,
    },
    // 信息累积、边际递减
    confidence: round2(clamp(prev.confidence + next.confidence * (1 - prev.confidence), 0, 1)),
  }
}
