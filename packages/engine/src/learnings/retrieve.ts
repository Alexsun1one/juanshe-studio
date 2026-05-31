/**
 * 卷舍 · 经验回灌(retrieveLearnings:取桶 → bandit 打分 → MMR 选 top-k + ε 探索 + 反模式)
 * renderLearnings:渲染成提示词块,供 assemble.buildSystemPrompt 的 learnings 注入口。
 */
import { banditScore, mmrSelect } from "./bandit.js"
import { bucketKey, type LearningDeps } from "./store.js"
import type { Learning, RetrieveQuery, RetrievedPattern } from "./types.js"

function reasonOf(l: Learning): string {
  const fresh = Math.round((l.stats.timesObservedHigh > 0 ? 1 : 0) * 100)
  return `近窗均分 ${Math.round(l.stats.meanScore)} / 复现 ${l.stats.timesObservedHigh} 次 / 新鲜度 ${fresh}%`
}

export async function retrieveLearnings(q: RetrieveQuery, deps: LearningDeps): Promise<RetrievedPattern[]> {
  const lib = await deps.store.load()
  const ids = lib.index[bucketKey(q.genreId, q.platformId)] ?? []
  const bucket = ids
    .map((id) => lib.learnings.find((l) => l.id === id))
    .filter((l): l is Learning => !!l && l.status === "active")
  if (!bucket.length) return [] // 优雅降级:planning 退回纯题材/平台知识

  const recos = bucket.filter((l) => l.kind !== "antipattern")
  const antis = bucket.filter((l) => l.kind === "antipattern")
  const totalPulls = recos.reduce((s, l) => s + l.stats.timesApplied, 0) + 1

  const scored = recos.map((l) => ({ l, raw: banditScore(l, totalPulls, q.now) }))
  const finite = scored.map((s) => s.raw).filter((x) => Number.isFinite(x))
  const maxR = finite.length ? Math.max(...finite, 0.0001) : 1
  const cands = scored.map((s) => ({ l: s.l, rel: Number.isFinite(s.raw) ? s.raw / maxR : 1 })) // 冷启动 Infinity → 视为最高 rel

  const reservedAnti = q.includeAntipatterns && antis.length ? 1 : 0
  const exploreSlot = q.explore > 0 && recos.length > q.k ? 1 : 0
  const exploitK = Math.max(1, q.k - reservedAnti - exploreSlot)

  const exploited = mmrSelect(cands, exploitK, q.diversityLambda)
  const out: RetrievedPattern[] = exploited.map((l) => ({ learning: l, reason: reasonOf(l), selectedBy: "exploit" as const }))

  // ε 探索(确定性变体,可测):给"回灌最少"的新手法一个出场位
  if (exploreSlot) {
    const cold = recos
      .filter((l) => !exploited.includes(l))
      .sort((a, b) => a.stats.timesApplied - b.stats.timesApplied)[0]
    if (cold) out.push({ learning: cold, reason: `探索:仅回灌 ${cold.stats.timesApplied} 次,给新手法一次机会`, selectedBy: "explore" })
  }

  // 反模式单独成"避免清单",不进 MMR 推荐池
  if (reservedAnti) {
    const topAnti = [...antis].sort((a, b) => banditScore(b, 2, q.now) - banditScore(a, 2, q.now))[0]
    if (topAnti) out.push({ learning: topAnti, reason: "本题材低分常见坑", selectedBy: "exploit" })
  }

  return out.slice(0, q.k)
}

/** 渲染成提示词块(planning 注入面);措辞对齐 assemble 的 renderGenre/renderPlatform */
export function renderLearnings(patterns: RetrievedPattern[], lang: "zh" | "en" = "zh"): string {
  if (!patterns.length) return ""
  const recos = patterns.filter((p) => p.learning.kind !== "antipattern")
  const antis = patterns.filter((p) => p.learning.kind === "antipattern")
  const lines: string[] = []
  if (recos.length) {
    lines.push(lang === "en" ? "## Battle-tested patterns for this genre×platform" : "## 本题材×平台实战经验(从高分章节蒸馏)")
    for (const p of recos) lines.push(`· ${p.learning.instruction}${p.selectedBy === "explore" ? "(试验手法)" : ""}`)
  }
  if (antis.length) {
    lines.push(lang === "en" ? "## Antipatterns to avoid" : "## 要避免的反模式")
    for (const p of antis) lines.push(`· ${p.learning.instruction}`)
  }
  return lines.join("\n")
}
