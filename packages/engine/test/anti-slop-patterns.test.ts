/**
 * 卷舍引擎 · L0 禁用句式 + 词表分层 回归测试
 *
 * 锁住三件事:
 *  ① CN_BANNED_PATTERNS:全提示词最重禁令(不是A而是B/逗号变体/章末预言/顿悟总结/
 *    明喻套壳/逗号拖尾/模糊兜底)的机检——真 AI 腔句必须逐条点名,真人句一处不许误报;
 *  ② 对白减权:引号内「不是…是…」按 0.5 计权,单处对白只记 warning 不进红旗;
 *  ③ 词表 hard/soft 分层 + 句首连接词:「最后一刻」「一阵风」、句中「然而」不再误伤,
 *    真 AI 陈词堆叠(眼中闪过/深吸一口气/脑子嗡…)照样触发红旗。
 */
import { describe, it, expect } from "vitest"
import { detectSlop, slopPenalty, type SlopSignals } from "../src/quality/pregate.js"

function hitOf(s: SlopSignals, name: string) {
  return s.bannedPatternDetail?.find((d) => d.name.includes(name))
}

describe("pregate · 禁用句式机检(CN_BANNED_PATTERNS)", () => {
  it("「不是A,而是B」一处即红旗(绝对禁令)", () => {
    const s = detectSlop("他要的不是钱，而是一个说法。她想了想，没接话。")
    expect(hitOf(s, "而是")?.count).toBe(1)
    expect(s.redFlags.some((f) => f.includes("不是A,而是B"))).toBe(true)
  })

  it("「不是X,是Y」逗号变体(含三连排比)两处叙述命中即红旗", () => {
    const s = detectSlop("不是急，不是求，是一种说不上来的笃定。他看着她。不是惊讶，是确认。")
    const d = hitOf(s, "逗号变体")
    expect(d?.count).toBe(2)
    expect(d?.weighted).toBe(2)
    expect(s.redFlags.some((f) => f.includes("逗号变体"))).toBe(true)
    // 三连排比顺带踩中模糊兜底("一种说不上来的笃定")
    expect(hitOf(s, "模糊兜底")?.count).toBe(1)
  })

  it("逗号变体单处叙述只记 warning,不进红旗(防误伤辨析直述句)", () => {
    const s = detectSlop("她愣住了。那不是愤怒，是意外。")
    expect(hitOf(s, "逗号变体")?.count).toBe(1)
    expect(s.redFlags.some((f) => f.includes("逗号变体"))).toBe(false)
    expect(s.warnings?.some((w) => w.includes("逗号变体"))).toBe(true)
  })

  it("对白引号内命中按 0.5 计权,单处对白不进红旗", () => {
    const s = detectSlop("「我不是怕他，是怕你出事。」她把伞递过去。")
    expect(hitOf(s, "逗号变体")?.weighted).toBe(0.5)
    expect(s.redFlags.some((f) => f.includes("逗号变体"))).toBe(false)
  })

  it("章末预言/顿悟总结/明喻套壳/逗号拖尾逐条点名,redFlags 带句式名与次数", () => {
    const s = detectSlop([
      "他不知道的是，命运的齿轮已经开始转动。",
      "这一刻，他终于明白了她的意思。",
      "整个人仿佛被抽走了力气一般。",
      "她转过身，带着一丝歉意。",
    ].join(""))
    for (const name of ["他不知道的是", "这一刻终于明白", "仿佛…一般", "带着"]) {
      expect(hitOf(s, name)?.count, name).toBe(1)
      expect(s.redFlags.some((f) => f.includes(name)), name).toBe(true)
    }
    expect(s.bannedPatternHits).toBe(4)
  })

  it("真人句零误报:最后一刻/一阵风/不知道这件事/这一刻的安静/仿佛听见", () => {
    const s = detectSlop([
      "最后一刻，他抓住了绳子。",
      "一阵风吹过，吹灭了桌上的蜡烛。",
      "他不知道这件事还能瞒多久。",
      "她说她不是本地人。",
      "这一刻的安静让他心里发毛。",
      "他仿佛听见了什么。",
    ].join(""))
    expect(s.bannedPatternDetail).toHaveLength(0)
    expect(s.bannedPatternHits).toBe(0)
    expect(s.redFlags.some((f) => f.includes("禁用句式"))).toBe(false)
  })
})

describe("pregate · 词表分层 + 句首连接词(误伤修正)", () => {
  it("句中「然而」「最后」不计;句首连接词才计(「最后」须紧跟逗号)", () => {
    const mid = detectSlop("他想了想，然而还是把话咽了回去。话说到最后，他声音低了下去。")
    expect(mid.fillerHits).toBe(0)
    const head = detectSlop("然而，事情没那么简单。此外，他还有别的安排。首先，得找到钥匙。与此同时，门外有脚步声。最后，他放弃了。")
    expect(head.fillerHits).toBe(5)
  })

  it("「最后一刻」开句不算连接词(不许误报)", () => {
    const s = detectSlop("最后一刻，他抓住了绳子。最后他什么也没说。")
    expect(s.fillerHits).toBe(0)
  })

  it("说明文腔长文:句首连接词+真套话过密 → 触发套话红旗", () => {
    const block = "然而，事情没那么简单。此外，他还有别的安排。值得注意的是，钥匙不见了。与此同时，门外传来脚步声。"
    const s = detectSlop(block.repeat(7)) // ~330 字,过最小样本门
    expect((s.fillerPer1k ?? 0)).toBeGreaterThanOrEqual(2.5)
    expect(s.redFlags.some((f) => f.includes("套话"))).toBe(true)
  })

  it("hard 陈词堆叠(眼中闪过/深吸一口气/脑子嗡…)触发美文词红旗", () => {
    const s = detectSlop([
      "他眼中闪过一丝寒意。", "她深吸一口气。", "他心头一震。", "她嘴角勾起一抹弧度。",
      "他喉咙发紧。", "她指节发白。", "他后背发凉。", "她脑子嗡了一下。",
      "他眼神一凛。", "她挑了挑眉。",
    ].join(""))
    expect(s.slopDensity).toBeGreaterThanOrEqual(0.08)
    expect(s.redFlags.some((f) => f.includes("陈词过密") || f.includes("美文词"))).toBe(true)
  })

  it("真人稿(长短交错,偶有 soft 词与对白)零红旗,罚分低", () => {
    const human = [
      "走。", "他把烟摁灭在窗台上，铁皮被烫出一个浅浅的白印。",
      "巷子口的灯坏了半个月，修灯的人一直没来。", "一阵风卷着塑料袋滚过去。",
      "「你到底去不去？」", "她不答。", "雨点先是一两滴，砸在伞面上，闷闷的，随后连成了线。",
      "最后一刻，他还是把车票塞回了口袋。", "票根的边角被汗浸软了。",
      "对面楼里有人在练琴，断断续续，总在同一个小节卡住。", "他数了数，第七次了。",
      "门开了条缝，又合上。",
    ].join("")
    const s = detectSlop(human)
    expect(s.redFlags).toHaveLength(0)
    expect(slopPenalty(s)).toBeLessThanOrEqual(8)
  })

  it("AI 腔稿罚分显著高于真人稿(禁用句式+陈词双重计入)", () => {
    const aiish = [
      "他眼中闪过一丝寒意，深吸一口气。", "不是愤怒，不是警惕，是意外。",
      "她的心跳快得像擂鼓，脑子嗡了一下。", "空气仿佛凝固，时间仿佛静止。",
      "他不知道的是，这一切才刚刚开始。", "这一刻，他终于明白了什么。",
      "她转过身，带着一丝歉意。", "他下意识地后退半步，不由自主地攥紧了拳头。",
      "那是一种说不上来的感觉。", "整个人仿佛被抽空了一般。",
    ].join("")
    const human = "他踢开门。雨水顺着屋檐砸下来，打湿了肩膀。屋里没人，桌上的茶还冒着热气，杯沿缺了个口。"
    expect(slopPenalty(detectSlop(aiish))).toBeGreaterThan(slopPenalty(detectSlop(human)) + 20)
  })

  it("detectSlop 返回结构向后兼容:旧字段齐全,新字段可选", () => {
    const s = detectSlop("他走了。她没回头。")
    for (const k of ["burstiness", "uniformSentences", "slopDensity", "fillerHits", "repetitionRatio", "tellingEmotionHits", "redFlags"]) {
      expect(s).toHaveProperty(k)
    }
    // 旧形状(无新增字段)的信号对象,slopPenalty 照算不崩
    const legacy: SlopSignals = {
      burstiness: 0.6, uniformSentences: false, slopDensity: 0.02,
      fillerHits: 2, repetitionRatio: 0.01, tellingEmotionHits: 1, redFlags: [],
    }
    expect(typeof slopPenalty(legacy)).toBe("number")
  })
})
