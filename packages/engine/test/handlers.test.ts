/**
 * 卷舍引擎 · 阶段处理器接线回归测试
 * 锁本轮管线接线的关键行为:
 *  ① planning 用 planner-pipeline 提示词(JSON 契约),降级写 planDegraded + rationale 不再静默;
 *  ② renderPlan 把 endingHook/mustNotDo 渲染进写手指令,writing 用 LENGTH_BAND.soft 单一字数口径;
 *  ③ revising 补设定/前情/本章目标上下文,按 mustFix 类型分流 patch-only/rewrite-only 并区块剥壳;
 *  ④ polishing 走 PATCH 契约(补丁全失配回退原稿),已干净章确定性跳过不烧 token;
 *  ⑤ verifying 篇幅口径与 writing 同源(soft 触发必修 / hard 升级"严重偏离")。
 */
import { describe, it, expect } from "vitest"
import { makeHandlers, RunState, StageBudget, type LlmClient, type WriteStage } from "../src/index.js"

// 与 pipeline.test 同源的干净稿(长短交错,L0 无红旗)
const VARIED_DRAFT = `雨。林夏盯着门。门铃又响了,第三次,固执得像在宣告一件不容拒绝的事。她没动。窗外的雨把整条街泡成一团模糊的光,远处有车碾过水洼,声音长长地拖过去,又被新的雨声盖住。她终于走过去,扭开锁。门外站着一个浑身湿透的男人,手里攥着一张照片,边缘发黄卷曲,像被反复摩挲了很多年。"你是林夏?"他问,声音很轻。她点头。他把照片翻过来——背面用铅笔写着一个日期,正是她出生那天。`

interface Call { system: string; user: string; kind: "generate" | "structured" }

/** 可注脚本的桩 LLM:记录每次调用的 system/user,按序回放 replies;structured 可注入异常 */
function stubLlm(replies: string[] = [], structured: Record<string, unknown> | Error = {}) {
  const calls: Call[] = []
  let i = 0
  const llm: LlmClient = {
    async generate(o) {
      calls.push({ system: o.system, user: o.messages[0]!.content, kind: "generate" })
      return { text: replies[Math.min(i++, replies.length - 1)] ?? VARIED_DRAFT, tokens: 1 }
    },
    async generateStructured(o) {
      calls.push({ system: o.system, user: o.messages[0]!.content, kind: "structured" })
      if (structured instanceof Error) throw structured
      return { data: o.schema.parse(structured), tokens: 1 }
    },
  }
  return { llm, calls }
}

function seed(stage: WriteStage, artifacts: Record<string, unknown> = {}, targetWordCount = 1000) {
  return RunState.parse({
    runId: "r", bookId: "b", chapterNumber: 3,
    input: { genreId: "mystery", chapterTitle: "门铃", chapterGoal: "悬念开场", bookBible: "林夏:28岁,怕黑", priorContext: "上一章停在门铃响起", targetWordCount, lang: "zh" },
    stage, artifacts, startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  })
}
const ctx = (state: RunState) => ({ state, budget: StageBudget.parse({}) })
const score = (deAiTell: number, overall = 80) => ({
  overall, passThreshold: 85,
  dimensions: { consistency: overall, pacing: overall, emotion: overall, prose: overall, deAiTell },
})

describe("planning · planner-pipeline 接线与降级可见", () => {
  const PLAN = { openingHook: "雨夜门铃", beats: ["开门", "照片"], emotionArc: "警觉→震动", endingHook: "她刚拨通号码,门外脚步声停了", mustNotDo: ["禁\"不是A,而是B\"句式"] }

  it("system 用 planner-pipeline 提示词(JSON 契约),产物含 endingHook/mustNotDo", async () => {
    const { llm, calls } = stubLlm([], PLAN)
    const h = makeHandlers({ llm })
    const out = await h.planning.run(ctx(seed("planning")))
    expect(calls[0]!.system).toContain("规划师·引擎管线")
    expect(calls[0]!.system).toContain("ChapterPlan")
    const plan = (out.artifacts as { plan: { endingHook: string; mustNotDo: string[] } }).plan
    expect(plan.endingHook).toContain("拨通号码")
    expect(plan.mustNotDo).toHaveLength(1)
    expect(out.artifacts).not.toHaveProperty("planDegraded")
  })

  it("解析失败 → 最小蓝图 + planDegraded:true + rationale 写明降级(不再静默)", async () => {
    const { llm } = stubLlm([], new Error("模型输出不可解析"))
    const h = makeHandlers({ llm })
    const out = await h.planning.run(ctx(seed("planning")))
    expect(out.artifacts.planDegraded).toBe(true)
    expect(out.gate.rationale).toContain("蓝图降级")
    expect((out.artifacts as { plan: { beats: string[] } }).plan.beats).toEqual(["悬念开场"])
  })

  it("writing 把章尾定格/本章禁忌渲染给写手,字数指令用 soft 区间(850–1150)", async () => {
    const { llm, calls } = stubLlm([VARIED_DRAFT])
    const h = makeHandlers({ llm })
    await h.writing.run(ctx(seed("writing", { planning: { plan: PLAN } })))
    expect(calls[0]!.user).toContain("章尾定格")
    expect(calls[0]!.user).toContain("本章禁忌")
    expect(calls[0]!.user).toContain("850–1150 字")
  })
})

describe("revising · 上下文注入 + 修法分流 + 区块剥壳", () => {
  it("patch-only:全局部问题 → 声明 patch-only,补丁应用、FIXED_ISSUES 不混进正文", async () => {
    const reply = [
      "=== FIXED_ISSUES ===",
      "第1条:删掉了套话",
      "=== PATCHES ===",
      "--- PATCH 1 ---\nTARGET_TEXT:\n她没动。\nREPLACEMENT_TEXT:\n她数到第三声才动。\n--- END PATCH ---",
    ].join("\n")
    const { llm, calls } = stubLlm([reply])
    const h = makeHandlers({ llm })
    const state = seed("revising", { writing: { draft: VARIED_DRAFT }, reviewing: { mustFix: ["套话过多,删空洞美文词"] } })
    const out = await h.revising.run(ctx(state))
    expect(calls[0]!.user).toContain("patch-only")
    // 修稿师不再裸奔:设定/前情/本章目标与 writing 同构注入
    expect(calls[0]!.user).toContain("设定(修复不得与之矛盾)")
    expect(calls[0]!.user).toContain("前情:")
    expect(calls[0]!.user).toContain("本章目标:")
    const draft = out.artifacts.draft as string
    expect(draft).toContain("她数到第三声才动。")
    expect(draft).not.toContain("FIXED_ISSUES")
    expect(out.artifacts.appliedPatchCount).toBe(1)
    expect(out.artifacts.fixedIssues).toEqual(["第1条:删掉了套话"])
  })

  it("rewrite-only:含结构问题 → 声明 rewrite-only,取 REVISED_CONTENT 剥掉 UPDATED_* 区块", async () => {
    const reply = [
      "=== FIXED_ISSUES ===",
      "第1条:补了动机",
      "=== REVISED_CONTENT ===",
      "修订后的完整正文,补上了她的利害关系。",
      "=== UPDATED_STATE ===",
      "状态卡内容",
    ].join("\n")
    const { llm, calls } = stubLlm([reply])
    const h = makeHandlers({ llm })
    const state = seed("revising", { writing: { draft: VARIED_DRAFT }, reviewing: { mustFix: ["配角动机断了,补一句她的利害关系"] } })
    const out = await h.revising.run(ctx(state))
    expect(calls[0]!.user).toContain("rewrite-only")
    expect(out.artifacts.draft).toBe("修订后的完整正文,补上了她的利害关系。")
  })

  it("补丁全失配 → 回退原稿并标记 patchFallback;无区块输出 → 整段视为修订正文(旧契约兜底)", async () => {
    const miss = "=== PATCHES ===\n--- PATCH 1 ---\nTARGET_TEXT:\n完全对不上的片段\nREPLACEMENT_TEXT:\nx\n--- END PATCH ---"
    const { llm } = stubLlm([miss])
    const h = makeHandlers({ llm })
    const state = seed("revising", { writing: { draft: VARIED_DRAFT }, reviewing: { mustFix: ["措辞啰嗦"] } })
    const out = await h.revising.run(ctx(state))
    expect(out.artifacts.draft).toBe(VARIED_DRAFT)
    expect(out.artifacts.patchFallback).toBe(true)

    const { llm: llm2 } = stubLlm(["直接给的修订正文。"])
    const out2 = await makeHandlers({ llm: llm2 }).revising.run(ctx(state))
    expect(out2.artifacts.draft).toBe("直接给的修订正文。")
  })
})

describe("polishing · PATCH 契约 + 确定性跳过门", () => {
  it("已达标(deAiTell≥90 且 L0 干净)→ 直通跳过,不烧 token", async () => {
    const { llm, calls } = stubLlm()
    const h = makeHandlers({ llm })
    const state = seed("polishing", { writing: { draft: VARIED_DRAFT }, reviewing: { score: score(95, 90) } })
    const out = await h.polishing.run(ctx(state))
    expect(out.artifacts.skipped).toBe(true)
    expect(out.artifacts.draft).toBe(VARIED_DRAFT)
    expect(calls).toHaveLength(0)
  })

  it("未达标 → 按 PATCH 模式下指令,应用补丁并记录 polisherNotes", async () => {
    const reply = [
      "=== PATCHES ===",
      "--- PATCH 1 ---\nTARGET_TEXT:\n她没动。\nREPLACEMENT_TEXT:\n她数到第三声才动。\n--- END PATCH ---",
      "[polisher-note] 第三段疑似伏笔缺口",
    ].join("\n")
    const { llm, calls } = stubLlm([reply])
    const h = makeHandlers({ llm })
    const state = seed("polishing", { writing: { draft: VARIED_DRAFT }, reviewing: { score: score(70) } })
    const out = await h.polishing.run(ctx(state))
    expect(calls[0]!.user).toContain("PATCH 模式")
    expect(out.artifacts.draft).toContain("她数到第三声才动。")
    expect(out.artifacts.appliedPatchCount).toBe(1)
    expect(out.artifacts.polisherNotes).toEqual(["第三段疑似伏笔缺口"])
  })

  it("补丁全失配 → 回退原稿(绝不把补丁文本当 draft);违约整章正文 → 降级接受并标记", async () => {
    const miss = "=== PATCHES ===\n--- PATCH 1 ---\nTARGET_TEXT:\n完全对不上的片段\nREPLACEMENT_TEXT:\nx\n--- END PATCH ---"
    const state = seed("polishing", { writing: { draft: VARIED_DRAFT }, reviewing: { score: score(70) } })
    const out = await makeHandlers({ llm: stubLlm([miss]).llm }).polishing.run(ctx(state))
    expect(out.artifacts.draft).toBe(VARIED_DRAFT)
    expect(out.artifacts.patchFallback).toBe(true)

    const rewrite = VARIED_DRAFT.replace("她没动。", "她数到第三声才动。")
    const out2 = await makeHandlers({ llm: stubLlm([rewrite]).llm }).polishing.run(ctx(state))
    expect(out2.artifacts.draft).toBe(rewrite)
    expect(out2.artifacts.fellBackToRewrite).toBe(true)
  })
})

describe("verifying · 篇幅口径与 writing 同源(soft 触发 / hard 升级)", () => {
  // 判官桩:五维 92 分,确保篇幅是唯一变量
  const JUDGE = {
    consistency: { score: 92, note: "" }, pacing: { score: 92, note: "" }, emotion: { score: 92, note: "" },
    prose: { score: 92, note: "" }, deAiTell: { score: 92, note: "" }, mustFix: [],
  }
  const run = async (targetWordCount: number) => {
    const { llm } = stubLlm([], JUDGE)
    const h = makeHandlers({ llm })
    return h.verifying.run(ctx(seed("verifying", { writing: { draft: VARIED_DRAFT } }, targetWordCount))) // 稿长约 156 字
  }

  it("落在 soft 区间 → 不触发篇幅必修", async () => {
    const out = await run(150) // 156/150 ≈ 1.04
    expect((out.gate.mustFix ?? []).some((m) => m.includes("篇幅"))).toBe(false)
  })
  it("出 soft 未出 hard → 「篇幅偏离」必修", async () => {
    const out = await run(120) // 156/120 = 1.3
    expect(out.gate.verdict).toBe("revise")
    expect((out.gate.mustFix ?? []).some((m) => m.includes("篇幅偏离") && !m.includes("严重"))).toBe(true)
  })
  it("出 hard 区间 → 措辞升级为「严重偏离」", async () => {
    const out = await run(100) // 156/100 = 1.56 > 1.4
    expect((out.gate.mustFix ?? []).some((m) => m.includes("篇幅严重偏离"))).toBe(true)
  })
})
