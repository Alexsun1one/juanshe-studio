/**
 * 卷舍引擎 · L0 追读钩子机检(hooks.ts)+ judge 接线 行为测试
 *
 * 锁两件事:
 *  ① 启发式本体:教科书式平开/平收才 ok=false;对白体、短章、信号混杂一律保守放行(宁漏勿误杀);
 *  ② judge 接线:双平 = 强负信号 → 进红旗措辞 + autoFix 定点必修;单侧疑似 = 弱信号 → 只进
 *     judge user 上下文一行【追读提示】,不驱动 reviser;干净稿零打扰。
 */
import { describe, it, expect } from "vitest"
import { detectOpeningHook, detectEndingHook } from "../src/quality/hooks.js"
import { judgeChapter } from "../src/quality/judge.js"
import type { LlmClient } from "../src/llm/client.js"

// ── 开篇样例 ─────────────────────────────────────────────────

// 好开篇 A:对白 + 疑问 + 冲突动作
const GOOD_OPENING_DIALOGUE = `「你再说一遍?」陈砚把茶杯按在桌上,瓷底磕出一声脆响。对面的人不敢看他。三分钟前,账房先生递进来一张当票,上面押的是他母亲的陪嫁玉镯。他抓起当票,纸边在掌心里折出一道死褶。`

// 好开篇 B:数字时限 + 冲突动作
const GOOD_OPENING_DEADLINE = `只剩三天。账上的窟窿还差两千块,赵小满把存折翻到最后一页,数字瘦得硌眼。她把存折塞回枕头底下,抄起外套往外冲——当铺十点关门,她得赶在那之前把祖传的镯子赎回来。`

// 坏开篇 A:清晨 + 环境白描,全程无人物动作、无对白(教科书式平开)
const FLAT_OPENING_MORNING = `清晨,阳光透过薄雾洒在小镇的青石板路上。街道两旁的梧桐树抽出了新芽,空气里有雨后泥土的味道。远处的山坡上,炊烟从几户人家的屋檐升起,缓缓地散进天空。巷子深处,花香一阵一阵地漫过来。`

// 坏开篇 B:那一年 + 田园白描,同样无人无对白
const FLAT_OPENING_AUTUMN = `那一年初秋,村庄外的稻田泛着金黄,风从山坡那边吹过来,卷起一层层稻浪。天空很高,云很淡,蝉鸣稀稀落落地挂在树梢上。田埂尽头的老屋安安静静,屋檐下吊着去年的玉米,墙根的草地一直绿到河边。`

// 边界:时间状语+环境白描开头,但有人物动作(坐下/把字句)→ 不构成平开,必须放行
const TIME_BUT_ACTIVE_OPENING = `傍晚,巷子里起了风。老何把竹椅搬到屋檐下,坐下,慢慢卷了一支烟。烟丝是儿子上个月捎回来的,他一直没舍得碰。今天舍得了,因为当铺的人下午来过,在门上贴了一张红纸。`

// 边界:对话体开篇(几乎全是对白)→ 正信号充足,放行
const DIALOGUE_BODY_OPENING = `「他昨晚没回来。」\n「你怎么知道?」\n「门口的伞还是干的。」周姨压低了声音,往楼道里瞥了一眼,「我数过,他这个月已经三次整夜不归了。你说,一个守了二十年夜班的人,突然改了habit,图什么?」`

describe("hooks · detectOpeningHook", () => {
  it("好开篇:对白+疑问+冲突动作 → ok=true,score 明显高于基线,证据点名信号", () => {
    const r = detectOpeningHook(GOOD_OPENING_DIALOGUE)
    expect(r.ok).toBe(true)
    expect(r.score).toBeGreaterThan(0.5)
    expect(r.evidence.join(";")).toContain("对白")
    expect(r.evidence.join(";")).toContain("疑问")
  })

  it("好开篇:数字时限被识别为正信号", () => {
    const r = detectOpeningHook(GOOD_OPENING_DEADLINE)
    expect(r.ok).toBe(true)
    expect(r.evidence.join(";")).toContain("数字时限")
  })

  it("坏开篇:清晨白描平开 → ok=false,score 极低,sample 点名起句", () => {
    const r = detectOpeningHook(FLAT_OPENING_MORNING)
    expect(r.ok).toBe(false)
    expect(r.score).toBeLessThan(0.3)
    expect(r.evidence.join(";")).toContain("时间状语")
    expect(r.sample).toContain("清晨")
  })

  it("坏开篇:初秋田园平开 → ok=false", () => {
    const r = detectOpeningHook(FLAT_OPENING_AUTUMN)
    expect(r.ok).toBe(false)
    expect(r.sample).toContain("那一年初秋")
  })

  it("边界·宁漏勿误杀:时间+白描开头但有人物动作 → 放行(ok=true)", () => {
    const r = detectOpeningHook(TIME_BUT_ACTIVE_OPENING)
    expect(r.ok).toBe(true)
  })

  it("边界:对话体开篇 → 放行", () => {
    expect(detectOpeningHook(DIALOGUE_BODY_OPENING).ok).toBe(true)
  })

  it("边界:短章(不足样本量)→ 跳过判定,保守放行", () => {
    const r = detectOpeningHook("雨停了。她回头。")
    expect(r.ok).toBe(true)
    expect(r.score).toBe(0.5)
    expect(r.evidence[0]).toContain("过短")
  })
})

// ── 章末样例 ─────────────────────────────────────────────────

// 好结尾 A:对白掐断收尾(+章末突发)
const GOOD_ENDING_DIALOGUE = `天黑得早,当铺里只剩他一个人。他把手伸进口袋,摸到那张当票还在。楼下的门铃响了,一声,又一声,不依不饶。他探头往下看。看清来人的脸时,他的手指一下子收紧——「怎么是你。」`

// 好结尾 B:动作未落 + 新信息抛出
const GOOD_ENDING_ACTION = `整栋楼静得能听见她自己的心跳。她数到第七级台阶,停住了。门虚掩着,里面亮着灯。她出门前明明锁了三道锁。楼道里的声控灯忽然灭了,黑暗一下子涌上来。她把钥匙倒攥在手心,屏住呼吸,一脚踹开了门。`

// 坏结尾 A:总结升华三连(夜深了/明天会更好/睡着了)
const FLAT_ENDING_SUMMARY = `她把最后一只纸箱拆完,把书一本本放回架子上。风波就这样过去了。她洗了热水澡,给自己泡了一杯牛奶,窗外的雨不知道什么时候停了。夜深了,她想,明天会更好。她关了灯,很快睡着了。`

// 坏结尾 B:情绪收束(心里一片踏实)+ 完成时
const FLAT_ENDING_EMOTION = `案子结了,卷宗归了档,墙上的挂钟走到十一点,办公室里只剩他一个人。他锁好抽屉,慢慢往家走,夜里的风都是软的。他靠在家门口站了一会儿,心里一片踏实,连日来压着的那块石头总算落了地。`

// 边界:负信号词在场但被突发新信息抵消 → 放行
const ENDING_NEG_OFFSET = `天色暗下来,救生员把最后一圈警戒线收走了,岸边看热闹的人也散得差不多了。湖面恢复了平静。她正要转身回屋,手机突然震了一下,屏幕亮起来,跳出一行陌生号码发来的字:别回头。`

// 边界:对话体收尾 → 对白掐断,放行
const DIALOGUE_BODY_ENDING = `两个人在车里坐了很久,谁都没先开口。烟烧到第三支,他摇下车窗。「明天九点,老地方见。」「要是他不来呢?」「他会来的。」陈砚把烟摁灭在窗台上,声音很稳,「他比我们更怕这件事见光。」`

describe("hooks · detectEndingHook", () => {
  it("好结尾:对白掐断 → ok=true,证据点名", () => {
    const r = detectEndingHook(GOOD_ENDING_DIALOGUE)
    expect(r.ok).toBe(true)
    expect(r.evidence.join(";")).toContain("对白掐断")
  })

  it("好结尾:末句动作未落 + 突发新信息 → ok=true,score 高", () => {
    const r = detectEndingHook(GOOD_ENDING_ACTION)
    expect(r.ok).toBe(true)
    expect(r.score).toBeGreaterThan(0.5)
    expect(r.evidence.join(";")).toContain("动作未落")
  })

  it("坏结尾:夜深了/明天会更好/睡着了 → ok=false,sample 点名末句", () => {
    const r = detectEndingHook(FLAT_ENDING_SUMMARY)
    expect(r.ok).toBe(false)
    expect(r.score).toBeLessThan(0.3)
    expect(r.evidence.join(";")).toContain("总结/升华")
    expect(r.sample).toContain("睡着了")
  })

  it("坏结尾:心里一片踏实(情绪收束)→ ok=false", () => {
    const r = detectEndingHook(FLAT_ENDING_EMOTION)
    expect(r.ok).toBe(false)
    expect(r.evidence.join(";")).toContain("情绪收束")
  })

  it("边界·宁漏勿误杀:'恢复了平静'被章末突发抵消 → 放行,证据标注抵消", () => {
    const r = detectEndingHook(ENDING_NEG_OFFSET)
    expect(r.ok).toBe(true)
    expect(r.evidence.join(";")).toContain("抵消")
  })

  it("边界:对话体收尾 → 放行", () => {
    expect(detectEndingHook(DIALOGUE_BODY_ENDING).ok).toBe(true)
  })

  it("边界:短章 → 跳过判定,保守放行", () => {
    const r = detectEndingHook("完了。她想。")
    expect(r.ok).toBe(true)
    expect(r.evidence[0]).toContain("过短")
  })
})

// ── judge 接线:强负信号进红旗+autoFix,弱信号只进上下文提示 ──

/** 捕获判官实际收到的 user 提示词的桩 LLM(与 judge.test.ts 同款,判官嘴上给定分) */
function stubJudge(score: number) {
  const captured: { user?: string } = {}
  const llm: LlmClient = {
    async generate() {
      return { text: "" }
    },
    async generateStructured(o) {
      captured.user = o.messages[0]?.content
      const data = o.schema.parse({
        consistency: score, pacing: score, emotion: score, prose: score, deAiTell: score, mustFix: [],
      })
      return { data }
    },
  }
  return { llm, captured }
}

// 平开(前 300 字纯白描,无人物)+ 平收(总结升华)的完整坏章:中段节奏正常、零禁用句式
const FLAT_BOTH_CHAPTER = [
  FLAT_OPENING_MORNING,
  FLAT_OPENING_AUTUMN,
  `老屋的木门没有锁。多年前的春联褪成了淡粉色,边角卷起,露出底下更早一层的浆糊印。院子当中那口井还在,井沿的青苔厚了,辘轳上的麻绳却是新换的。`,
  `灶台冷着。碗柜里摆着两副碗筷,一副落了灰,一副是干净的。条凳挪过的痕迹从灶台一直划到门槛,新鲜得扎眼。`,
  FLAT_ENDING_SUMMARY,
].join("\n")

// 好开篇 + 平收:仅单侧疑似 → 弱信号
const FLAT_ENDING_ONLY_CHAPTER = [
  GOOD_OPENING_DIALOGUE,
  `他追到巷口,人没影了。当票上的名字他认得,十五年前在码头替人扛包的赵跛子,早就该死在那年冬天的江里。他把当票折好,贴身收着,转身回了铺子。`,
  FLAT_ENDING_SUMMARY,
].join("\n")

// 好开篇 + 好结尾:干净稿,钩子机检零打扰
const HOOKY_CHAPTER = [GOOD_OPENING_DIALOGUE, GOOD_ENDING_DIALOGUE].join("\n")

describe("judge · 追读钩子接线(强负=红旗+必修,弱=一行提示,干净稿零打扰)", () => {
  it("平开+平收 → 红旗措辞进 L0 块,autoFix 追加双平定点必修(引用开头/结尾原句)", async () => {
    const { llm, captured } = stubJudge(90)
    const r = await judgeChapter(FLAT_BOTH_CHAPTER, llm, { passThreshold: 85 })
    expect(captured.user).toContain("追读钩子机检")
    expect(captured.user).toContain("开篇平开")
    const flatFix = r.mustFix.find((m) => m.includes("双平"))
    expect(flatFix).toBeTruthy()
    expect(flatFix).toContain("清晨") // 点名开头原句
    expect(flatFix).toContain("睡着了") // 点名结尾原句
    expect(flatFix).toContain("结果未现") // 给出改法方向
  })

  it("仅章末平收 → 只进 user 上下文一行【追读提示】,不进 autoFix", async () => {
    const { llm, captured } = stubJudge(90)
    const r = await judgeChapter(FLAT_ENDING_ONLY_CHAPTER, llm, { passThreshold: 85 })
    expect(captured.user).toContain("【追读提示】章末疑似平收")
    expect(captured.user).not.toContain("追读钩子机检")
    expect(r.mustFix.some((m) => m.includes("双平"))).toBe(false)
  })

  it("好开篇+好结尾 → 无提示、无红旗、无自动必修(零打扰)", async () => {
    const { llm, captured } = stubJudge(92)
    const r = await judgeChapter(HOOKY_CHAPTER, llm, { passThreshold: 85 })
    expect(captured.user).not.toContain("追读提示")
    expect(captured.user).not.toContain("追读钩子机检")
    expect(r.mustFix.some((m) => m.includes("双平"))).toBe(false)
  })
})
