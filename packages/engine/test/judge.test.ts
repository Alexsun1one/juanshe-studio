/**
 * 卷舍引擎 · L1 判官 schema 容错 + L0↔L1 联防行为 回归测试
 *
 * 锁住真 key 实测抓到的真 bug:DeepSeek 等模型把 5 个维度直接返成"裸数字"而非 {score,note} 对象,
 * 旧 schema 严格要求对象 → reviewing 阶段 ZodError 崩掉整条流水线(status:error、无评分)。
 * 现 schema 容忍 数字 / 字符串数字 / 对象 三种形态,judge 永不因维度形态差异而失败。
 *
 * 联防行为(对齐真实书稿审计):
 *  - rubric 焊入追读判据(开篇 300 字钩子 / 章末断在动作未决 / 上一章钩子兑现 / 台词遮名互换);
 *  - 自动必修只认确定性铁证(节奏红旗 / 禁用句式逐条点名),软词命中只压分不塞假必修项;
 *  - L0 warning 档信号(对白内/单处禁用句式)随红旗一并进 L1 上下文,判官有定点弹药可采信。
 */
import { describe, it, expect } from "vitest"
import { JudgeOutput, judgeChapter } from "../src/quality/judge.js"
import type { LlmClient } from "../src/llm/client.js"

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

// ── L0↔L1 联防行为 ───────────────────────────────────────────

/** 捕获判官实际收到的 system/user 提示词的桩 LLM(判官嘴上给定分,mustFix 可空) */
function stubJudge(score: number, mustFix: string[] = []) {
  const captured: { system?: string; user?: string } = {}
  const llm: LlmClient = {
    async generate() {
      return { text: "" }
    },
    async generateStructured(o) {
      captured.system = o.system
      captured.user = o.messages[0]?.content
      const data = o.schema.parse({
        consistency: score, pacing: score, emotion: score, prose: score, deAiTell: score, mustFix,
      })
      return { data }
    },
  }
  return { llm, captured }
}

// 长短交错的干净叙事(无禁用句式、无陈词):自动必修不得对它下手
const CLEAN_DRAFT = `雨停了。她把伞收进门后的桶里,水顺着伞骨滴下来,在地砖上积成一小片亮。屋里没开灯。桌上那只碗换了位置。她记得很清楚,出门前碗口朝下,现在朝上,里面放着一把不属于这间屋子的钥匙。`

// 叙述部分两处「不是A,而是B」(最重禁用句式),句长长短交错
const BANNED_DRAFT = `雨停了。他把信纸压在台灯下,逐字读了三遍,手指一直停在那个名字上。不是愤怒,而是疲惫。她推门进来,看见的就是这样一幅画面:灯亮着,人坐着,茶凉了。窗外有人收伞,伞骨抖出一串水珠。这屋子不是家,而是一座等了十年的牢。她忽然很想笑。`

// 陈词堆叠(深吸一口气×2 + 心头一震,≥10 句够密度样本)但节奏正常、零禁用句式:
// 旧版会因 L0 压分而自动塞「重写节奏」假必修——新版只压分、不塞
const SLOPPY_WORDS_DRAFT = `风停了。他深吸一口气,把信塞回抽屉。抽屉没关严。她站在门口,手里的钥匙还挂在指尖上晃。没人说话。巷子里的狗叫了两声,又安静下去,只剩屋檐滴水,一滴一滴敲在铁皮棚顶上。他又深吸一口气。灯灭了。心头一震。她转身下楼,楼道里的声控灯一层一层亮起来,又一层一层熄掉。夜很长。`

// 叙述里单处「不是X,是Y」逗号变体:weighted 1 < redAt 2 → 只进 warning 档,不打回
const WARN_DRAFT = `他看了那只碗很久。不是急,是怕。碗沿上有一道旧裂,顺着光看才看得见。他把碗放回箱底,动作慢得像在埋什么。门外传来脚步声,停了一下,又走远了。`

describe("judge · rubric 焊入追读判据(纯提示词,锁住不被改丢)", () => {
  it("system 提示词含 开篇300字钩子 / 章末动作未决 / 上一章钩子兑现 / 台词遮名互换 四处硬判据", async () => {
    const { llm, captured } = stubJudge(90)
    await judgeChapter(CLEAN_DRAFT, llm, { passThreshold: 85 })
    expect(captured.system).toContain("开篇 300 字")
    expect(captured.system).toContain("结果未现")
    expect(captured.system).toContain("上一章钩子")
    expect(captured.system).toContain("遮名互换")
    // 开篇/章末无钩必须列第一条必修
    expect(captured.system).toContain("第一条必修")
  })
})

describe("judge · 自动必修只认确定性铁证(回归:软词压分曾塞假'重写节奏'必修)", () => {
  it("禁用句式命中 → mustFix 逐条点名(句式名 + N 处 + 原句片段),deAiTell 同步被压", async () => {
    const { llm } = stubJudge(95)
    const r = await judgeChapter(BANNED_DRAFT, llm, { passThreshold: 85 })
    expect(r.mustFix.some((m) => m.includes("不是A,而是B") && m.includes("2 处"))).toBe(true)
    expect(r.score.dimensions.deAiTell).toBeLessThan(95)
  })

  it("仅陈词堆叠(无节奏红旗、无禁用句式)→ 只压分,不再自动追加假必修项", async () => {
    const { llm } = stubJudge(95)
    const r = await judgeChapter(SLOPPY_WORDS_DRAFT, llm, { passThreshold: 85 })
    expect(r.score.dimensions.deAiTell).toBeLessThan(95) // L0 否决仍生效
    expect(r.mustFix).toEqual([]) // 但不再喊"重写节奏"误导 reviser
  })

  it("干净稿 → 零自动必修、deAiTell 不被压", async () => {
    const { llm } = stubJudge(92)
    const r = await judgeChapter(CLEAN_DRAFT, llm, { passThreshold: 85 })
    expect(r.mustFix).toEqual([])
    expect(r.score.dimensions.deAiTell).toBe(92)
  })
})

describe("judge · L0 warning 档接进 L1 上下文(单处禁用句式不打回但要进判官视野)", () => {
  it("单处逗号变体 → user 提示词含 warning 档点名,但不进自动必修(警告档由 L1 裁量)", async () => {
    const { llm, captured } = stubJudge(90)
    const r = await judgeChapter(WARN_DRAFT, llm, { passThreshold: 85 })
    expect(captured.user).toContain("警告档")
    expect(captured.user).toContain("不是X,是Y")
    // 与 pregate 红旗同一口径:weighted 1 < redAt 2,警告档不得自动驱动 reviser 定点改写
    // (合法口语"她不是本地人,是南方来的"会被误修);判官视野里有点名,采不采信由 L1 定。
    expect(r.mustFix).toEqual([])
  })
})
