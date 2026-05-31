/**
 * 卷舍引擎 · L0 去AI味预门禁 回归测试(pregate)
 *
 * 锁住新增的 telling-not-showing(直接命名情绪)机检——小说去AI味的核心工艺之一:
 *   ① 句句"感到/涌起+情绪词"的报情绪文 → tellingEmotionHits 高 + 触发 redFlag;
 *   ② 用动作/生理/感官演出来的展示文 → 不误判(零命中、不打回);
 *   ③ slopPenalty 随 telling 命中升高(报情绪 > 演情绪)。
 */
import { describe, it, expect } from "vitest"
import { detectSlop, slopPenalty } from "../src/quality/pregate.js"

// 报情绪(telling):句句把情绪当结论说出来
const TELLING = `他感到一阵恐惧。她心中涌起愤怒。内心升起一股绝望。心头泛起一丝悲伤。他又感到深深的不安。`

// 演情绪(showing):同样的张力,用动作/生理/感官写,不点破情绪
const SHOWING = `他的手停在门把上,没拧动。她把茶杯放下,瓷底磕在桌面,响了一声。他后退半步,脊背贴上墙,墙皮的凉透过衬衫渗进来。她别过脸,睫毛上挂着没落下来的东西,喉咙动了动,到底什么也没说。`

describe("pregate · telling-not-showing 机检", () => {
  it("报情绪文命中 tellingEmotionHits 并触发 redFlag", () => {
    const s = detectSlop(TELLING)
    expect(s.tellingEmotionHits).toBeGreaterThanOrEqual(4)
    expect(s.redFlags.some((f) => f.includes("命名情绪"))).toBe(true)
  })

  it("演情绪文不被误判为 telling(零命中、不打回)", () => {
    const s = detectSlop(SHOWING)
    expect(s.tellingEmotionHits).toBe(0)
    expect(s.redFlags.some((f) => f.includes("命名情绪"))).toBe(false)
  })

  it("telling 命中推高 slopPenalty(报情绪 > 演情绪)", () => {
    expect(slopPenalty(detectSlop(TELLING))).toBeGreaterThan(slopPenalty(detectSlop(SHOWING)))
  })
})
