/**
 * runBook 章间前情回归测试(buildBookPriorContext / chapterTailText)
 * 锁:① 上一章成稿结尾注入头部且过 cleanChapterText(内部状态块绝不泄进上下文);
 *     ② 完成章一行摘要带 judge 分、未完成章退回大纲行、首章无前情;
 *     ③ 章尾截取优先段落边界起切,切不出整段时省略号示意截断。
 */
import { describe, it, expect } from "vitest"
import { buildBookPriorContext, chapterTailText } from "../engine-bridge"
import type { BookPlan, ChapterSpec, ChapterResult } from "@juanshe/engine"

const spec = (n: number): ChapterSpec => ({
  number: n,
  title: `章名${n}`,
  goal: `目标${n}`,
  targetWordCount: 1000,
  dependsOn: n > 1 ? [n - 1] : [],
  plantForeshadowIds: [],
  payoffForeshadowIds: [],
  entityIds: [],
})

const plan: BookPlan = {
  bookId: "b",
  title: { zh: "测试书" },
  lang: "zh",
  bookBible: "",
  chapters: [1, 2, 3].map(spec),
  graph: { bookId: "b", entities: [], relations: [], foreshadows: [], timeline: [], chapterDeps: {} },
}

// finalState 只为携带 artifacts(buildBookPriorContext 仅读这一处),其余字段测试无关
const result = (n: number, content: string, overall = 90, status = "completed"): ChapterResult => ({
  chapterNumber: n,
  status: status as ChapterResult["status"],
  reason: status,
  finalState: { artifacts: { publishing: { chapter: { content } } } } as unknown as ChapterResult["finalState"],
  overall,
})

describe("buildBookPriorContext · 章间前情组装", () => {
  it("上一章成稿结尾注入头部,完成章带 judge 分,未完成章退回大纲行", () => {
    const done = new Map([
      [1, result(1, "第一章开头。\n\n夜风停了,她把信塞回抽屉。", 88)],
      // 第 2 章 halted:不算"已完成",但其成稿仍是第 3 章要承接的结尾
      [2, result(2, "第二章开头。\n\n他推门出去,雨还没停。", 70, "halted")],
    ])
    const prior = buildBookPriorContext(plan, spec(3), done)
    expect(prior).toContain("【上一章结尾原文】(第2章结尾")
    expect(prior).toContain("他推门出去,雨还没停。")
    expect(prior).toContain("第1章《章名1》:目标1(已完成,judge 分 88)")
    expect(prior).toContain("第2章《章名2》:目标2") // halted → 大纲行
    expect(prior).not.toContain("第2章《章名2》:目标2(已完成")
  })
  it("done 为空(flat 模式/补修取不到):优雅退回纯大纲行,无结尾块", () => {
    const prior = buildBookPriorContext(plan, spec(3), new Map())
    expect(prior).not.toContain("【上一章结尾原文】")
    expect(prior).toBe("第1章《章名1》:目标1\n第2章《章名2》:目标2")
  })
  it("首章:无前章,前情为空串(上游转 undefined)", () => {
    expect(buildBookPriorContext(plan, spec(1), new Map())).toBe("")
  })
  it("上一章成稿带内部状态块:剥净后才截结尾,标记绝不泄进上下文", () => {
    const body = `${"风把窗纸吹得直响。".repeat(40)}\n\n她吹灭了灯。\nUPDATED_STATE: {"mood":"calm"}`
    const done = new Map([[1, result(1, body)]])
    const prior = buildBookPriorContext(plan, spec(2), done)
    expect(prior).toContain("她吹灭了灯。")
    expect(prior).not.toContain("UPDATED_STATE")
  })
})

describe("chapterTailText · 结尾 400-600 字截取", () => {
  it("短文整段返回", () => {
    expect(chapterTailText("夜深了。")).toBe("夜深了。")
  })
  it("长文优先段落边界起切,落在 400-600 字", () => {
    const tailPara = "他终于看清了那行字。".repeat(50) // 500 字整段
    const text = `${"前文铺垫。".repeat(200)}\n\n${tailPara}`
    const tail = chapterTailText(text)
    expect(tail).toBe(tailPara) // 从段落边界干净起步
    expect(tail.length).toBeGreaterThanOrEqual(400)
    expect(tail.length).toBeLessThanOrEqual(600)
  })
  it("末 600 字内无可用段落边界:保留切片并加省略号示意截断", () => {
    const text = "灯一直亮着。".repeat(200) // 1200 字无换行
    const tail = chapterTailText(text)
    expect(tail.startsWith("……")).toBe(true)
    expect(tail.length).toBeLessThanOrEqual(602) // 600 + 省略号
  })
})
