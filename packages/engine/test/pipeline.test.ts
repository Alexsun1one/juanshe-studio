/**
 * 卷舍引擎 · 编排 + 质量 回归测试
 *
 * 用桩 LlmClient(零 SDK 依赖)把状态机跑通,锁住两类关键行为:
 *  ① 过线即签发(happy);② 持续低分 → 返修触上限优雅硬停(不无限回环、不误报 completed)。
 * 外加 nextStage 纯函数转移 + L0 检测 + L1 判官 L0 否决 的单元断言。
 *
 * 这两个集成用例曾逼出两个真 bug:reviseRound 在 pass 时被错误重置、触上限被误判为 completed。
 */
import { describe, it, expect } from "vitest"
import {
  makeHandlers,
  runPipeline,
  StageBudget,
  RunState,
  nextStage,
  detectSlop,
  judgeChapter,
  type LlmClient,
} from "../src/index.js"

const VARIED_DRAFT = `雨。林夏盯着门。门铃又响了,第三次,固执得像在宣告一件不容拒绝的事。她没动。窗外的雨把整条街泡成一团模糊的光,远处有车碾过水洼,声音长长地拖过去,又被新的雨声盖住。她终于走过去,扭开锁。门外站着一个浑身湿透的男人,手里攥着一张照片,边缘发黄卷曲,像被反复摩挲了很多年。"你是林夏?"他问,声音很轻。她点头。他把照片翻过来——背面用铅笔写着一个日期,正是她出生那天。`

// 句长高度均匀的 AI 腔文本(用于 L0 红旗断言)
const UNIFORM_DRAFT = Array.from({ length: 10 }, (_, i) => `这是第${i + 1}个长度大致相同的句子用来测试均匀节奏的检测能力`).join("。") + "。"

function fakeLlm(score: number, mustFix: string[] = []): LlmClient {
  return {
    async generate(o) {
      if (o.onToken) for (const c of VARIED_DRAFT) o.onToken(c)
      return { text: VARIED_DRAFT, tokens: 100 }
    },
    async generateStructured(o) {
      const superset = {
        openingHook: "雨夜门铃", povCharacter: "林夏",
        beats: ["门铃", "来客", "照片", "谜"], emotionArc: "警觉→震动",
        foreshadowPlant: ["日期"], foreshadowPayoff: [],
        consistency: { score, note: "" }, pacing: { score, note: "" },
        emotion: { score, note: "" }, prose: { score, note: "" },
        deAiTell: { score, note: "" }, mustFix,
      }
      return { data: o.schema.parse(superset), tokens: 50 }
    },
  }
}

function seed() {
  return RunState.parse({
    runId: "r", bookId: "b", chapterNumber: 1,
    input: { genreId: "mystery", platformId: "webnovel", chapterTitle: "门铃", chapterGoal: "悬念开场", targetWordCount: 150, lang: "zh" },
    stage: "planning", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  })
}
const fixedDeps = (llm: LlmClient, maxReviseRounds = 2) => ({
  handlers: makeHandlers({ llm, passThreshold: 85 }),
  budget: StageBudget.parse({ maxReviseRounds }),
  now: () => "2026-01-01T00:00:00Z",
  delay: async () => {},
})

describe("runPipeline 集成", () => {
  it("过线 → 走完 7 阶段并签发", async () => {
    const out = await runPipeline(seed(), fixedDeps(fakeLlm(88)))
    expect(out.status).toBe("completed")
    const ch = (out.state.artifacts.publishing as any)?.chapter
    expect(ch).toBeTruthy()
    expect(ch.quality.overall).toBeGreaterThanOrEqual(85)
    expect(ch.content.length).toBeGreaterThan(0)
  })

  it("持续低分 → 返修触上限,优雅硬停(有界、不签发、不误报 completed)", async () => {
    const out = await runPipeline(seed(), fixedDeps(fakeLlm(76, ["情感再深一点"])))
    expect(out.status).toBe("halted")
    expect(out.state.artifacts.publishing).toBeUndefined()
    // 远小于 HARD_STEP_CAP(64):证明不是靠硬保险丝兜底
    expect(out.state.reviseRound).toBeLessThanOrEqual(2)
  })
})

describe("nextStage 纯函数转移", () => {
  const b = StageBudget.parse({ maxReviseRounds: 2 })
  it("pass 前进且不重置 reviseRound", () => {
    const r = nextStage("revising", { verdict: "pass", mustFix: [] }, 1, b, [80])
    expect(r.stage).toBe("polishing")
    expect(r.reviseRound).toBe(1)
  })
  it("revise → 回 revising 且 +1", () => {
    const r = nextStage("reviewing", { verdict: "revise", mustFix: ["x"] }, 0, b, [70])
    expect(r.stage).toBe("revising")
    expect(r.reviseRound).toBe(1)
  })
  it("regenerate → 回 writing", () => {
    expect(nextStage("reviewing", { verdict: "regenerate", mustFix: [] }, 0, b, [50]).stage).toBe("writing")
  })
  it("触返修上限 → done", () => {
    expect(nextStage("verifying", { verdict: "revise", mustFix: [] }, 2, b, [76, 76]).stage).toBe("done")
  })
  it("两个同源(verifying)分不再上升 → done(防越改越差)", () => {
    // scoreHistory 形如 [reviewing分, verify1, verify2…];length>=3 才是两个 verifying 分相比
    expect(nextStage("verifying", { verdict: "revise", mustFix: [] }, 1, b, [85, 80, 72]).stage).toBe("done")
  })
  it("首次 verify 返修不被跨视角误判 halt(reviewing分 vs verifying分 不算非单调)", () => {
    // [reviewing 80, verifying 72]:不同评估视角,不应据此提前 halt,应给 verify→revise 一次机会
    expect(nextStage("verifying", { verdict: "revise", mustFix: ["x"] }, 1, b, [80, 72]).stage).toBe("revising")
  })
})

describe("质量检测", () => {
  it("L0:均匀句长被标红旗,长短交错的文本干净", () => {
    expect(detectSlop(UNIFORM_DRAFT).redFlags.length).toBeGreaterThan(0)
    expect(detectSlop(VARIED_DRAFT).uniformSentences).toBe(false)
  })
  it("L1:判官给的高 deAiTell 被 L0 否决压低(均匀文本)", async () => {
    // 判官嘴上给 95,但文本句长均匀 → L0 否决,deAiTell 必须被压下来
    const r = await judgeChapter(UNIFORM_DRAFT, fakeLlm(95), { passThreshold: 85 })
    expect(r.score.dimensions.deAiTell).toBeLessThan(95)
    expect(r.mustFix.some((m) => m.includes("句长") || m.includes("套话"))).toBe(true)
  })
})
