/**
 * 卷舍 · 风格契合度(scoreStyleAdherence:章节 vs 目标 profile)——"风格的 L0"
 *
 * 确定性、零 LLM、可单测:对章节跑 computeMetrics 得 actual,逐维与 target 算归一化距离 →
 * 维度分 → 加权综合(rhythm 0.30 最高,与 deAiTell 哲学一致);偏差超阈值产 drift + 可执行 mustFix。
 * 不触碰 QualityScore 五维,作独立信号喂门禁(与 detectSlop+slopPenalty 同性质)。
 */
import { computeMetrics } from "./metrics.js"
import type { StyleProfile, StyleAdherenceReport, StyleDrift } from "./profile.js"

const WEIGHTS = { rhythm: 0.3, lexical: 0.15, syntax: 0.15, rhetoric: 0.15, dialogue: 0.1, pov: 0.1, punctuation: 0.05 } as const

// 单字段契合:容差 = 绝对下限 0.12 与 相对(目标 60%)取大,兼容 0–1 比率与句长均值两种量级
function fieldScore(actual: number, target: number): number {
  const denom = Math.max(0.12, Math.abs(target) * 0.6)
  return 100 * (1 - Math.min(1, Math.abs((actual ?? 0) - (target ?? 0)) / denom))
}
function avgFieldScore(actual: Record<string, unknown>, target: Record<string, unknown>): number {
  const keys = Object.keys(target).filter((k) => typeof target[k] === "number")
  if (!keys.length) return 100
  return keys.reduce((s, k) => s + fieldScore(actual[k] as number, target[k] as number), 0) / keys.length
}

export function scoreStyleAdherence(
  chapterText: string,
  target: StyleProfile,
  opts: { lang?: "zh" | "en" } = {},
): StyleAdherenceReport {
  const lang = opts.lang ?? target.lang ?? "zh"
  const actual = computeMetrics(chapterText, lang)
  const per: Record<string, number> = {
    rhythm: Math.round(avgFieldScore(actual.rhythm, target.rhythm)),
    lexical: Math.round(avgFieldScore(actual.lexical, target.lexical)),
    syntax: Math.round(avgFieldScore(actual.syntax, target.syntax)),
    rhetoric: Math.round(avgFieldScore(actual.rhetoric, target.rhetoric)),
    dialogue: Math.round(avgFieldScore(actual.dialogue, target.dialogue)),
    punctuation: Math.round(avgFieldScore(actual.punctuation, target.punctuation)),
    pov: 100, // POV/时态需 LLM 判,确定性层不打分(给满分,不拖累综合)
  }
  const overall = Math.round(
    per.rhythm * WEIGHTS.rhythm + per.lexical * WEIGHTS.lexical + per.syntax * WEIGHTS.syntax +
      per.rhetoric * WEIGHTS.rhetoric + per.dialogue * WEIGHTS.dialogue + per.pov * WEIGHTS.pov +
      per.punctuation * WEIGHTS.punctuation,
  )

  const drift: StyleDrift[] = []
  const mustFix: string[] = []
  const flag = (dim: string, expected: number, actualV: number) => {
    if (per[dim] >= 85) return
    drift.push({ dimension: dim, expected, actual: actualV, severity: per[dim] < 65 ? "major" : "minor" })
  }

  if (per.rhythm < 85) {
    const a = actual.rhythm
    const t = target.rhythm
    flag("rhythm", t.sentenceLenCV, a.sentenceLenCV)
    mustFix.push(
      `节奏偏离作者风格:本章平均句长 ${a.avgSentenceLen} 字、句长 CV ${a.sentenceLenCV}(目标约 ${t.avgSentenceLen} 字、CV ${t.sentenceLenCV})——` +
        (a.sentenceLenCV < t.sentenceLenCV ? "句子太均匀,拆开长句、插入独立成段的短句做停顿,让长短更交错" : "句长起伏过猛,适度收束"),
    )
  }
  if (per.dialogue < 80) {
    flag("dialogue", target.dialogue.dialogueRatio, actual.dialogue.dialogueRatio)
    mustFix.push(`对白占比偏离:本章约 ${Math.round(actual.dialogue.dialogueRatio * 100)}%,目标约 ${Math.round(target.dialogue.dialogueRatio * 100)}%`)
  }
  if (per.rhetoric < 80) {
    flag("rhetoric", target.rhetoric.abstractionRatio, actual.rhetoric.abstractionRatio)
    mustFix.push(
      actual.rhetoric.abstractionRatio > target.rhetoric.abstractionRatio
        ? "抽象/概念腔偏重:少用抽象名词,多落到具体可感的细节与动作"
        : "可酌情增强比喻与五感细节,贴合本作修辞密度",
    )
  }

  return { score: overall, perDimension: per, drift, mustFix }
}
