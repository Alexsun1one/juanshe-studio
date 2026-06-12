/**
 * 卷舍引擎 · 读者评审官第二信号回归测试(reviewing/verifying 接入)
 * 锁三条核心行为:
 *  ① 成本闸门:judge overall 落边缘带 [70,95] 才加跑 reader-critic;
 *     高分明显过 / 低分明显挂 / 开关关闭(readerCritic:false)都不跑,不烧 token;
 *  ② 解析失败静默降级:artifacts 只留 {degraded:true} 标记,judge 门禁原样走,不混入读者必修;
 *  ③ 弃书票 drop:弃书点带「读者评审官:」前缀追加进 mustFix + rationale 带一句,
 *     judge 分数与 verdict 一概不动(不改分数、不动门禁阈值);
 * 附带锁:userTemplate 渲染接线(章号/正文/本章备忘/上章钩子)与 snake_case/裸数字容错解析。
 */
import { describe, it, expect } from "vitest"
import { makeHandlers, RunState, StageBudget, type LlmClient, type WriteStage } from "../src/index.js"

// 与 handlers.test 同源的干净稿(长短交错,L0 无红旗,约 156 字)
const VARIED_DRAFT = `雨。林夏盯着门。门铃又响了,第三次,固执得像在宣告一件不容拒绝的事。她没动。窗外的雨把整条街泡成一团模糊的光,远处有车碾过水洼,声音长长地拖过去,又被新的雨声盖住。她终于走过去,扭开锁。门外站着一个浑身湿透的男人,手里攥着一张照片,边缘发黄卷曲,像被反复摩挲了很多年。"你是林夏?"他问,声音很轻。她点头。他把照片翻过来——背面用铅笔写着一个日期,正是她出生那天。`

interface Call { system: string; user: string; tier?: string }

/** 双信号桩 LLM:按 system 提示词分流——判官回 judge 载荷,读者评审官回 reader 载荷(可注异常) */
function stubLlm(judge: Record<string, unknown>, reader?: Record<string, unknown> | Error) {
  const calls: Call[] = []
  const llm: LlmClient = {
    async generate(o) {
      calls.push({ system: o.system, user: o.messages[0]!.content })
      return { text: VARIED_DRAFT, tokens: 1 }
    },
    async generateStructured(o) {
      calls.push({ system: o.system, user: o.messages[0]!.content, tier: o.modelTier })
      const isReader = o.system.includes("读者评审官")
      const payload = isReader ? reader : judge
      if (payload instanceof Error) throw payload
      return { data: o.schema.parse(payload), tokens: 1 }
    },
  }
  const readerCalls = () => calls.filter((c) => c.system.includes("读者评审官"))
  return { llm, calls, readerCalls }
}

function seed(stage: WriteStage, targetWordCount = 150) {
  return RunState.parse({
    runId: "r", bookId: "b", chapterNumber: 3,
    input: { genreId: "mystery", chapterTitle: "门铃", chapterGoal: "悬念开场", bookBible: "林夏:28岁,怕黑", priorContext: "上一章停在门铃响起", targetWordCount, lang: "zh" },
    stage, artifacts: { writing: { draft: VARIED_DRAFT } },
    startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  })
}
const ctx = (state: RunState) => ({ state, budget: StageBudget.parse({}) })

/** 判官桩载荷:五维同分,使 overall 可控(weights 之和为 1) */
const judgeAt = (score: number, mustFix: string[] = []) => ({
  consistency: { score, note: "" }, pacing: { score, note: "" }, emotion: { score, note: "" },
  prose: { score, note: "" }, deAiTell: { score, note: "" }, mustFix,
})

const READER_NEXT = {
  immersion: { score: 8, notes: "开门那段把我拽住了" },
  anticipation: { score: 9, notes: "照片日期这个钩子很狠" },
  motivation: { score: 8, notes: "她的迟疑读得懂" },
  emotional: { score: 8, notes: "照片翻过来那下心头一紧" },
  wouldContinue: "next",
  readerVoice: "我看完直接想点下一章,那个日期到底什么意思。",
  painPoints: [],
}
const READER_DROP = {
  immersion: { score: 4, notes: "中段大段环境描写,我跳读了" },
  anticipation: { score: 3, notes: "章末平稳收尾,没有钩子" },
  motivation: { score: 6, notes: "开门动机还行" },
  emotional: { score: 5, notes: "没有戳到我的点" },
  wouldContinue: "drop",
  readerVoice: "我读到一半就想退出去刷别的了。",
  painPoints: ["中段三段环境描写整段删掉,信息并进开门的动作", "章末加一个具体反常细节收尾,别平稳落地"],
}

describe("读者评审官 · 成本闸门(边缘带才触发)", () => {
  it("reviewing:judge 落边缘带 → 加跑一次 fast 读者评审,verdict 入 artifacts(含派生 overall/verdict),不动门禁", async () => {
    const { llm, readerCalls } = stubLlm(judgeAt(85), READER_NEXT)
    const out = await makeHandlers({ llm }).reviewing.run(ctx(seed("reviewing")))
    const rcalls = readerCalls()
    expect(rcalls).toHaveLength(1)
    expect(rcalls[0]!.tier).toBe("fast") // 第二信号只配快模型
    // userTemplate 渲染接线:章号/正文/本章备忘(chapterGoal)/上章钩子(priorContext)都进了 user
    expect(rcalls[0]!.user).toContain("第 3 章正文")
    expect(rcalls[0]!.user).toContain("林夏")
    expect(rcalls[0]!.user).toContain("悬念开场")
    expect(rcalls[0]!.user).toContain("上一章停在门铃响起")
    const rc = out.artifacts.readerCritic as { wouldContinue: string; overall: number; verdict: string }
    expect(rc.wouldContinue).toBe("next")
    expect(rc.overall).toBe(8.3) // (8+9+8+8)/4 = 8.25 → round1 8.3
    expect(rc.verdict).toBe("pass")
    // 非弃书票:不追加必修、rationale 不带读者句、judge verdict 原样
    expect((out.gate.mustFix ?? []).some((m) => m.startsWith("读者评审官"))).toBe(false)
    expect(out.gate.rationale ?? "").not.toContain("读者评审官")
    expect(out.gate.verdict).toBe("pass")
  })

  it("高分明显过(>95)/ 低分明显挂(<70)/ 开关关闭 → 一律不跑,不浪费 token", async () => {
    const high = stubLlm(judgeAt(100), READER_NEXT)
    await makeHandlers({ llm: high.llm }).reviewing.run(ctx(seed("reviewing")))
    expect(high.readerCalls()).toHaveLength(0)

    const low = stubLlm(judgeAt(60), READER_NEXT)
    const outLow = await makeHandlers({ llm: low.llm }).reviewing.run(ctx(seed("reviewing")))
    expect(low.readerCalls()).toHaveLength(0)
    expect(outLow.artifacts).not.toHaveProperty("readerCritic")

    const off = stubLlm(judgeAt(85), READER_NEXT)
    const outOff = await makeHandlers({ llm: off.llm, readerCritic: false }).reviewing.run(ctx(seed("reviewing")))
    expect(off.readerCalls()).toHaveLength(0)
    expect(outOff.artifacts).not.toHaveProperty("readerCritic")
  })
})

describe("读者评审官 · 解析失败静默降级(不阻塞管线)", () => {
  it("评审拒答/不可解析 → artifacts 只留 degraded 标记,judge 门禁原样走,不混入读者必修", async () => {
    const { llm, readerCalls } = stubLlm(judgeAt(80, ["判官:开篇钩子不够狠"]), new Error("模型输出不可解析"))
    const out = await makeHandlers({ llm }).reviewing.run(ctx(seed("reviewing")))
    expect(readerCalls()).toHaveLength(1) // 真跑了,只是解析失败
    expect(out.artifacts.readerCritic).toEqual({ degraded: true })
    expect(out.gate.verdict).toBe("revise") // 80 < 85 → judge 自己的折算,不受降级影响
    expect(out.gate.mustFix).toContain("判官:开篇钩子不够狠")
    expect((out.gate.mustFix ?? []).some((m) => m.startsWith("读者评审官"))).toBe(false)
    expect(out.gate.rationale ?? "").not.toContain("读者评审官")
  })
})

describe("读者评审官 · 弃书票进必修(不改分数与门禁阈值)", () => {
  it("reviewing:drop → painPoints 带前缀进 mustFix、rationale 带一句;judge 分数与 verdict 不动", async () => {
    const { llm } = stubLlm(judgeAt(88, ["判官:配角台词同腔"]), READER_DROP)
    const out = await makeHandlers({ llm }).reviewing.run(ctx(seed("reviewing")))
    // 弃书点逐条带「读者评审官:」前缀,排在 judge 必修之后
    expect(out.gate.mustFix).toContain("读者评审官:中段三段环境描写整段删掉,信息并进开门的动作")
    expect(out.gate.mustFix).toContain("读者评审官:章末加一个具体反常细节收尾,别平稳落地")
    expect(out.gate.mustFix![0]).toBe("判官:配角台词同腔")
    expect(out.gate.rationale).toContain("读者评审官判弃书")
    // 不改分数与门禁阈值:88 ≥ 85 → verdict 仍是 pass(弃书点交给后续 revising 消费)
    expect(out.gate.verdict).toBe("pass")
    expect(out.gate.score?.overall).toBe(88)
    const rc = out.artifacts.readerCritic as { overall: number; verdict: string }
    expect(rc.overall).toBe(4.5)
    expect(rc.verdict).toBe("needs-revise")
  })

  it("verifying 同样接入:drop 弃书点进终审必修;snake_case/裸数字容错;painPoints 空时用读者原话兜底", async () => {
    const snakeReader = {
      immersion: 4, // 裸数字容错
      anticipation: { score: "3", notes: "章末平稳收尾" }, // 字符串分容错
      motivation: { score: 6, notes: "" },
      emotional: { score: 5, notes: "" },
      would_continue: "drop", // snake_case 容错
      reader_voice: "我读到一半就想退出去刷别的了。",
      pain_points: [],
    }
    const { llm, readerCalls } = stubLlm(judgeAt(80), snakeReader)
    const out = await makeHandlers({ llm }).verifying.run(ctx(seed("verifying", 150))) // 篇幅落 soft 区间
    expect(readerCalls()).toHaveLength(1)
    const rc = out.artifacts.readerCritic as { wouldContinue: string; overall: number }
    expect(rc.wouldContinue).toBe("drop")
    expect(rc.overall).toBe(4.5)
    // painPoints 空 → 用读者原话兜底一条,仍带前缀
    expect((out.gate.mustFix ?? []).some((m) => m.startsWith("读者评审官:") && m.includes("我读到一半就想退出去刷别的了"))).toBe(true)
    expect(out.gate.rationale).toContain("读者评审官判弃书")
    expect(out.gate.verdict).toBe("revise") // 仍由 judge 分(80<85)+ 篇幅决定,读者票不参与折算
  })

  it("verifying:边缘带外(judge 96+)不跑,终审行为与接入前完全一致", async () => {
    const { llm, readerCalls } = stubLlm(judgeAt(100), READER_DROP)
    const out = await makeHandlers({ llm }).verifying.run(ctx(seed("verifying", 150)))
    expect(readerCalls()).toHaveLength(0)
    expect(out.artifacts).not.toHaveProperty("readerCritic")
    expect(out.gate.verdict).toBe("pass")
  })
})
