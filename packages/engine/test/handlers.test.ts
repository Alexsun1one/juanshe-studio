/**
 * 卷舍引擎 · 阶段处理器接线回归测试
 * 锁本轮管线接线的关键行为:
 *  ① planning 用 planner-pipeline 提示词(JSON 契约),降级写 planDegraded + rationale 不再静默;
 *  ② renderPlan 把 endingHook/mustNotDo 渲染进写手指令,writing 用 LENGTH_BAND.soft 单一字数口径;
 *  ③ revising 补设定/前情/本章目标上下文,按 mustFix 类型分流 patch-only/rewrite-only 并区块剥壳;
 *  ④ polishing 走 PATCH 契约(补丁全失配回退原稿),跳过门三态:全干净直通不烧 token、
 *     无红旗但 warning≥阈值走轻量 PATCH 只修点名处(警告档清单进指令,绝不整章重写)、
 *     有红旗正常润色(红旗 + 警告档清单同构渲染);
 *  ⑤ verifying 篇幅口径与 writing 同源(soft 触发必修 / hard 升级"严重偏离");
 *  ⑥ 风格指纹软接线:≥3 章成稿 extract+merge 提炼指纹注入写手,verifying 用同一份算契合度,
 *     只观测(artifacts + rationale)不改 verdict;不足 3 章保持现状空槽。
 */
import { describe, it, expect } from "vitest"
import { makeHandlers, RunState, StageBudget, StyleProfile, computeMetrics, type LlmClient, type WriteStage } from "../src/index.js"

// 与 pipeline.test 同源的干净稿(长短交错,L0 无红旗)
const VARIED_DRAFT = `雨。林夏盯着门。门铃又响了,第三次,固执得像在宣告一件不容拒绝的事。她没动。窗外的雨把整条街泡成一团模糊的光,远处有车碾过水洼,声音长长地拖过去,又被新的雨声盖住。她终于走过去,扭开锁。门外站着一个浑身湿透的男人,手里攥着一张照片,边缘发黄卷曲,像被反复摩挲了很多年。"你是林夏?"他问,声音很轻。她点头。他把照片翻过来——背面用铅笔写着一个日期,正是她出生那天。`

// warning 档样本:三处禁用句式全落在对白引号内(各加权 0.5 < redAt)→ 只进 warnings,不进 redFlags
const WARNING_DIALOGUE = `他靠在门框上,半天没说话,屋里只剩雨声。「这不是钱的事,而是脸面。」她说完就笑了。「你笑得仿佛年画娃娃一样。」他不接话,转身去关窗。「她回来了,带着一身潮气。」`
const WARNING_DRAFT = `${VARIED_DRAFT}\n${WARNING_DIALOGUE}`
// 红旗样本:同句式落在对白外(加权 1 ≥ redAt)→ 直接进 redFlags
const RED_DRAFT = `${VARIED_DRAFT}\n这不是巧合,而是有人安排好的局。`
// 红旗 + 警告并存(对白内的明喻/逗号拖尾仍是警告档)
const MIXED_DRAFT = `${RED_DRAFT}\n${WARNING_DIALOGUE}`

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

function seed(stage: WriteStage, artifacts: Record<string, unknown> = {}, targetWordCount = 1000, inputExtra: Record<string, unknown> = {}) {
  return RunState.parse({
    runId: "r", bookId: "b", chapterNumber: 3,
    input: { genreId: "mystery", chapterTitle: "门铃", chapterGoal: "悬念开场", bookBible: "林夏:28岁,怕黑", priorContext: "上一章停在门铃响起", targetWordCount, lang: "zh", ...inputExtra },
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

  it("警告档进指令:与红旗同构渲染成定点打击清单(含原句片段,标注顺手修),不触发整章重写", async () => {
    const { llm, calls } = stubLlm(["=== PATCHES ==="])
    const h = makeHandlers({ llm })
    // 红旗 + 警告并存,deAiTell 不达标 → 正常润色路径,两份清单都要在指令里
    const state = seed("polishing", { writing: { draft: MIXED_DRAFT }, reviewing: { score: score(70) } })
    const out = await h.polishing.run(ctx(state))
    const user = calls[0]!.user
    expect(user).toContain("L0 确定性检测命中") // 红旗清单仍在
    expect(user).toContain("警告档:顺手修,无需大动") // 警告档清单同构渲染
    expect(user).toContain("仿佛年画娃娃一样") // bannedPatternDetail 摘出的警告档原句片段进了指令
    expect(user).toContain("PATCH 模式") // 仍是定点补丁,警告档绝不触发整章重写
    expect(user).toContain("绝不返回整章正文")
    expect(out.artifacts.draft).toBe(MIXED_DRAFT) // 空补丁 → 原稿原样保留
    expect(out.artifacts.lightPatch).toBeUndefined() // 有红旗 → 不是轻量档
  })

  it("跳过门三态①全干净(deAiTell≥90 且警告<3)→ 仍直通跳过", async () => {
    const { llm, calls } = stubLlm()
    const out = await makeHandlers({ llm }).polishing.run(
      ctx(seed("polishing", { writing: { draft: VARIED_DRAFT }, reviewing: { score: score(95, 90) } })),
    )
    expect(out.artifacts.skipped).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it("跳过门三态②无红旗但警告≥3 → 不再直通,走轻量 PATCH 只修点名处", async () => {
    const reply = "=== PATCHES ===\n--- PATCH 1 ---\nTARGET_TEXT:\n「你笑得仿佛年画娃娃一样。」\nREPLACEMENT_TEXT:\n「你笑什么。」\n--- END PATCH ---"
    const { llm, calls } = stubLlm([reply])
    const state = seed("polishing", { writing: { draft: WARNING_DRAFT }, reviewing: { score: score(95, 90) } })
    const out = await makeHandlers({ llm }).polishing.run(ctx(state))
    expect(out.artifacts.skipped).toBeUndefined() // 不直通
    expect(calls).toHaveLength(1) // 但只跑一次轻量润色
    const user = calls[0]!.user
    expect(user).toContain("轻量定点润色")
    expect(user).toContain("只修上面警告档点名处")
    expect(user).toContain("警告档:顺手修,无需大动")
    expect(user).not.toContain("L0 确定性检测命中") // 无红旗 → 没有红旗清单
    expect(out.artifacts.lightPatch).toBe(true)
    expect(out.artifacts.draft).toContain("「你笑什么。」") // 补丁正常应用
    expect(out.artifacts.appliedPatchCount).toBe(1)
  })

  it("跳过门三态③有红旗 → 即使 deAiTell≥90 也走正常润色(红旗优先于警告分层)", async () => {
    const { llm, calls } = stubLlm(["=== PATCHES ==="])
    const state = seed("polishing", { writing: { draft: RED_DRAFT }, reviewing: { score: score(95, 90) } })
    const out = await makeHandlers({ llm }).polishing.run(ctx(state))
    expect(out.artifacts.skipped).toBeUndefined()
    expect(out.artifacts.lightPatch).toBeUndefined()
    const user = calls[0]!.user
    expect(user).toContain("L0 确定性检测命中")
    expect(user).toContain("文字层精修") // 正常档,不是轻量档
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

describe("风格指纹软接线 · 提炼→注入→评分(观察期,不进硬门禁)", () => {
  // extractStyle 的 LLM 补全桩(stubLlm 对每次 structured 调用回放同一对象)
  const ADDENDUM = {
    pov: { person: "third-limited", tense: "past", interiorityRatio: 0.2 },
    motifs: ["以雨写孤独"],
    descriptors: ["句子长短交错,多用独立短句停顿"],
  }
  const SAMPLES = [VARIED_DRAFT, VARIED_DRAFT.replace("林夏", "苏棠"), VARIED_DRAFT.replace("门铃", "电话")]
  // 判官桩:五维 92 分,确保风格观测是唯一变量
  const JUDGE92 = {
    consistency: { score: 92, note: "" }, pacing: { score: 92, note: "" }, emotion: { score: 92, note: "" },
    prose: { score: 92, note: "" }, deAiTell: { score: 92, note: "" }, mustFix: [],
  }

  it("writing:≥3 章成稿 → 逐章 extract+merge 提炼指纹注入写手提示词,profile 存 artifacts 供 verifying 复用", async () => {
    const { llm, calls } = stubLlm([VARIED_DRAFT], ADDENDUM)
    const h = makeHandlers({ llm })
    const out = await h.writing.run(ctx(seed("writing", {}, 1000, { styleSamples: SAMPLES })))
    expect(calls.filter((c) => c.kind === "structured")).toHaveLength(3) // 每个样本一次 extractStyle 补全
    const writerCall = calls.find((c) => c.kind === "generate")!
    expect(writerCall.system).toContain("本作文风指纹") // renderStyleProfile 经 assemble 唯一缝注入
    expect(writerCall.system).toContain("句子长短交错,多用独立短句停顿")
    const profile = (out.artifacts as { styleProfile?: StyleProfile }).styleProfile
    expect(profile?.sampleStats.mergedSamples).toBe(3) // mergeStyle EMA 折叠了全部 3 个样本
  })

  it("writing:不足 3 章成稿 → 不提炼、不注入、不烧 token(空槽保持现状)", async () => {
    const { llm, calls } = stubLlm([VARIED_DRAFT], ADDENDUM)
    const out = await makeHandlers({ llm }).writing.run(ctx(seed("writing", {}, 1000, { styleSamples: SAMPLES.slice(0, 2) })))
    expect(calls.filter((c) => c.kind === "structured")).toHaveLength(0)
    expect(calls[0]!.system).not.toContain("本作文风指纹")
    expect(out.artifacts).not.toHaveProperty("styleProfile")
  })

  it("verifying:对 draft 与同一份指纹算契合度 → styleAdherence 入 artifacts、rationale 带一句,不改 verdict、不混入门禁必修", async () => {
    const target = StyleProfile.parse({ ...computeMetrics(VARIED_DRAFT, "zh"), pov: {}, confidence: 0.5 })
    const { llm } = stubLlm([], JUDGE92)
    const h = makeHandlers({ llm })
    const state = seed("verifying", { writing: { draft: VARIED_DRAFT, styleProfile: target } }, 150) // 篇幅落 soft 区间
    const out = await h.verifying.run(ctx(state))
    const sa = (out.artifacts as { styleAdherence?: { score: number; deviations: unknown[] } }).styleAdherence
    expect(sa?.score).toBeGreaterThan(80) // 同文对同源指纹应高契合
    expect(out.gate.verdict).toBe("pass") // 观察期:风格不进 verdict
    expect(out.gate.rationale).toContain("风格契合")
    expect(out.gate.mustFix ?? []).toHaveLength(0) // 风格 mustFix 不混入门禁必修流
  })

  it("verifying:无指纹(前几章 / 旧 RunState)→ 不产 styleAdherence,rationale 不带风格(现状不变)", async () => {
    const { llm } = stubLlm([], JUDGE92)
    const out = await makeHandlers({ llm }).verifying.run(ctx(seed("verifying", { writing: { draft: VARIED_DRAFT } }, 150)))
    expect(out.artifacts).not.toHaveProperty("styleAdherence")
    expect(out.gate.rationale ?? "").not.toContain("风格契合")
  })
})
