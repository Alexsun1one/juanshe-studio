/**
 * 卷舍 · 经验沉淀(recordOutcome:写完判分后,把高分手法/低分反模式沉淀入库 + bandit 奖励回填)
 */
import { detectSlop } from "../quality/pregate.js"
import { sentenceLengths, mean } from "../quality/text-metrics.js"
import { similarity, decayFactor, banditScore } from "./bandit.js"
import { bucketKey, type LearningDeps } from "./store.js"
import type { Learning, PatternKind, PatternLibrary, RecordInput, RhythmFingerprint } from "./types.js"

function rhythmOf(text: string): RhythmFingerprint {
  const s = detectSlop(text)
  return {
    burstiness: round2(s.burstiness),
    uniformSentences: s.uniformSentences,
    slopDensity: round2(s.slopDensity),
    fillerHits: s.fillerHits,
    repetitionRatio: round2(s.repetitionRatio),
    avgSentenceLen: round2(mean(sentenceLengths(text))),
  }
}
const round2 = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
const shape = (s: string): string => s.replace(/\s/g, "").slice(0, 24)

function mkLearning(
  input: RecordInput, kind: PatternKind, title: string, instruction: string, sig: RhythmFingerprint,
  newId: () => string, now: string,
): Learning {
  return {
    id: newId(),
    genreId: input.genreId,
    platformId: input.platformId,
    kind,
    title: title.slice(0, 40),
    instruction: instruction.slice(0, 280),
    signature: sig,
    evidence: [{
      bookId: input.bookId,
      chapterNumber: input.chapterNumber,
      excerpt: input.chapterText.replace(/\s/g, "").slice(0, 120), // 硬限 120 字
      dims: input.score.dimensions,
    }],
    stats: { timesApplied: 0, timesObservedHigh: 1, scoreSamples: [input.score.overall], meanScore: input.score.overall, lastSeenAt: now, createdAt: now },
    status: "active",
    schemaVersion: 1,
  }
}

/** 高分章 → 可复用手法;低分章 → 反模式 */
export function extractPatterns(input: RecordInput, sig: RhythmFingerprint, newId: () => string, now: string, mode: "high" | "low"): Learning[] {
  const out: Learning[] = []
  const dims = input.score.dimensions
  if (mode === "high") {
    if (input.plan?.openingHook) out.push(mkLearning(input, "opening", "高分开篇式", `开篇用「${shape(input.plan.openingHook)}」式钩子;首段句长约 ${Math.round(sig.avgSentenceLen)} 字`, sig, newId, now))
    if (!sig.uniformSentences && sig.burstiness > 0.5) out.push(mkLearning(input, "pacing", "长短交错节奏", `句长长短交错,变异系数≈${sig.burstiness.toFixed(2)};忌连写等长句`, sig, newId, now))
    if (input.plan?.hookKind || input.plan?.beats?.length) out.push(mkLearning(input, "hook", "章末留钩", `章末以悬念/新威胁收束(${shape(input.plan?.hookKind ?? "悬念钩")}),不平收`, sig, newId, now))
    if (dims.emotion >= 85 && input.plan?.emotionArc) out.push(mkLearning(input, "emotion-arc", "情绪曲线", `情绪走「${shape(input.plan.emotionArc)}」型,层层递进到章末`, sig, newId, now))
  } else {
    const issues: string[] = []
    if (sig.uniformSentences) issues.push("句长过于均匀")
    if (sig.slopDensity > 0.4) issues.push("空洞美文词过密")
    if (sig.fillerHits >= 4) issues.push("套话/机械连接词过多")
    if (sig.repetitionRatio > 0.06) issues.push("重复片段偏多")
    if (!issues.length) issues.push("整体偏离达标线")
    out.push(mkLearning(input, "antipattern", "本题材低分反模式", `避免:${issues.join("、")}`, sig, newId, now))
  }
  return out
}

/** 近重合并(similarity>0.86 视为同手法)防同质化,否则插入并登记倒排 index */
export function mergeOrInsert(lib: PatternLibrary, incoming: Learning[]): { created: Learning[]; updated: Learning[] } {
  const created: Learning[] = []
  const updated: Learning[] = []
  for (const inc of incoming) {
    const key = bucketKey(inc.genreId, inc.platformId)
    const ids = lib.index[key] ?? []
    const bucket = ids.map((id) => lib.learnings.find((l) => l.id === id)).filter((l): l is Learning => !!l)
    const near = bucket.find((l) => l.kind === inc.kind && similarity(l, inc) > 0.86)
    if (near) {
      near.stats.timesObservedHigh += 1
      near.stats.scoreSamples.push(...inc.stats.scoreSamples)
      while (near.stats.scoreSamples.length > 50) near.stats.scoreSamples.shift()
      near.stats.meanScore = round2(mean(near.stats.scoreSamples))
      near.stats.lastSeenAt = inc.stats.lastSeenAt
      near.evidence = [...near.evidence, ...inc.evidence].slice(-5)
      if (inc.stats.meanScore >= near.stats.meanScore) near.instruction = inc.instruction
      updated.push(near)
    } else {
      lib.learnings.push(inc)
      lib.index[key] = [...ids, inc.id]
      created.push(inc)
    }
  }
  return { created, updated }
}

/** 三道闸收口:过拟合隔离 + 陈旧归档 + 桶容量上限(只改 status,不物理删) */
export function pruneAndQuarantine(lib: PatternLibrary, now: string, passThreshold = 85): void {
  for (const l of lib.learnings) {
    if (l.status !== "active") continue
    if (l.stats.timesApplied >= 8 && l.stats.meanScore < passThreshold - 5) { l.status = "quarantined"; continue }
    if (decayFactor(l.stats.lastSeenAt, now) < 0.08 && l.stats.timesObservedHigh < 3) { l.status = "retired" }
  }
  // 每桶 active 上限 60:超限按 meanScore*decay 升序 retire 末尾
  const byBucket = new Map<string, Learning[]>()
  for (const l of lib.learnings) {
    if (l.status !== "active") continue
    const k = bucketKey(l.genreId, l.platformId)
    const arr = byBucket.get(k) ?? []
    arr.push(l)
    byBucket.set(k, arr)
  }
  for (const arr of byBucket.values()) {
    if (arr.length <= 60) continue
    const rank = (l: Learning) => l.stats.meanScore * decayFactor(l.stats.lastSeenAt, now)
    arr.sort((a, b) => rank(a) - rank(b))
    for (let i = 0; i < arr.length - 60; i++) arr[i].status = "retired"
  }
}

/** 主流程:奖励回填 + 抽模式入库 + 收口 */
export async function recordOutcome(
  input: RecordInput, deps: LearningDeps,
): Promise<{ created: Learning[]; updated: Learning[]; rewarded: Learning[] }> {
  const lib = await deps.store.load()
  const now = deps.now()
  const sig = rhythmOf(input.chapterText)

  // ① bandit 奖励回填:本章回灌过的模式,把本章 overall 反馈回臂
  const rewarded: Learning[] = []
  for (const id of input.appliedLearningIds) {
    const l = lib.learnings.find((x) => x.id === id && x.status === "active")
    if (!l) continue
    l.stats.scoreSamples.push(input.score.overall)
    while (l.stats.scoreSamples.length > 50) l.stats.scoreSamples.shift()
    l.stats.timesApplied += 1
    l.stats.meanScore = round2(mean(l.stats.scoreSamples))
    l.stats.lastAppliedAt = now
    rewarded.push(l)
  }

  // ② 高/低分抽模式(中间分不沉淀,防噪声)
  const t = input.score.passThreshold ?? 85
  let candidates: Learning[] = []
  if (input.score.overall >= t) candidates = extractPatterns(input, sig, deps.newId, now, "high")
  else if (input.score.overall < t - 12) candidates = extractPatterns(input, sig, deps.newId, now, "low")
  const { created, updated } = mergeOrInsert(lib, candidates)

  // ③ 收口 + 落库
  pruneAndQuarantine(lib, now, t)
  lib.updatedAt = now
  await deps.store.save(lib)
  return { created, updated, rewarded }
}
