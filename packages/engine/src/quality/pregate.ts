/**
 * 卷舍 · 质量 L0 零成本预门禁 / AI 味检测器(纯 TS,零 LLM 成本)
 *
 * 在烧 judge token 之前先做确定性机检,踩红线的稿子直接打回返修。
 * 复用 anti-slop 词表 + 句长 burstiness(humanize-chinese 在 HC3-Chinese 上验证的最强信号)。
 *
 * 口径(对齐真实书稿审计,修正旧版"重词表轻句式、阈值永不触发、常规叙事词误伤"三宗罪):
 *  - 词表分层加权:hard 词全权、soft 词 0.3("一阵风""微微一笑"单独出现近乎免罚);
 *  - 连接词只数句首:句中"然而/最后"是正常叙事,句首才是说明文腔;"最后"必须紧跟逗号
 *    ("最后一刻""最后他笑了"绝不能误报);
 *  - 密度两档:warning 只记不打回,red 才进 redFlags;短文本样本不足时密度指标只记数不挂旗;
 *  - 禁用句式(CN_BANNED_PATTERNS):提示词最重禁令的机检对应物,逐条点名带原句片段;
 *    对白引号内命中按 0.5 计权(口语里"不是…是…"偶有合法用法)。
 *
 * 方法学综合自公开研究(humanize-chinese N-gram困惑度 / EQ-Bench slop / 检测器 perplexity-burstiness),
 * 实现为本项目原创纯函数,可单测。
 */
import {
  CN_SLOP_WORDS_HARD, CN_SLOP_WORDS_SOFT, CN_FILLER_HARD, CN_FILLER_CONNECTIVES,
  CN_BANNED_PATTERNS, CN_TELLING_EMOTION, EN_TELLING_EMOTION,
} from "../agents/anti-slop.js"
import { sentenceLengths, coefficientOfVariation } from "./text-metrics.js"

// ── 阈值(单一事实源,调口径只改这里)───────────────────────────
/** soft 词 / 句首连接词的计权 */
const SOFT_WEIGHT = 0.3
/** 美文词加权密度(命中/句):red≈每千字 3 处 hard 词(旧红线 0.6 形同虚设,实测差 15 倍);导出供 learnings 等下游同口径消费 */
const SLOP_DENSITY_WARN = 0.04
export const SLOP_DENSITY_RED = 0.08
/** 套话加权密度(命中/千字):按密度不再惩罚长章(旧版绝对值≥4 对 6000 字章节是冤案) */
const FILLER_PER1K_WARN = 1.5
export const FILLER_PER1K_RED = 2.5
/** 密度类指标的最小样本量:文本太短时密度失真,只记数、不挂旗、不罚分 */
const MIN_SENTENCES_FOR_DENSITY = 10
const MIN_CHARS_FOR_DENSITY = 300
/** 对白引号内禁用句式的减权 */
const DIALOGUE_WEIGHT = 0.5

export interface BannedPatternHit {
  /** 句式名(对应 CN_BANNED_PATTERNS.name) */
  name: string
  /** 原始命中次数(未减权) */
  count: number
  /** 加权命中(对白引号内按 0.5 计) */
  weighted: number
  /** 第一处命中的原文片段(润色/修稿定点打击用) */
  sample?: string
}

export interface SlopSignals {
  /** 句长变异系数 CV(stddev/mean):越低越像 AI;真人通常 > 0.5 */
  burstiness: number
  /** 句长过于均匀(大量 15–25 字等长句)= 最强 AI 信号 */
  uniformSentences: boolean
  /** 空洞美文词加权命中(hard 1.0 / soft 0.3)/ 句子数 */
  slopDensity: number
  /** 套话命中次数(真套话整词 + 连接词只数句首) */
  fillerHits: number
  /** 重复 4-gram 占比(自我复读 / 模板感) */
  repetitionRatio: number
  /** 直接命名情绪(telling-not-showing)命中次数:把情绪当结论报出来,而非用动作/感官演出来 */
  tellingEmotionHits: number
  /** 踩红线的问题(非空 = L0 直接打回,不进 LLM judge) */
  redFlags: string[]
  // ── 以下为新增可选字段(向后兼容:旧消费方可不读)────────────
  /** 禁用句式加权命中总数(「不是A,而是B」等;对白引号内减半计权) */
  bannedPatternHits?: number
  /** 禁用句式逐条明细(句式名 + 次数 + 原句片段) */
  bannedPatternDetail?: BannedPatternHit[]
  /** 套话加权密度(次/千字) */
  fillerPer1k?: number
  /** 句子数(密度指标的样本量;不足 MIN_SENTENCES_FOR_DENSITY 时密度只记数不挂旗) */
  sentenceCount?: number
  /** 去空白字符数(同上,套话密度的样本量) */
  charCount?: number
  /** warning 档信号:不打回,但值得润色注意(区别于 redFlags) */
  warnings?: string[]
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

const round2 = (n: number): number => Math.round(n * 100) / 100

// 句首连接词:由 CN_FILLER_CONNECTIVES 构建。「最后」必须紧跟逗号才算连接词
// (「最后一刻」「最后他笑了」是正常叙事,绝不能误报——有测试锁死)。
const CONNECTIVE_HEAD_RE = new RegExp(
  `(?:^|[。！？!?；;…\\n])\\s*(?:${CN_FILLER_CONNECTIVES.filter((w) => w !== "最后").join("|")})`,
  "g",
)
const FINALLY_HEAD_RE = /(?:^|[。！？!?；;…\n])\s*最后[，,]/g

function countSentenceInitialConnectives(text: string): number {
  return (text.match(CONNECTIVE_HEAD_RE)?.length ?? 0) + (text.match(FINALLY_HEAD_RE)?.length ?? 0)
}

// 对白引号区间(禁用句式在引号内减权用)
function quoteRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const m of text.matchAll(/「[^」\n]*」|『[^』\n]*』|“[^”\n]*”|"[^"\n]*"/g)) {
    const i = m.index ?? 0
    out.push([i, i + m[0].length])
  }
  return out
}

function countBannedPatterns(text: string): BannedPatternHit[] {
  const quotes = quoteRanges(text)
  const inQuote = (i: number) => quotes.some(([s, e]) => i >= s && i < e)
  const out: BannedPatternHit[] = []
  for (const p of CN_BANNED_PATTERNS) {
    let count = 0
    let weighted = 0
    let sample: string | undefined
    for (const m of text.matchAll(p.re)) {
      count++
      weighted += inQuote(m.index ?? 0) ? DIALOGUE_WEIGHT : 1
      if (!sample) sample = m[0].length > 26 ? `${m[0].slice(0, 24)}…` : m[0]
    }
    if (count > 0) out.push({ name: p.name, count, weighted: round2(weighted), sample })
  }
  return out
}

export function detectSlop(text: string): SlopSignals {
  const lens = sentenceLengths(text)
  const burstiness = coefficientOfVariation(lens) // = stddev/mean,与全局节奏标尺同源
  const inBand = lens.filter((n) => n >= 15 && n <= 25).length
  const uniformSentences = lens.length >= 6 && inBand / lens.length > 0.7 && burstiness < 0.4

  const charCount = text.replace(/\s+/g, "").length

  // 美文词:hard 全权 / soft 0.3 ——「一阵风」「微微一笑」单独出现近乎免罚
  const hardHits = countOccurrences(text, CN_SLOP_WORDS_HARD)
  const softHits = countOccurrences(text, CN_SLOP_WORDS_SOFT)
  const slopDensity = lens.length ? (hardHits + softHits * SOFT_WEIGHT) / lens.length : 0

  // 套话:真套话整词计,连接词只数句首;密度按千字,不再惩罚长章
  const fillerHardHits = countOccurrences(text, CN_FILLER_HARD)
  const connectiveHits = countSentenceInitialConnectives(text)
  const fillerHits = fillerHardHits + connectiveHits
  const fillerPer1k = charCount ? round2(((fillerHardHits + connectiveHits * SOFT_WEIGHT) / charCount) * 1000) : 0

  const repetitionRatio = repetition4gram(text)
  const tellingEmotionHits = countRegexHits(text, CN_TELLING_EMOTION) + countRegexHits(text, EN_TELLING_EMOTION)
  const tellingDensity = lens.length ? tellingEmotionHits / lens.length : 0

  // 禁用句式:绝对禁令,不做密度门(一处就是一处);对白内减权
  const bannedPatternDetail = countBannedPatterns(text)
  const bannedPatternHits = round2(bannedPatternDetail.reduce((a, d) => a + d.weighted, 0))

  const redFlags: string[] = []
  const warnings: string[] = []
  if (uniformSentences) redFlags.push("句长过于均匀(15–25 字等长句堆叠,典型 AI 节奏)")
  if (burstiness > 0 && burstiness < 0.3) redFlags.push("句长几乎无变化,缺少真人长短交错")
  const densityOk = lens.length >= MIN_SENTENCES_FOR_DENSITY
  if (densityOk && slopDensity >= SLOP_DENSITY_RED) {
    redFlags.push(`空洞美文词/陈词过密(加权 ${slopDensity.toFixed(2)}/句,红线 ${SLOP_DENSITY_RED}):眼中闪过/深吸一口气/淋漓尽致…堆叠`)
  } else if (densityOk && slopDensity >= SLOP_DENSITY_WARN) {
    warnings.push(`空洞美文词偏多(加权 ${slopDensity.toFixed(2)}/句),润色时注意收敛`)
  }
  if (charCount >= MIN_CHARS_FOR_DENSITY && fillerPer1k >= FILLER_PER1K_RED) {
    redFlags.push(`套话/句首连接词过密(加权 ${fillerPer1k.toFixed(1)} 次/千字,红线 ${FILLER_PER1K_RED}):然而/此外/值得注意的是…`)
  } else if (charCount >= MIN_CHARS_FOR_DENSITY && fillerPer1k >= FILLER_PER1K_WARN) {
    warnings.push(`套话/句首连接词偏多(加权 ${fillerPer1k.toFixed(1)} 次/千字)`)
  }
  if (repetitionRatio > 0.06) redFlags.push("重复片段偏多,有模板/自我复读感")
  if (tellingEmotionHits >= 4 && tellingDensity > 0.25) redFlags.push("直接命名情绪过多(感到/涌起+恐惧/愤怒…),情绪该用动作与感官演出来,而非当结论报出来")
  for (const d of bannedPatternDetail) {
    const redAt = CN_BANNED_PATTERNS.find((p) => p.name === d.name)?.redAt ?? 1
    const msg = `禁用句式「${d.name}」命中 ${d.count} 处${d.sample ? `(如:${d.sample})` : ""}`
    if (d.weighted >= redAt) redFlags.push(msg)
    else warnings.push(`${msg}——对白内/单处,暂记警告`)
  }

  return {
    burstiness, uniformSentences, slopDensity, fillerHits, repetitionRatio, tellingEmotionHits, redFlags,
    bannedPatternHits, bannedPatternDetail, fillerPer1k, sentenceCount: lens.length, charCount, warnings,
  }
}

/** 把信号折成 0–100 的"去AI味"扣分(供综合质量分参考;0=干净,越高越AI) */
export function slopPenalty(s: SlopSignals): number {
  let p = 0
  if (s.uniformSentences) p += 30
  else if (s.burstiness < 0.3) p += 18
  else if (s.burstiness < 0.45) p += 8
  // 美文词:两档密度(短文本样本不足时免罚,防两句话里一个"一阵风"被误杀)
  const slopDense = (s.sentenceCount ?? Number.MAX_SAFE_INTEGER) >= MIN_SENTENCES_FOR_DENSITY
  if (slopDense && s.slopDensity >= SLOP_DENSITY_RED) p += Math.min(25, 16 + Math.round((s.slopDensity - SLOP_DENSITY_RED) * 100))
  else if (slopDense && s.slopDensity >= SLOP_DENSITY_WARN) p += 8
  // 套话:按加权密度(次/千字),长章不再吃绝对值冤案
  const fillerDense = (s.charCount ?? Number.MAX_SAFE_INTEGER) >= MIN_CHARS_FOR_DENSITY
  const fp = s.fillerPer1k ?? 0
  if (fillerDense && fp >= 4) p += 15
  else if (fillerDense && fp >= FILLER_PER1K_RED) p += 9
  else if (fillerDense && fp >= FILLER_PER1K_WARN) p += 4
  p += Math.min(20, Math.round(s.repetitionRatio * 200))
  p += Math.min(18, s.tellingEmotionHits * 4)
  // 禁用句式:最重 AI 指纹,每加权命中 +6,封顶 24
  p += Math.min(24, Math.round((s.bannedPatternHits ?? 0) * 6))
  return Math.min(100, p)
}
