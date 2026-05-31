/**
 * 卷舍引擎 · 长期记忆 回归测试
 *
 * 锁住 memory 写/读路径的关键纯函数:
 *  - reconcile:Mem0 三态(ADD/UPDATE)、别名归一去重、状态变更覆盖、伏笔状态机(planted→paid-off)、chapterDeps
 *  - selectContext:priorContext 含上一章钩子 + 超期伏笔提醒(复用 knowledge.overdueForeshadows)、bookBible 含出场实体
 *  - account:promoteAccountRule 命中累计、retrieveAccountRules 过滤+排序
 *
 * 这些用例曾逼出一个真 bug:超期伏笔被错标"临近回收"(overdueForeshadows 不改 .state)。
 */
import { describe, it, expect } from "vitest"
import {
  reconcile,
  selectContext,
  promoteAccountRule,
  retrieveAccountRules,
  emptyBookMemory,
  emptyAccountMemory,
  type ChapterFacts,
  type BookMemory,
} from "../src/index.js"

function genIdFactory() {
  let n = 0
  return (p: string) => `${p}${n++}`
}

const factsCh1: ChapterFacts = {
  candidateEntities: [{ name: "林夏", type: "character", aliases: ["小夏"], attributes: { 身份: "侦探" } }],
  candidateRelations: [],
  foreshadowPlanted: [{ description: "照片背面的日期", expectedPayoffBy: 2 }],
  foreshadowPaidOff: [],
  stateChanges: [],
  oneLine: "林夏收到神秘照片",
  beats: ["开场"],
  hook: "日期正是她出生那天",
}

describe("reconcile · Mem0 三态合并", () => {
  it("新章:加实体 + 埋伏笔 + 写 chapterDeps", () => {
    const r = reconcile(emptyBookMemory("b").graph, factsCh1, 1, genIdFactory())
    expect(r.graph.entities.map((e) => e.name)).toEqual(["林夏"])
    expect(r.graph.foreshadows).toHaveLength(1)
    expect(r.graph.foreshadows[0].state).toBe("planted")
    expect(r.plantedIds).toHaveLength(1)
    expect(r.graph.chapterDeps["1"]).toBeTruthy()
  })

  it("别名归一 + 状态变更覆盖 + 伏笔回收", () => {
    const gen = genIdFactory()
    const r1 = reconcile(emptyBookMemory("b").graph, factsCh1, 1, gen)
    const factsCh2: ChapterFacts = {
      candidateEntities: [{ name: "小夏", type: "character", aliases: [], attributes: {} }], // 别名,不应新建
      candidateRelations: [],
      foreshadowPlanted: [],
      foreshadowPaidOff: ["照片背面的日期"],
      stateChanges: [{ entityName: "林夏", change: "得知身世" }],
      oneLine: "真相揭晓",
      beats: [],
    }
    const r2 = reconcile(r1.graph, factsCh2, 2, gen)
    expect(r2.graph.entities).toHaveLength(1) // 小夏 = 林夏,未新建
    expect(r2.graph.entities[0].currentState).toBe("得知身世")
    expect(r2.graph.foreshadows[0].state).toBe("paid-off")
    expect(r2.graph.foreshadows[0].paidOffChapter).toBe(2)
    expect(r2.paidOffIds).toHaveLength(1)
  })
})

describe("selectContext · 写章前检索", () => {
  it("priorContext 含上一章钩子 + 超期伏笔提醒;bookBible 含出场实体", () => {
    const r1 = reconcile(emptyBookMemory("b").graph, factsCh1, 1, genIdFactory())
    const mem: BookMemory = {
      ...emptyBookMemory("b"),
      graph: r1.graph, // 伏笔 expectedPayoffBy=2
      digests: [{
        chapter: 1, title: "门铃", oneLine: "林夏收到神秘照片", beats: [],
        entitiesPresent: r1.entityIds, foreshadowPlanted: r1.plantedIds, foreshadowPaidOff: [],
        hook: "日期正是她出生那天", wordCount: 100, burstiness: 0.6, salience: 0.6,
      }],
    }
    const cp = selectContext(mem, { chapter: 5, plannedEntities: r1.entityIds }) // 第5章 → 第2章前应回收的伏笔已超期
    expect(cp.priorContext).toContain("日期正是") // 上一章钩子
    expect(cp.priorContext).toContain("照片背面") // 伏笔提醒
    expect(cp.priorContext).toContain("已超期") // 正确标签(曾误标"临近回收")
    expect(cp.bookBible).toContain("林夏") // 出场实体卡
    expect(cp.usedForeshadowIds.length).toBeGreaterThan(0)
  })
})

describe("account · salience + decay", () => {
  it("等价规则命中累计;检索按 score 排序", () => {
    let acc = emptyAccountMemory()
    acc = promoteAccountRule(acc, { rule: "句长要长短交错", kind: "de-ai" }, "t1")
    acc = promoteAccountRule(acc, { rule: "句长要长短交错", kind: "de-ai" }, "t2") // 同规则 → hits++
    acc = promoteAccountRule(acc, { rule: "少用空洞美文词", kind: "de-ai" }, "t3")
    expect(acc.rules).toHaveLength(2)
    const hot = acc.rules.find((r) => r.rule === "句长要长短交错")
    expect(hot?.hits).toBe(2)
    const top = retrieveAccountRules(acc, { limit: 1 })
    expect(top[0].rule).toBe("句长要长短交错") // hits 高 → score 高 → 排第一
  })

  it("按题材过滤", () => {
    let acc = emptyAccountMemory()
    acc = promoteAccountRule(acc, { rule: "都市文要接地气", kind: "style", genreId: "urban" }, "t1")
    acc = promoteAccountRule(acc, { rule: "玄幻要有体系", kind: "style", genreId: "xuanhuan" }, "t2")
    const urban = retrieveAccountRules(acc, { genreId: "urban" })
    expect(urban.map((r) => r.rule)).toContain("都市文要接地气")
    expect(urban.map((r) => r.rule)).not.toContain("玄幻要有体系")
  })
})
