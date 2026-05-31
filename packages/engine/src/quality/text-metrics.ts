/**
 * 卷舍 · 共享文本度量(节奏的"同一把尺")
 *
 * 句长 burstiness / 变异系数是去AI味(pregate)、风格指纹(style)、经验节奏签名(learnings)、
 * 记忆风格基线(memory)四处共同的底层度量。必须只有一份定义,否则各写一套分句正则 →
 * detectSlop 的 burstiness 与各模块算的 CV 不一致,judge.deAiTell 与风格签名互相打架。
 *
 * 本文件从 quality/pregate.ts 的私有函数提升而来(行为完全一致,pregate 反向 import),
 * 是所有"节奏类"度量的唯一来源。纯函数,零依赖,可单测。
 */

/** 中文分句:剔空白后按句末标点切;返回每句的字符长度(过滤过短碎片)。 */
export function sentenceLengths(text: string): number[] {
  return text
    .replace(/\s+/g, "")
    .split(/(?<=[。!?！?；;…])/u)
    .map((s) => s.trim().length)
    .filter((n) => n >= 2)
}

/** 算术平均。空数组返回 0。 */
export function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

/** 总体标准差(< 2 个样本返回 0)。 */
export function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length
  return Math.sqrt(v)
}

/** 变异系数 CV = stddev / mean。无量纲,可跨文本比较。mean 为 0 时返回 0。 */
export function coefficientOfVariation(xs: readonly number[]): number {
  const m = mean(xs)
  return m > 0 ? stddev(xs) / m : 0
}

/**
 * 一段文本的句长 burstiness(= 句长 CV)——节奏的唯一标尺。
 * 越高越像真人(长短交错);越低越像 AI(句句等长)。真人通常 > 0.5。
 */
export function burstiness(text: string): number {
  return coefficientOfVariation(sentenceLengths(text))
}
