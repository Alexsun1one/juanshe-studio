/**
 * 卷舍引擎 · L1 判官 schema 容错 回归测试
 *
 * 锁住真 key 实测抓到的真 bug:DeepSeek 等模型把 5 个维度直接返成"裸数字"而非 {score,note} 对象,
 * 旧 schema 严格要求对象 → reviewing 阶段 ZodError 崩掉整条流水线(status:error、无评分)。
 * 现 schema 容忍 数字 / 字符串数字 / 对象 三种形态,judge 永不因维度形态差异而失败。
 */
import { describe, it, expect } from "vitest"
import { JudgeOutput } from "../src/quality/judge.js"

describe("judge · 维度形态容错(回归:DeepSeek 裸数字崩流水线)", () => {
  it("容忍维度为裸数字(DeepSeek 实测形态)", () => {
    const p = JudgeOutput.parse({ consistency: 85, pacing: 80, emotion: 88, prose: 90, deAiTell: 82, mustFix: [] })
    expect(p.consistency.score).toBe(85)
    expect(p.prose.score).toBe(90)
    expect(p.consistency.note).toBe("")
  })

  it("容忍 {score,note} 对象 + 字符串分数 + 缺失 note", () => {
    const p = JudgeOutput.parse({
      consistency: { score: "85", note: "一致性ok" },
      pacing: { score: 70 },
      emotion: 70,
      prose: 70,
      deAiTell: 70,
    })
    expect(p.consistency.score).toBe(85)
    expect(p.consistency.note).toBe("一致性ok")
    expect(p.pacing.score).toBe(70)
    expect(p.pacing.note).toBe("")
  })

  it("分数越界自动夹到 0–100,不抛错", () => {
    const p = JudgeOutput.parse({ consistency: 120, pacing: -5, emotion: 70, prose: 70, deAiTell: 70 })
    expect(p.consistency.score).toBe(100)
    expect(p.pacing.score).toBe(0)
  })

  it("容忍中文键 / rating / value / 嵌套数字(DeepSeek 变体形态,不丢分)", () => {
    const p = JudgeOutput.parse({
      consistency: { 评分: 85, 理由: "前后一致" },
      pacing: { rating: 70 },
      emotion: { value: 66 },
      prose: { score: 90, note: "画面好" },
      deAiTell: 88,
    })
    expect(p.consistency.score).toBe(85)
    expect(p.consistency.note).toBe("前后一致")
    expect(p.pacing.score).toBe(70)
    expect(p.emotion.score).toBe(66)
    expect(p.prose.note).toBe("画面好")
  })

  it("容忍 mustFix 形态漂移(对象列表 / 中文键),不连累五维真分", () => {
    const p = JudgeOutput.parse({
      consistency: 90, pacing: 88, emotion: 85, prose: 92, deAiTell: 90,
      mustFix: [{ 建议: "第3段删空洞美文词" }, { fix: "句子长短交错" }],
    })
    expect(p.consistency.score).toBe(90)
    expect(p.mustFix).toEqual(["第3段删空洞美文词", "句子长短交错"])
  })

  it("容忍 mustFix 为单个字符串", () => {
    const p = JudgeOutput.parse({ consistency: 80, pacing: 80, emotion: 80, prose: 80, deAiTell: 80, mustFix: "改这里" })
    expect(p.mustFix).toEqual(["改这里"])
  })

  it("解包被包一层的评分({scores:{...}}),不再五维全塌成默认 60", () => {
    const p = JudgeOutput.parse({ scores: { consistency: 91, pacing: 70, emotion: 75, prose: 88, deAiTell: 80 } })
    expect(p.consistency.score).toBe(91)
    expect(p.prose.score).toBe(88)
  })
})
