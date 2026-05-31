/**
 * 卷舍引擎 · 经验库 回归测试
 * 锁:高分沉淀手法 / 检索回灌 / bandit 奖励回填(timesApplied++、meanScore 更新)/ 低分反模式 / decay 半衰。
 */
import { describe, it, expect } from "vitest"
import {
  recordOutcome,
  retrieveLearnings,
  renderLearnings,
  InMemoryLearningStore,
  decayFactor,
  banditScore,
  type LearningDeps,
} from "../src/index.js"

const VARIED = `雨。林夏盯着门。门铃又响了,第三次,固执得像在宣告一件不容拒绝的事。她没动。窗外的雨把整条街泡成一团模糊的光,远处有车碾过水洼,声音长长地拖过去,又被新的雨声盖住。她终于走过去,扭开锁。`
const UNIFORM = Array.from({ length: 10 }, (_, i) => `这是第${i + 1}个长度大致相同的句子用来测试均匀节奏`).join("。") + "。"
const sc = (o: number) => ({ overall: o, dimensions: { consistency: o, pacing: o, emotion: 90, prose: o, deAiTell: o }, passThreshold: 85 })
const base = { genreId: "mystery", platformId: "webnovel", bookId: "b", plan: { openingHook: "雨夜门铃悬念", emotionArc: "递进", hookKind: "悬念钩", beats: ["x"] }, appliedLearningIds: [] as string[] }

function mkDeps(): LearningDeps {
  const store = new InMemoryLearningStore()
  let idc = 0
  return { store, now: () => "2026-05-29T00:00:00Z", newId: () => `L${idc++}` }
}

describe("learnings · 沉淀与回灌", () => {
  it("高分章沉淀可复用手法,检索能回灌", async () => {
    const deps = mkDeps()
    const r1 = await recordOutcome({ ...base, chapterNumber: 1, chapterText: VARIED, score: sc(92) }, deps)
    expect(r1.created.length).toBeGreaterThan(0)
    expect(r1.created.map((l) => l.kind)).toContain("pacing")
    const got = await retrieveLearnings({ genreId: "mystery", platformId: "webnovel", k: 4, explore: 0.15, diversityLambda: 0.7, includeAntipatterns: true, now: "2026-05-29T01:00:00Z" }, deps)
    expect(got.length).toBeGreaterThan(0)
    expect(renderLearnings(got)).toContain("实战经验")
  })

  it("bandit 奖励回填:回灌过的手法 timesApplied++、meanScore 纳入新分", async () => {
    const deps = mkDeps()
    await recordOutcome({ ...base, chapterNumber: 1, chapterText: VARIED, score: sc(92) }, deps)
    const got = await retrieveLearnings({ genreId: "mystery", platformId: "webnovel", k: 4, explore: 0.15, diversityLambda: 0.7, includeAntipatterns: true, now: "2026-05-29T01:00:00Z" }, deps)
    const id = got[0].learning.id
    const r2 = await recordOutcome({ ...base, chapterNumber: 2, chapterText: VARIED, score: sc(95), appliedLearningIds: [id] }, deps)
    expect(r2.rewarded).toHaveLength(1)
    expect(r2.rewarded[0].stats.timesApplied).toBe(1)
    expect(r2.rewarded[0].stats.meanScore).toBeGreaterThanOrEqual(92)
  })

  it("低分章沉淀反模式", async () => {
    const deps = mkDeps()
    const r = await recordOutcome({ ...base, chapterNumber: 1, chapterText: UNIFORM, score: sc(60) }, deps)
    expect(r.created.map((l) => l.kind)).toContain("antipattern")
  })
})

describe("learnings · bandit 数学", () => {
  it("decay 半衰:30 天 ≈ 0.5", () => {
    expect(decayFactor("2026-04-29T00:00:00Z", "2026-05-29T00:00:00Z")).toBeCloseTo(0.5, 1)
  })
  it("冷启动手法(timesApplied=0)banditScore 为 +Infinity(乐观初始化)", () => {
    const l = { id: "x", genreId: "g", platformId: "p", kind: "opening" as const, title: "t", instruction: "i", evidence: [], status: "active" as const, schemaVersion: 1 as const, stats: { timesApplied: 0, timesObservedHigh: 1, scoreSamples: [90], meanScore: 90, lastSeenAt: "2026-05-29T00:00:00Z", createdAt: "2026-05-29T00:00:00Z" } }
    expect(banditScore(l, 5, "2026-05-29T00:00:00Z")).toBe(Number.POSITIVE_INFINITY)
  })
})
