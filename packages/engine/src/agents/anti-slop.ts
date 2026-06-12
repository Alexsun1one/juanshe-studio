/**
 * 卷舍 · 去AI味核心组件(anti-slop)
 *
 * 这是"输出像真人、不像 AI"的弹药库,同时服务两处:
 *  ① 提示词组成部分:每个写作/润色 agent 的 system prompt 都注入 ANTI_SLOP_DIRECTIVE;
 *  ② 质量 L0 检测器:复用下面的词表/规则做零成本机检(slop 比率、套话密度、句长 burstiness)。
 *
 * 方法学综合自公开研究(EQ-Bench slop / antislop / humanize-chinese N-gram困惑度 / autonovel ANTI-SLOP),
 * 但**词表与措辞均为本项目重新整理与编写**(只借方法,不抄文本)。中文优先,兼顾英文。
 *
 * 最强的去AI味信号(humanize-chinese 在 HC3-Chinese 上校准的结论):句长 burstiness ——
 * AI 中文爱写一连串 15-25 字的等长句,真人长短交错。这一条在提示词与检测器里都重点落地。
 */

// ── 中文:空洞宏大/AI 高频"美文词"—— hard/soft 分层 ──────────────
// hard(权重 1.0):批量货陈词与换壳"第二代"变体,真人极少自发高频使用,命中即算味儿;
// soft(权重 0.3):正常叙事也合法("一阵风""微微一笑"),只有堆叠才算 AI 味,单独出现近乎免罚。
// 分层动机:旧版整表同权,「一阵」「让人」这类常规叙事词把干净人稿系统性压分(口径见 quality/pregate)。
export const CN_SLOP_WORDS_HARD: readonly string[] = [
  "淋漓尽致", "栩栩如生", "跃然纸上", "熠熠生辉", "错落有致", "美轮美奂", "五彩斑斓",
  "令人动容", "令人心潮澎湃", "一种说不出的", "一种说不上来的", "某种莫名的",
  "心跳漏了一拍", "心头一震", "嘴角勾起", "嘴角微微上扬", "深吸一口气", "倒吸一口凉气",
  "空气仿佛凝固", "气氛凝重", "时间仿佛静止", "一股暖流", "百感交集", "五味杂陈",
  // 各角色提示词反复点名、此前却不在表里的"老一代"指纹
  "眼中闪过", "眼底闪过", "眼神一凛", "勾起一抹", "挑了挑眉", "喃喃道", "沉声道",
  // "第二代"身体反应陈词:旧词被禁后模型收敛出的新批量货(取自真实书稿审计)
  "脑子嗡", "指节发白", "后背发凉", "凉意爬上", "喉咙发紧", "心跳如擂鼓", "像擂鼓",
  "像一盆冰水", "影子拉得很长",
]
export const CN_SLOP_WORDS_SOFT: readonly string[] = [
  "不禁", "不由得", "莫名", "仿佛", "似乎", "彷佛", "无疑", "无不", "无一不",
  "令人", "让人", "缓缓", "轻轻", "微微", "淡淡", "悄然", "渐渐",
  "一抹", "一丝", "一缕", "一阵", "下意识", "不由自主",
]
/** 向后兼容的合并表(整表同权时代的旧入口);新代码请用分层表 + 加权计数 */
export const CN_SLOP_WORDS: readonly string[] = [...CN_SLOP_WORDS_HARD, ...CN_SLOP_WORDS_SOFT]

// ── 中文:套话/机械连接词 —— 同样分层 ─────────────────────────
// hard:真·说明文套话,小说正文出现即扣;
// connectives:句首连接词——只有出现在句首才是说明文腔("他最后看了一眼"是正常叙事,不计)。
export const CN_FILLER_HARD: readonly string[] = [
  "值得注意的是", "值得一提的是", "需要指出的是", "不可否认", "众所周知",
  "总而言之", "综上所述", "总的来说", "由此可见", "归根结底", "毫无疑问",
  "不仅仅是", "正如", "正所谓", "换句话说", "也就是说",
  "在当今", "在这个快节奏的", "在如今",
]
export const CN_FILLER_CONNECTIVES: readonly string[] = [
  "然而", "此外", "另外", "其次", "再者", "首先", "最后", "与此同时",
]
/** 向后兼容合并表;新代码请区分真套话(hard)与句首连接词(connectives) */
export const CN_FILLER_PHRASES: readonly string[] = [...CN_FILLER_HARD, ...CN_FILLER_CONNECTIVES]

// ── 中文:禁用句式(全部 11 个角色提示词的最重禁令,L0 机检对应物)──
// 每条带名字,detectSlop 命中后能在 redFlags/mustFix 里逐条点名(句式名 + 次数 + 原句片段);
// 对白引号内命中按半权计(口语里"不是…是…"偶有合法用法),减权逻辑在 quality/pregate。
export interface BannedPattern {
  /** 句式名(用于 redFlags / mustFix 点名) */
  readonly name: string
  /** 检测正则(必须带 g 标志,供 matchAll) */
  readonly re: RegExp
  /** 加权命中达到该值才进红旗,默认 1;辨析直述句易误伤的句式调高,不足只记 warning */
  readonly redAt?: number
}

export const CN_BANNED_PATTERNS: readonly BannedPattern[] = [
  { name: "不是A,而是B", re: /不是[^，。；：？！\n]{1,20}[，,]?\s*而是/g },
  // 「而是」被禁后模型整体迁移出的逗号变体(含「不是急,不是求,是…」三连排比);
  // 中性辨析句("她不是本地人,是南方来的")偶有合法用法,故 redAt=2:单处只记 warning,成片才打回。
  { name: "不是X,是Y(逗号变体)", re: /不是[^，。；！？\n]{1,20}[，,](?:\s*不是[^，。；！？\n]{1,20}[，,])?\s*是(?!不是)[^，。；！？\n]/g, redAt: 2 },
  { name: "逗号拖尾',带着…'", re: /[，,]带着[^，。！？\n]{1,12}[。；！，,]/g },
  { name: "明喻套壳'仿佛…一般'", re: /(?:仿佛|犹如|宛若|宛如)[^，。！？\n]{2,20}(?:一般|一样|似的)/g },
  { name: "章末预言'他不知道的是'", re: /(?:他|她|他们)(?:还)?不知道的是/g },
  { name: "顿悟总结'这一刻终于明白'", re: /这一刻[^。！？\n]{0,12}(?:终于)?(?<!不)(?:明白|懂)/g },
  // 模糊兜底名词的换壳逃逸:「一种说不出的」→「一种说不上来的笃定」「一种更深的东西」
  { name: "模糊兜底名词'一种…的东西'", re: /一种[^，。！？\n]{2,10}的(?:东西|感觉|语气|神情|笃定)/g },
]

// ── 英文:禁用词 / 套话(写英文体裁时用)────────────────────
export const EN_BANNED_WORDS: readonly string[] = [
  "delve", "utilize", "leverage", "facilitate", "elucidate", "embark", "endeavor",
  "encompass", "multifaceted", "tapestry", "testament", "paradigm", "synergy",
  "holistic", "catalyze", "juxtapose", "nuanced", "realm", "landscape", "myriad",
  "plethora", "robust", "seamless", "cutting-edge", "underscore", "harness", "pivotal",
]
export const EN_FILLER_PHRASES: readonly string[] = [
  "it's worth noting", "it's important to note", "in conclusion", "to summarize",
  "furthermore", "moreover", "additionally", "in today's", "at the end of the day",
  "when it comes to", "needless to say", "not just", "let's dive", "let's explore",
]

// ── 直接命名情绪(telling-not-showing)—— 把情绪当结论报出来,而非用动作/生理/感官演出来 ──
// 小说去AI味的核心信号之一:AI 爱写"他感到一阵恐惧",真人写"他的手按不住地抖"。
export const CN_TELLING_EMOTION: readonly RegExp[] = [
  /(感到|感觉到|感受到|觉得|心中|心里|心头|内心)(?:涌起|涌上|升起|泛起|掠过|划过|浮起)?(?:一阵|一丝|一股|一种|些许)?(恐惧|害怕|惧意|愤怒|怒意|怒火|紧张|不安|焦虑|焦躁|绝望|无助|喜悦|欣喜|狂喜|悲伤|悲痛|哀伤|释然|欣慰|兴奋|激动|震惊|错愕|恐慌|慌乱|惊慌|失落|委屈|无奈|疲惫|厌倦|羞愧|愧疚|尴尬|孤独|惆怅|悸动|忐忑)/g,
  /(涌起|涌上|升起|泛起|涌现|掠过|袭来)(?:一阵|一丝|一股|一种)?(恐惧|愤怒|怒火|悲伤|喜悦|暖意|寒意|快意|酸楚|无力感|窒息感)/g,
]
export const EN_TELLING_EMOTION: readonly RegExp[] = [
  /\b(felt|feeling|sensed|experienced)\s+(?:a\s+)?(wave|surge|sense|pang|rush|flood|flash|stab|knot)\s+of\s+\w+/gi,
  /\b(was|were|felt)\s+(overcome|overwhelmed|consumed|gripped|filled|seized)\s+(?:with|by)\s+\w+/gi,
]

// ── 去AI味提示词组件(注入各写作/润色 agent)────────────────────
export function antiSlopDirective(lang: "zh" | "en" = "zh"): string {
  if (lang === "en") {
    return `## Write like a human, not an AI

- **Vary sentence length (the #1 tell).** Never run several 15–25-word sentences in a row. Mix very short punchy lines with longer ones. Uneven rhythm reads human; uniform rhythm reads machine.
- **Cut filler & throat-clearing:** no "it's worth noting", "furthermore", "in conclusion", "in today's…", "not just X but Y", sycophantic openers. State things directly.
- **Ban purple-prose words** (delve, tapestry, testament, realm, myriad, robust, seamless…). If a paragraph has 3+ "impressive" words, rewrite plainer.
- **Kill the report/explainer/summarizer voice:** never end a paragraph with an elevated line that states the meaning; never append a clause explaining why an action happened. Earn meaning through the concrete scene.
- **Show emotion, don't name it:** never write "he felt a wave of fear" or "anger surged in her chest"; render it through action and physiology: a hand that won't hold still, a jaw clenched a beat too long.
- **Break templated structure:** no rigid topic→elaborate→example→summary every paragraph; no forced symmetry (3 pros/3 cons), no transition-word chains, no em-dash overload (1–2 per page).
- **Be concrete & specific.** Specificity is the cure for AI smell — a touchable detail beats an abstract noun every time.
- **Leave a surprise.** Humans write at least one sentence you didn't see coming; AI never does.
- **Read-aloud test:** if it sounds like a corporate press release, rewrite it.`
  }
  return `## 像真人写,别像 AI 写

- **句子长短交错(最大的 AI 破绽)。** 绝不连写一串 15–25 字的等长句;短句要短到一拍,长句可铺开,节奏要不均匀——均匀=机器味,长短交错=人味。
- **删套话与铺垫腔:** 不要"值得注意的是""然而/此外/与此同时""总而言之""在这个快节奏的…""不仅……而且…",不要谄媚开场,有话直说。
- **禁空洞美文词:** 不写"淋漓尽致/栩栩如生/熠熠生辉/错落有致""令人不禁/心潮澎湃""一抹/一丝/缓缓/微微"堆叠;一段里冒出 3 个这类词就重写朴素。
- **杀掉报告腔/解释腔/总结腔:** 段末/章末不甩拔高金句替读者总结;动作后不补"为什么"的解释;意义靠具体场景压出来。
- **情绪要演,不要报:** 别直接写"他感到一阵恐惧""心中涌起愤怒",用动作、生理反应、感官细节让读者自己感到(手按不住地抖、喉咙发紧、把杯子攥出白印)。
- **禁套话意象:** 不写"空气仿佛凝固""气氛凝重""心跳漏了一拍""嘴角勾起一抹""深吸一口气""百感交集"这类批量货——换成此情此景独有的具体细节。
- **禁用句式(机器会逐条机检,出现即点名):**"不是A,而是B"及其逗号变体"不是X,是Y""不是急,不是求,是…"三连排比;",带着…"逗号拖尾;"仿佛/犹如…一般"明喻套壳;"他不知道的是…"章末预言;"这一刻终于明白"顿悟总结;"一种说不出的/说不上来的…"模糊兜底。示范:"不是急,不是求,是一种说不上来的笃定"→"那眼神太笃定了,像早就知道他会接。"
- **身体反应多样性:** 同一生理反应词(嗡/发凉/发紧/攥/僵)每章至多一次,第二次必须换成此人此景特有的反应——"脑子嗡了一下"再次出现时,改写成"耳朵里只剩自己咽口水的声音"这类只属于当下的写法。
- **打破模板结构:** 别每段都"主题句→展开→举例→小结";别强行对称(三优点三缺点);别一连串转折词开头;破折号每页 1–2 处足矣。
- **具体、可感。** 具体性是去 AI 味的解药——一个读者碰过的实物细节,胜过十个抽象名词。
- **留一句惊喜。** 真人至少写一句你没料到的;AI 从不。
- **朗读测试:** 读出来像企业通稿,就重写。`
}
