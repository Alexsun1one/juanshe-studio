/**
 * 卷舍 · 经验库 bandit/相似度/多样性(全纯函数,可单测)
 * UCB1-Tuned 选有效模式 + 半衰 decay 抗陈旧 + MMR 抗同质化。
 */
import type { Learning } from "./types.js"

/** 指数半衰:久未复现的模式自然沉底,夹到 [0.05, 1] */
export function decayFactor(lastSeenAt: string, now: string, halfLifeDays = 30): number {
  const a = Date.parse(lastSeenAt)
  const b = Date.parse(now)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1
  const ageDays = Math.max(0, (b - a) / 86400000)
  return Math.max(0.05, Math.min(1, Math.pow(0.5, ageDays / halfLifeDays)))
}

function sampleVariance(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((s, x) => s + x, 0) / xs.length
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length
}

/** UCB1-Tuned + 时间衰减 + 小样本置信收缩 */
export function banditScore(l: Learning, totalPulls: number, now: string): number {
  const n = l.stats.timesApplied
  if (n === 0) return Number.POSITIVE_INFINITY // 乐观初始化:新模式必给一次出场
  const pulls = Math.max(2, totalPulls)
  const mean = l.stats.meanScore / 100
  const v = sampleVariance(l.stats.scoreSamples) / 10000 + Math.sqrt((2 * Math.log(pulls)) / n)
  const ucb = mean + Math.sqrt((Math.log(pulls) / n) * Math.min(0.25, v))
  const decay = decayFactor(l.stats.lastSeenAt, now)
  const shrink = l.stats.timesObservedHigh < 3 ? 0.85 : 1 // 只见过一两次的"高分"不可全信
  return ucb * decay * shrink
}

function tokens(l: Learning): Set<string> {
  return new Set((`${l.title} ${l.instruction}`).toLowerCase().match(/[一-鿿]|[a-z0-9]+/g) ?? [])
}
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d > 0 ? dot / d : 0
}

/** 相似度:有 embedding 走 cosine,否则 token Jaccard;同 kind 给基线避免被判全无关 */
export function similarity(a: Learning, b: Learning): number {
  if (a.embedding && b.embedding) return cosine(a.embedding, b.embedding)
  const ta = tokens(a)
  const tb = tokens(b)
  const inter = [...ta].filter((t) => tb.has(t)).length
  const uni = new Set([...ta, ...tb]).size
  const jac = uni ? inter / uni : 0
  return a.kind === b.kind ? Math.max(jac, 0.3) : jac
}

/** 最大边际相关:即使都高分,手法相似的第二条边际收益被压低,强制 top-k 覆盖不同手法 */
export function mmrSelect(cands: { l: Learning; rel: number }[], k: number, lambda: number): Learning[] {
  const selected: Learning[] = []
  const pool = [...cands]
  while (selected.length < k && pool.length) {
    let best = Number.NEGATIVE_INFINITY
    let bestIdx = 0
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]
      const maxSim = selected.length ? Math.max(...selected.map((s) => similarity(c.l, s))) : 0
      const marginal = lambda * c.rel - (1 - lambda) * maxSim
      if (marginal > best) { best = marginal; bestIdx = i }
    }
    selected.push(pool[bestIdx].l)
    pool.splice(bestIdx, 1)
  }
  return selected
}
