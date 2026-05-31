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

// ── 中文:空洞宏大/AI 高频"美文词"(过量即 AI 味)──────────────
export const CN_SLOP_WORDS: readonly string[] = [
  "不禁", "不由得", "莫名", "仿佛", "似乎", "彷佛", "无疑", "无不", "无一不",
  "淋漓尽致", "栩栩如生", "跃然纸上", "熠熠生辉", "错落有致", "美轮美奂", "五彩斑斓",
  "令人", "让人", "令人不禁", "让人不由", "不禁让人", "令人动容", "令人心潮澎湃",
  "缓缓", "轻轻", "微微", "淡淡", "悄然", "渐渐", "缓缓地", "轻轻地",
  "一抹", "一丝", "一缕", "一阵", "一种说不出的", "某种莫名的",
  "心跳漏了一拍", "嘴角勾起", "嘴角微微上扬", "深吸一口气", "倒吸一口凉气",
  "空气仿佛凝固", "气氛凝重", "时间仿佛静止", "一股暖流", "百感交集", "五味杂陈",
]

// ── 中文:套话/机械连接词/三段式残留(说明文腔,小说尤其要少)──
export const CN_FILLER_PHRASES: readonly string[] = [
  "值得注意的是", "值得一提的是", "需要指出的是", "不可否认", "众所周知",
  "总而言之", "综上所述", "总的来说", "由此可见", "归根结底", "毫无疑问",
  "与此同时", "然而", "此外", "另外", "其次", "再者", "首先", "最后",
  "不仅仅是", "不仅……而且", "正如", "正所谓", "换句话说", "也就是说",
  "在这个", "在当今", "在这个快节奏的", "在如今",
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
- **打破模板结构:** 别每段都"主题句→展开→举例→小结";别强行对称(三优点三缺点);别一连串转折词开头;破折号每页 1–2 处足矣。
- **具体、可感。** 具体性是去 AI 味的解药——一个读者碰过的实物细节,胜过十个抽象名词。
- **留一句惊喜。** 真人至少写一句你没料到的;AI 从不。
- **朗读测试:** 读出来像企业通稿,就重写。`
}
