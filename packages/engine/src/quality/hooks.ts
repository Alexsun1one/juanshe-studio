/**
 * 卷舍 · 质量 L0 追读钩子机检(确定性启发式,零 LLM 成本)
 *
 * judge rubric 已焊入追读硬判据(开篇 300 字内必须有具体失衡 / 章末必须断在动作已发、结果未现),
 * 但 LLM 判官可能手松不严格执行——本文件是该判据的零成本确定性兜底,与 detectSlop 同属 L0。
 *
 * 校准铁律:**宁漏勿误杀**。只有教科书式负信号才给 ok=false:
 *  - 平开 = 时间状语+环境白描开头,且前 300 字无人物动作、无对白、无疑问、无冲突动作、无数字时限;
 *  - 平收 = 末两句命中总结升华 / 情绪收束 / 完成时收尾,且章末全无掐断式正信号
 *    (对白收尾 / 疑问收尾 / 省略号悬置 / 突发新信息 / 末句动作未落)。
 * 拿不准(短章、对话体、信号混杂)一律 ok=true,绝不把好稿推给 reviser 改坏。
 * 正信号词表故意从宽:正信号误命中只会把判定推向放行,方向与铁律一致;
 * 负信号词表从严:只收"夜深了/归于平静/睡着了"这类批量货收束,不碰可疑但合法的写法。
 */

export interface HookSignal {
  /** 保守判定:false 仅当踩中教科书式负信号且无任何正信号;拿不准一律 true */
  readonly ok: boolean
  /** 0–1 启发式置信(越高越像有钩);只作参考与排序,不直接折算质量分 */
  readonly score: number
  /** 命中的正/负信号逐条说明(进 judge 上下文 / mustFix 措辞用) */
  readonly evidence: string[]
  /** 被点名的原文片段(开篇=起句 / 章末=末句),autoFix 定点引用 */
  readonly sample?: string
}

// ── 取样窗口与样本量下限(单一事实源,调口径只改这里)──────────
/** 开篇取样窗口(字)——与 rubric「开篇 300 字」同口径 */
const OPENING_WINDOW = 300
/** 章末取样窗口(字) */
const ENDING_WINDOW = 250
/** 样本量下限:去空白后短于此跳过判定(短章/楔子信号失真,一律放行) */
const MIN_CHARS = 80

// ── 正信号(从宽:误命中只会推向放行)────────────────────────
/** 对白引号(与 pregate.quoteRanges 同一套引号口径) */
const DIALOGUE_RE = /[「『“"]/
/** 疑问句 */
const QUESTION_RE = /[?？]/
/** 冲突/具体动作动词:撞抓砸吼逼瞒…单字 + 冲突事件词 */
const CONFLICT_ACTION_RE =
  /[撞抓砸吼逼瞒抢夺拽摔扑掀拦踹劈捂拖扯掐砍跪逃追堵骗偷杀踢撕闯甩攥]|出事|失踪|报警|翻脸|动手|争吵|吵架|威胁|勒索|绑架|跟踪|对峙|质问|逼问/g
/** 数字时限:限期/倒计时式压力(数字+时间单位,且带紧迫标记) */
const DEADLINE_RE =
  /(?:只剩|还剩|仅剩|还有|不到|最后|倒数|限(?:你|期)?)[^。！？\n]{0,6}[零一二两三四五六七八九十百千0-9]+\s*(?:秒|分钟|刻钟|小时|个钟头|天|日|夜|周|个月|年)|[零一二两三四五六七八九十百千0-9]+\s*(?:秒|分钟|小时|天|日|周|个月)(?:之内|以内)/
/** 章末突发新信息:突然/门开/铃响/屏幕亮起一行字… */
const NEW_INFO_RE =
  /突然|忽然|猛地|蓦地|就在这时|就在此时|这时[，,]|下一秒|刹那间|门(?:被)?(?:猛地)?(?:推|撞|踹)?开|手机(?:突然)?(?:响|震)|电话(?:突然)?(?:响|打进)|铃(?:声)?响|震动(?:了)?起来|传来[^。！？\n]{0,10}(?:声|响)|跳出(?:一行|一条)|弹出(?:一条|一行)|屏幕亮(?:了)?起|一个(?:陌生的)?(?:声音|名字|号码)|出现在(?:门口|身后)/g

// ── 负信号组件(从严:只认教科书式写法)──────────────────────
/** 时间状语开头:清晨/那年/三月/天刚亮…打头 */
const TIME_OPENING_RE =
  /^(?:清晨|清早|早晨|一早|大清早|拂晓|黎明|上午|正午|中午|午后|下午|傍晚|黄昏|暮色|夜幕|入夜|夜色|深夜|午夜|凌晨|这天|那天|那一天|这一天|这年|那年|那一年|这一年|周末|春天|夏天|秋天|冬天|初春|初夏|初秋|初冬|盛夏|深秋|隆冬|开春|入秋|[一二三四五六七八九十腊正]月|天刚(?:蒙蒙)?亮|天色(?:渐)?(?:亮|暗)|雨季|多年(?:以)?后|许多年后)/
/** 环境白描词(与时间状语开头联合出现才计入负信号) */
const SCENERY_RE =
  /阳光|晨光|月光|霞光|薄雾|雾气|炊烟|微风|细雨|小雨|雨丝|雪花|天空|天边|空气里|街道|长街|巷子|小巷|院子|庭院|小镇|村庄|村子|山坡|山脚|山间|河面|河边|湖面|湖边|海面|海边|树影|树叶|树梢|枝头|花香|草地|蝉鸣|鸟叫|鸟鸣|虫鸣|屋檐|窗外|田野|稻田|麦田/
/** 人物动作 ①:人称代词近距跟动作动词(有一处即视为"有人在动",不判平开) */
const PERSON_ACTION_RE =
  /(?:他|她|我|你|它)(?:们)?[^。！？\n]{0,8}(?:走|跑|站|坐|蹲|跳|爬|拿|抬|推|拉|拍|敲|捧|握|提|背|抱|踩|迈|穿|脱|开|关|喊|叫|说|骂|哭|笑|吃|喝|写|读|翻|扔|捡|指|摸|擦|揉|收|放|递|接|掏|数|盯|瞥|望|瞪|转身|回头|伸手|起身|睁眼|低头|抬头|皱眉|停下|出门|进门)/
/** 人物动作 ②:无代词也能确认的动作搭配(具名角色开场用;"把"字句几乎必含施动者) */
const BARE_ACTION_RE =
  /把[^。！？\n]{1,10}[拉关推拽挂放摆搬提搭铺盖收塞锁抱捆系搓拧掀按]|推开|拉开|打开|关上|合上|坐在|坐下|站在|站起|走到|走进|走出|走过|跑出|拿起|放下|抬起|捡起|蹲在|趴在|靠在|背着|扛着|提着|端着|抱着|牵着|说道|问道|答道|喊道|低声道|开口|点了点头|摇了摇头|叹了口气|回头|转身|伸手|睁开眼|起床|起身/
/** 总结升华收束:夜深了/归于平静/明天会更好/尘埃落定… */
const SUMMARY_CLOSE_RE =
  /夜(?:更)?深了|天(?:渐渐)?亮了|渐渐睡去|沉沉睡去|睡着了|进入梦乡|睡了过去|归于平静|恢复(?:了)?平静|重归平静|平静(?:了)?下来|安静(?:了)?下来|明天(?:会更好|又是新的一天)|一切都会(?:好起来|过去|好的)|岁月静好|风平浪静|尘埃落定|落下帷幕|画上(?:了)?(?:一个)?(?:圆满的)?句号|就这样(?:平静地)?(?:过去|结束)了/
/** 情绪收束:只认收束语境的搭配("心里一片踏实"),不杀单独出现的情绪词 */
const EMOTION_CLOSE_RE =
  /(?:心里|心中|心头|胸口)(?:一片|一阵|说不出地?)?(?:踏实|安稳|平静|安宁|温暖|轻松|释然)|(?:释然|安心|踏实|欣慰|满足|平静)地(?:笑|睡|闭上|舒|吐出|呼出)|嘴角(?:带着|挂着|噙着)(?:一丝|一抹)?笑|带着(?:笑意|暖意|满足)(?:沉沉)?睡/
/** 完成时收尾:一切都结束了/事情总算解决了/终于…了。(末句) */
const COMPLETED_CLOSE_RE =
  /(?:一切|事情|这一切|风波|这件事|心里的石头)(?:都|总算|终于)?(?:结束|过去|解决|平息|了结|落了地)(?:了)?|终于[^。！？\n]{0,10}了[。!！]?\s*$|总算(?:是)?[^。！？\n]{0,10}了[。!！]?\s*$/

// ── 小工具 ─────────────────────────────────────────────────
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))
const round2 = (n: number): number => Math.round(n * 100) / 100

/** 截取原文片段做点名引用(过长截断) */
function snip(s: string, max = 30): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** 中文分句(保留句末标点;供"起句/末句"点名与末两句负信号判定) */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?…])/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
}

/** 计正则命中数(统一走 match,避免 /g 正则 test() 的 lastIndex 状态坑) */
function hits(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0
}

/**
 * 开篇钩子机检:取前 300 字。
 * 正信号 = 疑问句 / 对白 / 冲突·具体动作动词 / 数字时限;
 * 负信号 = 时间状语+环境白描开头,且前 300 字无人物动作、无对白(教科书式平开)。
 */
export function detectOpeningHook(text: string): HookSignal {
  const head = text.trim().slice(0, OPENING_WINDOW)
  if (head.replace(/\s+/g, "").length < MIN_CHARS) {
    return { ok: true, score: 0.5, evidence: ["文本过短,跳过开篇钩子判定"] }
  }
  const first = splitSentences(head)[0] ?? head

  const evidence: string[] = []
  let pos = 0
  if (QUESTION_RE.test(head)) {
    pos++
    evidence.push("开篇含疑问句")
  }
  if (DIALOGUE_RE.test(head)) {
    pos++
    evidence.push("开篇含对白")
  }
  const conflictHits = hits(head, CONFLICT_ACTION_RE)
  if (conflictHits > 0) {
    pos++
    evidence.push(`含冲突/具体动作词 ${conflictHits} 处`)
  }
  const deadline = head.match(DEADLINE_RE)?.[0]
  if (deadline) {
    pos++
    evidence.push(`含数字时限「${snip(deadline, 14)}」`)
  }

  const timeOpening = TIME_OPENING_RE.test(head)
  const scenery = SCENERY_RE.test(head)
  const personAction = PERSON_ACTION_RE.test(head) || BARE_ACTION_RE.test(head)
  // 教科书式平开:全部条件同时成立才判负——任一拿不准即放行(宁漏勿误杀)
  if (pos === 0 && timeOpening && scenery && !personAction) {
    return {
      ok: false,
      score: 0.1,
      evidence: ["时间状语+环境白描开头,且前 300 字无人物动作、无对白、无疑问"],
      sample: snip(first),
    }
  }
  if (pos === 0) evidence.push("未检出明确正信号,但不构成教科书式平开,保守放行")
  const score = round2(clamp01(0.5 + pos * 0.15 - (pos === 0 && timeOpening && scenery ? 0.15 : 0)))
  return { ok: true, score, evidence, sample: snip(first) }
}

/**
 * 章末钩子机检:取最后 250 字。
 * 正信号 = 对白掐断 / 疑问收尾 / 省略号·破折号悬置 / 突发新信息 / 末句动作未落;
 * 负信号 = 末两句命中总结升华 / 情绪收束 / 完成时收尾(教科书式平收)。
 */
export function detectEndingHook(text: string): HookSignal {
  const body = text.trim()
  const tail = body.slice(-ENDING_WINDOW)
  if (tail.replace(/\s+/g, "").length < MIN_CHARS) {
    return { ok: true, score: 0.5, evidence: ["文本过短,跳过章末钩子判定"] }
  }
  const sentences = splitSentences(tail)
  const last = sentences[sentences.length - 1] ?? tail
  // 负信号只看末两句:章中段落的"平静/踏实"是合法过渡,不算收束
  const lastTwo = sentences.slice(-2).join("")

  const evidence: string[] = []
  let pos = 0
  if (/[?？][」』”"]?\s*$/.test(body)) {
    pos++
    evidence.push("疑问收尾")
  }
  if (/[」』”"][。…]?\s*$/.test(body)) {
    pos++
    evidence.push("对白掐断收尾")
  }
  if (/[…—][」』”"]?\s*$/.test(body)) {
    pos++
    evidence.push("悬置收尾(省略号/破折号)")
  }
  const newInfo = hits(tail, NEW_INFO_RE)
  if (newInfo > 0) {
    pos++
    evidence.push(`章末抛出新信息/突发 ${newInfo} 处`)
  }
  if (hits(last, CONFLICT_ACTION_RE) > 0) {
    pos++
    evidence.push("末句动作未落")
  }

  const negEvidence: string[] = []
  const summaryHit = lastTwo.match(SUMMARY_CLOSE_RE)?.[0]
  if (summaryHit) negEvidence.push(`总结/升华收束「${snip(summaryHit, 14)}」`)
  const emotionHit = lastTwo.match(EMOTION_CLOSE_RE)?.[0]
  if (emotionHit) negEvidence.push(`情绪收束「${snip(emotionHit, 14)}」`)
  const completedHit = last.match(COMPLETED_CLOSE_RE)?.[0]
  if (completedHit) negEvidence.push(`完成时收尾「${snip(completedHit, 14)}」`)

  // 教科书式平收:有负信号且全无掐断式正信号;但凡有一个正信号即放行(宁漏勿误杀)
  if (negEvidence.length > 0 && pos === 0) {
    return {
      ok: false,
      score: round2(clamp01(0.3 - negEvidence.length * 0.1)),
      evidence: negEvidence,
      sample: snip(last),
    }
  }
  evidence.push(...negEvidence.map((e) => `(已被正信号抵消)${e}`))
  if (evidence.length === 0) evidence.push("未检出明确收尾信号,保守放行")
  const score = round2(clamp01(0.5 + pos * 0.15 - negEvidence.length * 0.1))
  return { ok: true, score, evidence, sample: snip(last) }
}
