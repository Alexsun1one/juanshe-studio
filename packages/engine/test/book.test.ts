/**
 * 卷舍引擎 · 书级编排 runBook 回归测试
 * 锁:有界并发(≤concurrency)、失败隔离(单章 halt 不拖垮整本)、拓扑分波、有界并发原语。
 */
import { describe, it, expect } from "vitest"
import { runBook, BookBrief, BookPlan, topoWaves, mapWithConcurrency, collectStyleSamples, type BookDeps, type BookBudget } from "../src/index.js"

const G = (b: string) => ({ bookId: b, entities: [], relations: [], foreshadows: [], timeline: [], chapterDeps: {} })
const chapters = [1, 2, 3, 4, 5].map((n) => ({ number: n, title: `第${n}章`, goal: `写第${n}章`, targetWordCount: 1000, dependsOn: [], plantForeshadowIds: [], payoffForeshadowIds: [], entityIds: [] }))
const mkO = (n: number, s: string, o: number) => ({ state: { runId: `r${n}`, bookId: "b", chapterNumber: n, input: {}, stage: "publishing", reviseRound: 0, artifacts: { publishing: { chapter: { number: n, quality: { overall: o } } } }, scoreHistory: [o], startedAt: "t", updatedAt: "t" }, status: s, reason: s }) as any

function mkDeps(track: { max: number }): BookDeps {
  let active = 0
  return {
    planner: async (b) => BookPlan.parse({ bookId: b, title: { zh: "测试书" }, genreId: "mystery", platformId: "webnovel", chapters, graph: G(b) }),
    pipelineDepsFor: () => ({}) as any,
    buildContextPack: (p, s) => ({ chapterNumber: s.number, input: { genreId: p.genreId, chapterGoal: s.goal, targetWordCount: s.targetWordCount, lang: "zh" }, frozenAt: "t" }) as any,
    runChapter: async (i) => { active++; track.max = Math.max(track.max, active); await new Promise((r) => setTimeout(r, 10)); active--; const n = i.chapterNumber; return mkO(n, n === 3 ? "halted" : "completed", n === 3 ? 70 : 90) },
    reconcile: async () => ({ graph: G("b"), findings: [] }),
    now: () => "2026-05-29T00:00:00Z",
    delay: async () => {},
  }
}
const budget: BookBudget = { concurrency: 2, waveMode: "flat", maxReconcilePasses: 2, stopOnChapterError: false }

describe("runBook · 书级编排", () => {
  it("扇出全本 + 失败隔离 + 并发上限", async () => {
    const track = { max: 0 }
    const out = await runBook(BookBrief.parse({ bookId: "b", title: { zh: "测试书" } }), mkDeps(track), budget)
    expect(out.results).toHaveLength(5)
    expect(out.status).toBe("partial") // ch3 halted
    expect(track.max).toBeLessThanOrEqual(2) // 并发不超 concurrency
    expect(out.results.find((r) => r.chapterNumber === 3)?.status).toBe("halted")
    expect(out.results.filter((r) => r.chapterNumber !== 3).every((r) => r.status === "completed")).toBe(true)
  })
  it("wavefront + dependsOn 链:buildContextPack 取第 n 章时第 n-1 章结果必已落定(章间前情注入依赖此契约)", async () => {
    const base = mkDeps({ max: 0 })
    const chained = chapters.map((c) => ({ ...c, dependsOn: c.number > 1 ? [c.number - 1] : [] }))
    const seen: Array<{ chapter: number; prevDone: boolean }> = []
    const deps: BookDeps = {
      ...base,
      planner: async (b) => BookPlan.parse({ bookId: b, title: { zh: "测试书" }, chapters: chained, graph: G(b) }),
      buildContextPack: (p, s, done) => {
        seen.push({ chapter: s.number, prevDone: done.has(s.number - 1) })
        return base.buildContextPack(p, s, done)
      },
    }
    const out = await runBook(BookBrief.parse({ bookId: "b", title: { zh: "测试书" } }), deps, { ...budget, waveMode: "wavefront" })
    expect(out.results).toHaveLength(5)
    expect(seen.filter((x) => x.chapter > 1).map((x) => x.prevDone)).toEqual([true, true, true, true]) // halted 的 ch3 也算落定,ch4 不被卡
  })
  it("plan 失败 → status=failed,不抛", async () => {
    const deps = mkDeps({ max: 0 })
    const bad: BookDeps = { ...deps, planner: async () => { throw new Error("建书炸了") } }
    const out = await runBook(BookBrief.parse({ bookId: "b", title: { zh: "X" } }), bad, budget)
    expect(out.status).toBe("failed")
    expect(out.results).toHaveLength(0)
  })
})

describe("runBook · 风格样本接线(流 S2)", () => {
  it("collectStyleSamples:只取当前章之前、已签发且有成稿的章,旧→新、容量截断", () => {
    const mkR = (n: number, status: string, content?: string) =>
      ({ chapterNumber: n, status, reason: "", finalState: {} as any, chapter: content !== undefined ? { content } : undefined, overall: 90 }) as any
    const results = new Map<number, any>([
      [1, mkR(1, "completed", "第一章正文")],
      [2, mkR(2, "halted", "第二章正文")], // 非 completed(未签发)不取
      [3, mkR(3, "completed")], // 无成稿正文不取
      [4, mkR(4, "completed", "第四章正文")],
      [5, mkR(5, "completed", "第五章正文")], // 当前章自身不取
      [6, mkR(6, "completed", "第六章正文")], // 章号在后不取(reconcile 重跑的因果确定性)
    ])
    expect(collectStyleSamples(results, 5)).toEqual(["第一章正文", "第四章正文"])
    expect(collectStyleSamples(results, 5, 1)).toEqual(["第四章正文"]) // 容量截断保最近
  })

  it("fanout:buildContextPack 未带样本时,把已签发章正文注入 RunInput.styleSamples(wavefront 串链)", async () => {
    const base = mkDeps({ max: 0 })
    const chained = chapters.map((c) => ({ ...c, dependsOn: c.number > 1 ? [c.number - 1] : [] }))
    const got = new Map<number, string[] | undefined>()
    const deps: BookDeps = {
      ...base,
      planner: async (b) => BookPlan.parse({ bookId: b, title: { zh: "测试书" }, chapters: chained, graph: G(b) }),
      runChapter: async (i) => {
        got.set(i.chapterNumber, i.input.styleSamples)
        const n = i.chapterNumber
        return {
          state: { ...i, stage: "publishing", artifacts: { publishing: { chapter: { number: n, content: `第${n}章成稿正文`, quality: { overall: 90 } } } }, scoreHistory: [90] },
          status: "completed", reason: "ok",
        } as any
      },
    }
    await runBook(BookBrief.parse({ bookId: "b", title: { zh: "测试书" } }), deps, { ...budget, waveMode: "wavefront" })
    expect(got.get(1) ?? []).toEqual([]) // 首章无样本,保持现状
    expect(got.get(4)).toEqual(["第1章成稿正文", "第2章成稿正文", "第3章成稿正文"]) // 旧→新带进 RunInput
  })
})

describe("runBook · 并发原语", () => {
  it("topoWaves 按依赖分波", () => {
    const specs = [{ number: 1, dependsOn: [] }, { number: 2, dependsOn: [1] }, { number: 3, dependsOn: [2] }, { number: 4, dependsOn: [] }].map((s) => ({ ...s, title: "", goal: "", targetWordCount: 1, plantForeshadowIds: [], payoffForeshadowIds: [], entityIds: [] }))
    expect(topoWaves(specs)).toEqual([[1, 4], [2], [3]])
  })
  it("mapWithConcurrency 不超上限", async () => {
    let cur = 0, max = 0
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (x) => { cur++; max = Math.max(max, cur); await new Promise((r) => setTimeout(r, 5)); cur--; return x })
    expect(max).toBeLessThanOrEqual(3)
  })
})
