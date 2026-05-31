/**
 * 卷舍引擎 · 风格模块 回归测试
 *
 * 锁住:① 节奏签名 sentenceLenCV 与 detectSlop.burstiness 完全同源(同一把尺,核心纪律);
 *       ② mergeStyle EMA 收敛在两值之间 + confidence 累积;③ assertNoVerbatim 拦原文(含去标点变体);
 *       ④ scoreStyleAdherence 同文高分、异文低分。
 *
 * 用例曾逼出一个真 bug:assertNoVerbatim 只去空白未去标点,改个标点即可绕过反洗稿守卫。
 */
import { describe, it, expect } from "vitest"
import {
  detectSlop,
  extractRhythm,
  computeMetrics,
  mergeStyle,
  scoreStyleAdherence,
  assertNoVerbatim,
  StyleProfile,
} from "../src/index.js"

const T = `雨。林夏盯着门。门铃又响了,第三次,固执得像在宣告一件不容拒绝的事。她没动。窗外的雨把整条街泡成一团模糊的光,远处有车碾过水洼,声音长长地拖过去,又被新的雨声盖住。她终于走过去,扭开锁。"你是谁?"她问。`

const mk = (t: string) => StyleProfile.parse({ ...computeMetrics(t, "zh"), pov: {}, confidence: 0.5 })

describe("style/metrics · 节奏同源", () => {
  it("extractRhythm.sentenceLenCV 与 detectSlop.burstiness 同源(同一把尺)", () => {
    const cv = extractRhythm(T).sentenceLenCV
    const b = Math.round(detectSlop(T).burstiness * 100) / 100
    expect(Math.abs(cv - b)).toBeLessThan(0.01)
  })
})

describe("style/merge · EMA 沉淀", () => {
  it("merged 落在 prev/next 之间;confidence 累积上升", () => {
    const p1 = mk("短句。短。短句子。")
    const p2 = mk(T)
    const m = mergeStyle(p1, p2, { alpha: 0.3 })
    const lo = Math.min(p1.rhythm.avgSentenceLen, p2.rhythm.avgSentenceLen)
    const hi = Math.max(p1.rhythm.avgSentenceLen, p2.rhythm.avgSentenceLen)
    expect(m.rhythm.avgSentenceLen).toBeGreaterThan(lo)
    expect(m.rhythm.avgSentenceLen).toBeLessThan(hi)
    expect(m.confidence).toBeGreaterThan(0.5)
  })
  it("冷启动:prev 为空原样返回 next", () => {
    const p = mk(T)
    expect(mergeStyle(undefined, p).rhythm.avgSentenceLen).toBe(p.rhythm.avgSentenceLen)
  })
})

describe("style · 反洗稿守卫 assertNoVerbatim", () => {
  it("拦住样本原文(含去标点变体);保留风格戒律", () => {
    expect(assertNoVerbatim("林夏盯着门门铃又响了第三次", T)).toBeNull() // 去标点后命中 12-gram 原文
    expect(assertNoVerbatim("句子长短交错,多用独立短句停顿", T)).not.toBeNull()
  })
})

describe("style/score · 风格契合度", () => {
  it("同文契合度明显高于风格迥异的文本", () => {
    const target = mk(T)
    const same = scoreStyleAdherence(T, target).score
    const diff = scoreStyleAdherence(
      "一个非常长的句子一直不停地延展下去没有任何停顿也没有短句一路铺陈到底让节奏变得极其单调而均匀毫无起伏可言。",
      target,
    ).score
    expect(same).toBeGreaterThan(diff)
  })
})
