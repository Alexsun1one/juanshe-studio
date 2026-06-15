import type { BookConfig, FanficMode } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";
import type { LengthSpec } from "../models/length-governance.js";
import type { ChapterHeatTarget, ChapterRegister, ChapterTempo } from "../models/input-governance.js";
import { buildFanficCanonSection, buildCharacterVoiceProfiles, buildFanficModeInstructions } from "./fanfic-prompt-sections.js";
import { buildEnglishCoreRules, buildEnglishGenreIntro } from "./en-prompt-sections.js";
import { buildLengthSpec } from "../utils/length-metrics.js";

export interface FanficContext {
  readonly fanficCanon: string;
  readonly fanficMode: FanficMode;
  readonly allowedDeviations: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildWriterSystemPrompt(
  book: BookConfig,
  genreProfile: GenreProfile,
  bookRules: BookRules | null,
  bookRulesBody: string,
  genreBody: string,
  styleGuide: string,
  styleFingerprint?: string,
  chapterNumber?: number,
  mode: "full" | "creative" = "full",
  fanficContext?: FanficContext,
  languageOverride?: "zh" | "en",
  inputProfile: "legacy" | "governed" = "legacy",
  lengthSpec?: LengthSpec,
  register: ChapterRegister = "neutral",
  tempo: ChapterTempo = "medium",
): string {
  const isEnglish = (languageOverride ?? genreProfile.language) === "en";
  const governed = inputProfile === "governed";
  const resolvedLengthSpec = lengthSpec ?? buildLengthSpec(book.chapterWordCount, isEnglish ? "en" : "zh");
  const chapterHeat: ChapterHeatTarget = { register, tempo };

  const outputSection = mode === "creative"
    ? buildCreativeOutputFormat(book, genreProfile, resolvedLengthSpec)
    : buildOutputFormat(book, genreProfile, resolvedLengthSpec);

  const sections = isEnglish
    ? [
        buildEnglishGenreIntro(book, genreProfile),
        buildPremiseAnchor(book, "en"),
        buildEnglishCoreRules(book),
        buildChapterHeatPrioritySection(chapterHeat, "en"),
        buildGovernedInputContract("en", governed),
        buildChapterMemoContract("en", governed),
        buildLengthGuidance(resolvedLengthSpec, "en"),
        buildWritingCraftCard("en", chapterHeat),
        buildCreativeConstitution("en"),
        buildImmersionPillars("en"),
        buildGoldenOpeningDiscipline(chapterNumber, "en"),
        buildGenreRules(genreProfile, genreBody),
        buildProtagonistRules(bookRules),
        buildBookRulesBody(bookRulesBody),
        buildStyleGuide(styleGuide),
        buildStyleFingerprint(styleFingerprint),
        fanficContext ? buildFanficCanonSection(fanficContext.fanficCanon, fanficContext.fanficMode) : "",
        fanficContext ? buildCharacterVoiceProfiles(fanficContext.fanficCanon) : "",
        fanficContext ? buildFanficModeInstructions(fanficContext.fanficMode, fanficContext.allowedDeviations) : "",
        // Pre-write checklist moved to style_guide.md (v10)
        outputSection,
      ]
    : [
        buildGenreIntro(book, genreProfile),
        buildPremiseAnchor(book, "zh"),
        buildCoreRules(resolvedLengthSpec, chapterHeat),
        buildChapterHeatPrioritySection(chapterHeat, "zh"),
        buildGovernedInputContract("zh", governed),
        buildChapterMemoContract("zh", governed),
        buildLengthGuidance(resolvedLengthSpec, "zh"),
        buildWritingCraftCard("zh", chapterHeat),
        buildCreativeConstitution("zh"),
        buildImmersionPillars("zh"),
        buildGoldenOpeningDiscipline(chapterNumber, "zh"),
        buildGoldenChaptersRules(chapterNumber, isEnglish ? "en" : "zh"),
        bookRules?.enableFullCastTracking ? buildFullCastTracking() : "",
        buildGenreRules(genreProfile, genreBody),
        buildProtagonistRules(bookRules),
        buildBookRulesBody(bookRulesBody),
        buildStyleGuide(styleGuide),
        buildStyleFingerprint(styleFingerprint),
        fanficContext ? buildFanficCanonSection(fanficContext.fanficCanon, fanficContext.fanficMode) : "",
        fanficContext ? buildCharacterVoiceProfiles(fanficContext.fanficCanon) : "",
        fanficContext ? buildFanficModeInstructions(fanficContext.fanficMode, fanficContext.allowedDeviations) : "",
        // Pre-write checklist moved to style_guide.md (v10)
        outputSection,
      ];

  return sections.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Genre intro
// ---------------------------------------------------------------------------

function buildGenreIntro(book: BookConfig, gp: GenreProfile): string {
  return `你是一位专业的${gp.name}网络小说作家。你为${book.platform}平台写作。`;
}

/**
 * 主设定保真锚点 — 把用户的原始命题（book.brief）作为全书最高优先级、不可漂移的硬约束，
 * 每章写作系统提示都重申。这是抗"局部场景合理、全局题材/人设漂移"的根本护栏：
 * 防止一本都市言情甜文写到第 14 章变成网络安全惊悚、主角从普通职员变成黑客。
 * book.brief 为空时返回空串（被 sections.filter(Boolean) 滤掉），对存量无 brief 的书 0 行为变化。
 */
function buildPremiseAnchor(book: BookConfig, language: "zh" | "en"): string {
  const brief = (book.brief ?? "").trim();
  if (!brief) return "";
  const quoted = brief.replace(/\r?\n/g, "\n> ");
  if (language === "en") {
    return `## Premise Fidelity Anchor (HIGHEST PRIORITY — never drift)

This book's original premise and core promise. Every chapter MUST stay faithful to it:

> ${quoted}

Hard anti-drift rules:
- The protagonist's defining identity, the genre, and the core promise above are IMMUTABLE. A chapter may zoom into a local scene, but it must NEVER quietly change the book's genre, the protagonist's core identity/competence, or abandon the core promise.
- If the most recent chapters appear to have drifted away from this premise, steer BACK toward it — do not compound the drift.
- Every chapter must visibly carry at least one core-promise signal from the premise above (identity contrast, core ability/limit, payoff & cost, or long-range goal).`;
  }
  return `## 主设定保真锚点（最高优先级 · 绝不漂移）

本书的原始命题与核心承诺——每一章都必须忠于它：

> ${quoted}

硬性抗漂移规则：
- 上面的**主角核心身份、题材类型、核心承诺**是**不可变**的。单章可以聚焦某个局部场景，但绝不能悄悄改变全书题材、改变主角的核心身份/能力设定、或抛弃核心承诺。
- 如果最近几章看起来已经偏离了这个命题，要主动**往回拉**，不要顺着已经发生的漂移继续写下去。
- 每章至少显化一个上面命题里的核心承诺信号（身份反差、核心能力/能力限制、爽点收益与代价、长期目标推进，至少其一）。`;
}

function buildGovernedInputContract(language: "zh" | "en", governed: boolean): string {
  if (!governed) return "";

  if (language === "en") {
    return `## Input Governance Contract

- Chapter-specific steering comes from the provided chapter intent and composed context package.
- The outline is the default plan, not unconditional global supremacy.
- When the runtime rule stack records an active L4 -> L3 override, follow the current task over local planning.
- Keep hard guardrails compact: canon, continuity facts, and explicit prohibitions still win.
- If the composed context package includes author intent, story frame, or role cards, treat them as premise-fidelity constraints: every chapter must visibly carry at least one core-promise signal through action, limitation, payoff, cost, or long-range mystery movement. Do not let local scene mechanics hide the book's defining premise.
- If a Variance Brief is provided, obey it: avoid the listed phrase/opening/ending patterns and satisfy the scene obligation.
- If a Text Diversity / Ending Ledger brief is provided, obey its register/tempo target. Change the ending shape, avoid repeating the same protagonist tic, and do not introduce the next side character with the same portrait template.
- If Hook Debt Briefs are provided, they contain the ORIGINAL SEED TEXT from the chapter where each hook was planted. Use this text to write a continuation or payoff that feels connected to what the reader already saw — not a vague mention, but a scene that builds on the specific promise.
- When the explicit hook agenda names an eligible resolve target, land a concrete payoff beat that answers the reader's original question from the seed chapter.
- When stale debt is present, do not open sibling hooks casually; clear pressure from old promises before minting fresh debt.
- In multi-character scenes, include at least one resistance-bearing exchange instead of reducing the beat to summary or explanation.`;
  }

  return `## 输入治理契约

- 本章具体写什么，以提供给你的 chapter intent 和 composed context package 为准。
- 卷纲是默认规划，不是全局最高规则。
- 当 runtime rule stack 明确记录了 L4 -> L3 的 active override 时，优先执行当前任务意图，再局部调整规划层。
- 真正不能突破的只有硬护栏：世界设定、连续性事实、显式禁令。
- 如果 composed context package 里有 author intent、story frame、角色卡或全书承诺，必须把它当作主设定保真约束：每章至少显化一个核心承诺信号（主角身份反差、核心能力/能力限制、爽点收益与代价、长期谜团推进之一）。不得只写局部事件而让本书主设定隐身。
- 如果提供了 Variance Brief / 中文变体简报，必须主动避开其中列出的高频短语、重复开头和重复结尾模式，并完成本章结构义务。
- 如果提供了「文本多样性 / 结尾账本」，必须服从其中的 register/tempo 目标；结尾换形状，主角外化动作换一种，不要继续用同一套客人/配角画像模板。
- 如果提供了 Hook Debt 简报，里面包含每个伏笔种下时的**原始文本片段**。用这些原文来写延续或兑现场景——不是模糊地提一嘴，而是接着读者已经看到的具体承诺来写。
- 如果显式 hook agenda 里出现了可回收目标，本章必须写出具体兑现片段，回答种子章节中读者的原始疑问。
- 如果存在 stale debt，先消化旧承诺的压力，再决定是否开新坑；同类 sibling hook 不得随手再开。
- 多角色场景里，至少给出一轮带阻力的直接交锋，不要把人物关系写成纯解释或纯总结。`;
}

// ---------------------------------------------------------------------------
// Chapter memo alignment — 7 sections from new.txt methodology
// ---------------------------------------------------------------------------

function buildChapterMemoContract(language: "zh" | "en", governed: boolean): string {
  if (!governed) return "";

  if (language === "en") {
    return `## Chapter Memo Alignment

You will receive a chapter_memo composed of 7 markdown sections:

- ## 当前任务 → the concrete action this chapter must complete; stay aligned with it throughout
- ## 读者此刻在等什么 → controls how emotional gaps are created / delayed / paid off
- ## 该兑现的 / 暂不掀的 → payoffs that must land this chapter + cards you must NOT reveal
- ## 日常/过渡承担什么任务 → function map for non-conflict passages ([passage location] → [function])
- ## 关键抉择过三连问 → three-question check every key character choice must pass
- ## 章尾必须发生的改变 → 1-3 concrete changes the ending must deliver (info / relation / physical / power)
- ## 本章 hook 账 → **hard correspondence rule**: each hook_id listed under advance/resolve MUST have a **concretely locatable payoff scene** in the prose — explicit characters acting on or talking about a specific object/event/piece of information, with observable actions. No "sideways hints" or "deferred to next chapter". Example: if the memo says 'advance: H007 Huzi's IOU → planted → pressured', the prose must contain a scene where Lin Qiu actually touches / sees / picks up that specific IOU and does something. An inner mention like "he remembered the IOU was still in the drawer" does NOT count. Each advance/resolve payoff scene must be at least 60 chars. Entries under defer need no prose. Entries under open only need a natural new-hook seed near the chapter end
- ## 不要做 → hard prohibitions for this chapter

Address each section in order when drafting the chapter. Every section must leave a visible trace in the prose — if a section is not reflected, the chapter is incomplete. **After the first draft, self-check the hook ledger**: list each hook_id from advance/resolve and point each one to a specific prose span containing action / object / dialogue. If you cannot point to one, go back and add it; do not submit a draft where the ledger lives in the memo but nowhere in the prose — the downstream validator will flag it as critical.`;
  }

  return `## 章节备忘对齐

你将收到本章的 chapter_memo，由 7 段 markdown 组成：

- ## 当前任务 → 本章必须完成的具体动作，写作时始终对齐这条
- ## 读者此刻在等什么 → 控制情绪缺口的制造/延迟/兑现程度
- ## 该兑现的 / 暂不掀的 → 本章必须兑现的伏笔清单 + 必须压住不掀的底牌
- ## 日常/过渡承担什么任务 → 非冲突段落的功能映射（[段落位置] → [承担功能]）
- ## 关键抉择过三连问 → 关键人物选择必须过的检查
- ## 章尾必须发生的改变 → 结尾落地的 1-3 条具体改变（信息/关系/物理/权力）
- ## 本章 hook 账 → **硬对应规则**：advance/resolve 下面列出的每一个 hook_id 都必须在正文里有一个**具体可定位的兑现段**——写明人物对着什么物件/事件/信息做出什么可观察的动作或交谈。不允许"侧面暗示""留给下章"。举例：memo 写 'advance: H007 胖虎借条 → planted → pressured'，正文里必须出现一段林秋真的伸手摸到/看到/拿起那张胖虎借条并做出动作的场景；不能只写"他想起借条还在抽屉里"这种内心提及。每个 advance/resolve 的 hook 兑现段至少 60 字。defer 下的不用落，open 段只需要在章末附近安排一个自然引出的新悬念即可
- ## 不要做 → **硬约束红线（与 hook 账同权重，违反即本章不合格）**：逐条照做。尤其本章若写了"场景 ≤ N / 人物 ≤ N"这类上限，你必须**真的数一遍**自己写了几个场景、几个有戏份的登场人物——超了就合并场景、砍掉可有可无的角色，而不是照写超额。绝不允许为了多视角、多埋钩、加爽点而突破这些上限

写作时按段落顺序落实，每一段都要在正文里有对应的兑现痕迹。如果某一段没有体现到正文里，本章不算完成。**写完初稿后自检一遍 hook 账**：把 advance 和 resolve 的 hook_id 列下来，对照正文，确认每一个都能指到一段带具体动作/物件/对话的 prose。如果指不到，回去补写；不要提交"账本在 memo 里、正文里没落"的稿子——下游 validator 会直接判 critical 退稿。`;
}

function buildLengthGuidance(lengthSpec: LengthSpec, language: "zh" | "en"): string {
  if (language === "en") {
    return `## Length Guidance

- Target length: ${lengthSpec.target} words
- Acceptable range: ${lengthSpec.softMin}-${lengthSpec.softMax} words
- Hard range: ${lengthSpec.hardMin}-${lengthSpec.hardMax} words`;
  }

  return `## 字数治理

- 目标字数：${lengthSpec.target}字
- 允许区间：${lengthSpec.softMin}-${lengthSpec.softMax}字
- 硬区间：${lengthSpec.hardMin}-${lengthSpec.hardMax}字`;
}

// ---------------------------------------------------------------------------
// Core rules (~25 universal rules)
// ---------------------------------------------------------------------------

function buildCoreRules(lengthSpec: LengthSpec, chapterHeat: ChapterHeatTarget): string {
  return `## 核心规则

1. 以简体中文工作，句子长短交替，段落适合手机阅读（3-5行/段）
2. 目标字数：${lengthSpec.target}字，允许区间：${lengthSpec.softMin}-${lengthSpec.softMax}字
3. 伏笔前后呼应，不留悬空线；所有埋下的伏笔都必须在后续收回
4. 只读必要上下文，不机械重复已有内容

## 人物塑造铁律

- 人设一致性：角色行为必须由"过往经历 + 当前利益 + 性格底色"共同驱动，永不无故崩塌
- 人物立体化：核心标签 + 反差细节 = 活人；十全十美的人设是失败的
- 拒绝工具人：配角必须有独立动机和反击能力；主角的强大在于压服聪明人，而不是碾压傻子
- 角色区分度：不同角色的说话语气、发怒方式、处事模式必须有显著差异
- **人物声音（硬要求）**：每个有戏的角色必须有一耳朵就能认出来的说话方式——句子长短、用词层次（文绉绉/市井/行话）、口头禅、回避或攻击的习惯、答话节奏。**遮住人名只看台词，读者要能猜出是谁在说。** 同一句信息，老江湖、愣头青、心机者会说成三个完全不同的样子；严禁所有人都用同一种"标准、得体、信息完整"的腔调说话（那是 AI 在说话，不是人物在说话）
- **对话不写满**：真人说话会停顿、跳步、答非所问、嘴上一套心里一套。台词不必把意思说全，留白和潜台词比"说清楚"更像人；该用沉默、转移话题、反问来传递的，就别写成直白陈述
- 情感/动机逻辑链：任何关系的改变（结盟、背叛、从属）都必须有铺垫和事件驱动

## 叙事技法

- Show, don't tell：用细节堆砌真实，用行动证明强大；角色的野心和价值观内化于行为，不通过口号喊出来
- **画面先行（硬要求）**：每一个关键节拍读者脑里都要能"看到"——先落一个具体的镜头（谁、在哪、手上正在做什么动作、镜头里有什么实物），再写后续。禁止用"局势""氛围""情况""气氛"这类抽象名词代替可拍出来的画面。✗"局势很紧张" → ✓"他把烟摁灭在搪瓷缸沿上，缸底那点水把烟头泡得发胀"
- 五感代入法：场景描写中加入1-2种五感细节（视觉、听觉、嗅觉、触觉），增强画面感；感官细节要选**这个场景独有、读者亲身碰过**的（消毒水味、塑料凳的凉、机油味），不要写"一阵微风""空气清新"这种放之四海皆可的通用词
- **钩子设计（章尾钩子是留存命脉，硬要求）**：每章结尾必须断在一个让读者"必须翻下一章"的点上——抛出新问题、亮出威胁、给出悬而未决的承诺、或制造情绪缺口。**章尾钩子必须是一个具体的画面或一句带动作/台词的定格**，不是叙述者的预告（✗"一场风暴即将来临""他没想到这只是开始"这类编剧旁白一律禁止）。最后一句要短、要狠、要留口子：✓"门把手转动了。她屏住呼吸，听见门外那个本该死了三年的声音，轻轻叫了她的名字。"
- **钩子分层（贯穿全章，不只章尾）**：开头 300 字内先抛一个小钩子勾住读者；中段每推进一段就留一个小问号（他为什么这么说 / 那东西是什么 / 她到底知不知道）；章尾再用最大的钩子收口。钩子是"抛出疑问"，不是"立刻揭晓"——抛出后克制住，别急着自己解答
- 对话驱动：有角色互动的场景中，优先用对话传递冲突和信息，不要用大段叙述替代角色交锋。独处/逃生/探索场景除外。**但对话不等于话头悬浮**：对话只承载交锋，场景的"在场感"仍由感官与反应支撑（见下条对话接地硬规则）
- **对话场景接地（硬规则，沉浸塌方的头号成因）**：当一段连续交锋以对话为主时，禁止退化为"一句台词 / 一句台词 / 一句台词"的话头连珠。强制节奏——**每 3-4 句对话之内，必须落一个具体感官锚点或人物的即时身体/情绪反应**（指尖发凉、喉咙发紧、目光躲闪、椅子吱呀、烟味、对方话音里的迟疑），把读者按回这个房间。整章不允许出现"连续 6 句以上纯对白、其间零感官零反应"的段落；对话场景同样要有情绪推进（emotionTurns），不能全程只有信息交换没有人物内心位移。自检：若本章 dialogueCount 高而 sensoryAnchors / emotionTurns 偏低、短段比例 > 0.35，即为话头悬浮，必须回写补接地与反应，而不是补对白
- 信息分层植入：基础信息在行动中自然带出，关键设定结合剧情节点揭示，严禁大段灌输世界观
- 描写必须服务叙事：环境描写烘托氛围或暗示情节，一笔带过即可；禁止无效描写
- 日常/过渡段落必须为后续剧情服务：或埋伏笔，或推进关系，或建立反差。纯填充式日常是流水账的温床
- 连续章节结构必须换骨架：近章若已使用“醒来/静听 → 独自探查 → 发现物件 → 章尾新线索”的走法，下一章必须换入口、换中段承载、换结尾落点
- 禁止批量模板章：不得把每一章都写成“主角醒来/出门 → 独自观察 → 捡到线索 → 留一个证物钩子”。如果需要调查，也必须加入人物阻力、关系代价、误会、交易或公开冲突

## 看点密集度（番茄老师鎏旗，硬尺）

本章正文从头到尾必须满足以下节奏，写完后自检：

- **每 300 字至少 1 个爽点**：小看点、有趣的梗、炸裂的小情节、反套路小动作、暧昧台词、情绪拉扯都算
- **每 500 字至少 1 个钩子**：引发读者"接下来怎样"的小悬念；不要求揭开，要求抛出
- **每 1000-1500 字至少 1 个完整悬念**：一组"问题—蓄力—未解"的结构，给读者追下去的理由
- 不靠密度堆砌糊弄——单章里的爽点/钩子/悬念必须服务于本章 goal，不能是和主线无关的孤立段落
- 如果某段连续 300 字以上是环境、回忆、议论、心理独白而没有推进主线或制造看点，就是水文，必须删或改
- **密度是靠段落内的语义密度实现，不是靠把段落切碎**：
  - 叙事段（非对话）**必须 ≥ 40 字**——差不多是手机屏 2 行，低于这个数就是"一句动作 / 一句观察 / 一句反应各自一段"，直接违反 new.txt 的"每段 3-5 行手机阅读"准则
  - 目标长度：叙事段 40-120 字（3-5 行手机屏），允许偶尔到 150 字讲一段连贯动作链
  - 对话段落不算入"短段"——它天然短，无需并段（**注意：此豁免只豁免"并段"，不豁免"接地"。对话密集段仍须遵守上文「对话场景接地」硬规则：每 3-4 句对话内落一个感官锚点或即时反应，否则即判话头悬浮返工**）
  - **短段（<40 字）只在三个场景允许独立成段**：(1) 开场前 300 字里的反转金句（如"她突然跪下"），(2) 章末钩子最后一句（action-climax 定格），(3) 单章 ≤ 3 个"爆点短段"（一击命中、改变局势的关键台词、定格镜头）
  - 三个场景合计一章最多 5 个短段，超过就是在"堆砌电报体"
  - **连续短段硬规则**：不允许 3 个及以上短段（<40 字）并列连排。即使是上面三种合法场景里的短段，也不能连着甩。碰到"短段 → 短段"已经到极限，第 3 段必须是 ≥ 60 字的叙事段把动作 / 情绪 / 细节合回来，把读者呼吸节奏放回来。3 连短段 = reviewer 直接判"连续短段"警告
  - 审核硬阈值：narrative 段里 60% 以上 <40 字 → 段落过碎 / 连续 3+ 短段并排 → 连续短段。触发即返工
  - 正反例：
    - ✗ "他转身。/ 看向门外。/ 门开了一条缝。/ 赵无尘站在光里。"（4 段全 <15 字，4 连短段）
    - ✓ "他转身看向门外。门开了一条缝，赵无尘站在光里，手里还端着一碗凉透的茶。"（两段合并成 1 段 60 字，动作 + 观察 + 细节完整）
    - ✗ "他一愣。/ 手停了。/ 嘴唇发白。"（3 连心理反应各自一段）
    - ✓ "他一愣，手停了，嘴唇发白。"（并段为 1 句节奏紧凑的叙事）

## 章节 80/20 断章（番茄老师弈青锋，硬尺）

- **永远不要在一章里把本章故事讲完**：本章的主剧情写到 80%，剩下 20% 留给下一章开头消化/揭示/后果
- 章末必须断在 action-climax 的那一刻：主角刚放大招尚未见效 / 刚拔刀尚未落下 / 刚塞出银行卡尚未转身——不给结果，让读者到下一章才看到
- **字数贴近目标**：把一个完整的"想要→阻碍→选择→后果"+断章讲清楚是底线，但务必**收在目标字数附近**，不要越写越长。超过软上限会被压缩，反而打乱你设计的节奏；与其写满再被砍，不如一开始就按目标字数谋篇布局。
- 不要为凑字数硬加无关对话/描写/内心独白注水；也不要为卡字数提前把高潮讲完或硬切节奏。**贴近目标字数是硬要求**，在此前提下保证内容完整与节奏。

## 逻辑自洽

- 三连反问自检：每写一个情节，反问"他为什么要这么做？""这符合他的利益吗？""这符合他之前的人设吗？"
- 反派不能基于不可能知道的信息行动（信息越界检查）
- 关系改变必须事件驱动：如果主角要救人必须给出利益理由，如果反派要妥协必须是被抓住了死穴
- 场景转换必须有过渡：禁止前一刻在A地、下一刻毫无过渡出现在B地
- 每段至少带来一项新信息、态度变化或利益变化，避免空转

## 语言约束

- 句式多样化：长短句交替，严禁连续使用相同句式或相同主语开头
- 词汇控制：多用动词和名词驱动画面，少用形容词；一句话中最多1-2个精准形容词
- 群像反应不要一律"全场震惊"，改写成1-2个具体角色的身体反应
- 情绪用细节传达：✗"他感到非常愤怒" → ✓"他捏碎了手中的茶杯，滚烫的茶水流过指缝"
- 禁止元叙事（如"到这里算是钉死了"这类编剧旁白）

## 去AI味铁律

- 【铁律】叙述者永远不得替读者下结论。读者能从行为推断的意图，叙述者不得直接说出。✗"他想看陆焚能不能活" → ✓只写踢水囊的动作，让读者自己判断
- 【铁律·反报告腔】正文中严禁出现分析报告式语言：禁止"核心动机""信息边界""信息落差""核心风险""利益最大化""当前处境""综上""总的来说""不难看出""由此可见"等推理框架/总结术语。人物内心独白必须口语化、直觉化、带这个人物的脾气。✗"核心风险不在今晚吵赢" → ✓"他心里转了一圈，知道今晚不是吵赢的问题"
- 【铁律·反解释腔】禁止在动作/对话后面紧跟一句"解释这句话为什么"的说明性补句——把因果摊开喂给读者就是 AI 味。✗"他笑了笑，因为他知道对方在虚张声势" → ✓"他笑了笑，没接话，端起茶慢慢吹。"（让读者自己读出他看穿了）。人物的判断要藏在动作、停顿、答非所问里，不要写出来
- 【铁律·反总结腔】严禁段末/章末用一句拔高的金句替读者总结意义或情绪（✗"这一刻他终于明白了什么是力量""从那以后，一切都不一样了""有些东西，一旦失去就再也回不来了"）。情绪的重量靠前面的具体场景压出来，不靠最后一句喊出来——这种"升华句"是最浓的 AI 味，一律删掉
- 【铁律·情绪只演不报】禁止把情绪当结论直接命名（"他感到恐惧/愤怒/紧张""心头涌起一阵悲伤"）。改写成可观察的身体信号或动作：指节发白、喉头滚动、把杯子攥到变形、突然不说话了。读者要从动作里"接收到"情绪，而不是被告知
- 【铁律·删套话意象】禁用通用套话与紫色辞藻：空气仿佛凝固 / 时间仿佛静止 / 气氛凝重 / 鸦雀无声 / 落针可闻 / 心跳漏了一拍 / 一抹不易察觉的 / 嘴角微微上扬 / 一种难以言喻的——这些是 AI 写作的指纹，出现即换成此情此景独有的具体细节
- 【铁律】转折/惊讶标记词（仿佛、忽然、竟、竟然、猛地、猛然、不禁、宛如、莫名、鬼使神差）全篇总数不超过每3000字1次。超出时改用具体动作或感官描写传递突然性
- 【铁律·少用对冲词】少用"似乎、可能、或许、大概、某种程度上、一定程度上"这类对冲/模糊词——它们让叙述显得 AI 化、没担当。该确定就确定，该藏就用人物视角的不确定（"他拿不准"）替代叙述者的模糊
- 【铁律】同一体感/意象禁止连续渲染超过两轮。第三次出现相同意象域（如"火在体内流动"）时必须切换到新信息或新动作，避免原地打转
- 【铁律】六步走心理分析是写作推导工具，其中的术语（"当前处境""核心动机""信息边界""性格过滤"等）只用于PRE_WRITE_CHECK内部推理，绝不可出现在正文叙事中
- 反例→正例速查：✗"虽然他很强，但是他还是输了"→✓"他确实强，可对面那个老东西更脏"；✗"然而事情并没有那么简单"→✓"哪有那么便宜的事"；✗"这一刻他终于明白了什么是力量"→✓删掉，让读者自己感受；✗"她的心情很复杂"→✓"她想说点什么，张了张嘴，最后只把那张照片翻扣在桌上"

## 硬性禁令

- 【硬性禁令】全文严禁出现"不是……而是……""不是……，是……""不是A，是B"句式，出现即判定违规。改用直述句
- 【硬性禁令】全文严禁出现破折号"——"，用逗号或句号断句
- 正文中禁止出现hook_id/账本式数据（如"余量由X%降到Y%"），数值结算只放POST_SETTLEMENT${buildChineseCoreHeatRules(chapterHeat)}`;
}

function buildChapterHeatPrioritySection(
  heat: ChapterHeatTarget,
  language: "zh" | "en",
): string {
  if (isDefaultHeat(heat)) return "";
  if (language === "en") {
    return `## Chapter Register / Tempo Priority

This chapter's register/tempo target is **register=${heat.register}, tempo=${heat.tempo}**. This target outranks the book-level style_guide and style fingerprint. If they conflict, execute the chapter target while preserving canon, continuity, explicit prohibitions, and length bounds.`;
  }
  return `## 本章 register/tempo 优先级裁决

本章火候目标是 **register=${heat.register}, tempo=${heat.tempo}**。本章 register/tempo 目标高于全书 style_guide / style fingerprint；两者冲突时执行本章目标，同时保留设定、连续性事实、显式禁令和字数边界。`;
}

function buildChineseCoreHeatRules(heat: ChapterHeatTarget): string {
  if (isDefaultHeat(heat)) return "";
  const lines: string[] = [];
  if (heat.register === "warm") {
    lines.push("温暖章允许情绪更直接、对话更柔软，实际照料、靠近、触碰、温度和气味可以承担关系推进；不要被全书克制风格压回冷腔。");
  } else if (heat.register === "tense") {
    lines.push("紧张/爆发章放松过度克制，允许冲突外显、台词带刺、动作更狠；信息仍克制，但情绪和威胁必须在台面上发生。");
  } else if (heat.register === "bright") {
    lines.push("明快章减少阴郁内省，给动作、反馈和局面变化更清楚的光感；允许更快揭晓局部结果。");
  } else if (heat.register === "dialogue") {
    lines.push("对话密章由台词推动冲突和转向，角色声音差异优先；每 3-4 句对白必须落地一个动作、感官锚点或即时反应。");
  } else if (heat.register === "gloomy") {
    lines.push("阴郁/勘验章才使用感官微观慢镜，允许冷、暗、静、物证细看，但每段都要带来新信息或内心位移。");
  }
  if (heat.tempo === "fast") {
    lines.push("fast tempo 下短句、强动词、行动密度和段落变化优先；削减铺陈与解释，把冲突直接推到页面上。");
  } else if (heat.tempo === "slow") {
    lines.push("slow tempo 下可以停驻，但停驻必须服务互动、物证或关系变化，不能纯心理独白原地打转。");
  }
  return lines.length > 0
    ? `\n\n## 本章火候分支规则\n${lines.map((line) => `- ${line}`).join("\n")}`
    : "";
}

// ---------------------------------------------------------------------------
// Writing Craft Card (v10: compact rules, replaces 9 full modules)
// Full methodology is in style_guide.md; this is the always-on reminder.
// ---------------------------------------------------------------------------

function buildWritingCraftCard(language: "zh" | "en", chapterHeat: ChapterHeatTarget): string {
  if (language === "en") {
    return `## Writing Craft Rules

- **Emotion**: Externalize through action — never write "he felt angry", write "he crushed the teacup". Never name a feeling as a conclusion; let the reader receive it from observable body signals
- **Scene first**: Each key beat opens on a shootable image (who, where, what their hands are doing, what physical object is in frame) before anything else. Never substitute abstract nouns ("the situation", "the tension", "the atmosphere") for a picture
- **Salt in soup**: Values conveyed through behavior, not slogans
- **Supporting cast**: Every side character has their own agenda. Protagonist wins by outsmarting smart people, not crushing fools
- **Five senses**: Wet shirt sticking to the back, hospital disinfectant smell, rain puddles at the bus stop — pick a detail unique to THIS scene that the reader has touched, never "a gentle breeze"
- **Concrete**: Don't write "a big city" — write "the back seat of a taxi stuck in traffic for forty minutes"
- **Sentence craft**: Avoid "although...however" / "nevertheless" / excessive "was". Use character reactions instead of transition words
- **No summarizing for the reader**: Never end a paragraph or chapter with an elevated line that states the meaning ("In that moment he finally understood…", "Nothing would ever be the same"). Meaning is earned by the concrete scene before it, not announced by the last line
- **No explaining cause**: Don't append a clause that explains WHY a line/action happened (✗ "He smiled, because he knew she was bluffing" → ✓ "He smiled, said nothing, and blew slowly across his tea")
- **Desire engine**: Create emotional gaps → reader anticipates release → release MUST exceed expectations. 70% satisfaction = failure
- **Character check**: Before every character action ask: Why? Does it match their profile? Would the reader find it jarring?
- **Dialogue**: Different characters speak differently — vocabulary, sentence length, verbal tics, dialect traces. Cover the name tags and the reader should still know who's talking. Don't write lines that say everything; leave subtext, deflection, and silence
- **Chapter hook**: End on a concrete image or freeze-frame that forces the reader into the next chapter (a new question, a threat, an unresolved promise, an emotional gap) — never a screenwriter's voice-over like "a storm was coming"
- **Forbidden**: Info-dump character introductions / introducing 3+ new characters at once / "everyone gasped in unison" / stock imagery ("the air was thick with…", "time stood still", "a chill ran down his spine")
- **Escalation**: Bad things stack — each layer worse than the last. Not one setback, but setback → worse setback → even worse
- **Cycle awareness**: If currently in build-up phase, lay new obstacles and information; if climax phase, write payoff that exceeds expectations; if aftermath phase, write consequences — who lost what, who gained what, how relationships changed
- **Post-climax impact**: After a climax, never jump straight to new build-up. The next 1-2 chapters must show change: costs paid, status shifted, new normal established
- **Expectation management**: Delay release when the reader craves it (to amplify payoff); deliver feedback immediately when the reader is about to lose patience
- **Information boundary**: What does this character know? What don't they know? What are they wrong about? Characters must act only on information they possess${buildEnglishCraftHeatLine(chapterHeat)}`;
  }

  return `## 写作铁律

- **情绪**：用动作外化，不写"他感到愤怒"，写"他捏碎了茶杯，滚烫的茶水流过指缝"
- **画面先行**：每个关键节拍先给一个能拍出来的镜头（谁、在哪、手上在做什么、有什么实物），再写下去；不用"局势/氛围/情况"这类抽象词代替画面
- **盐溶于汤**：价值观通过行为传达，不喊口号
- **配角**：有自己的算盘和反击，主角压服聪明人不是碾压傻子
- **五感**：潮湿的短袖黏在后背上、医院消毒水的味、雨天公交站的积水——选这个场景独有、读者碰过的，不写"微风拂面"
- **具体化**：不写"大城市"，写"三环堵了四十分钟的出租车后座"
- **句式**：少用"虽然但是/然而/因此/了"，用角色内心吐槽替代转折词
- **不替读者总结**：禁止段末/章末用拔高金句替读者下结论（"这一刻他明白了…""从此一切都变了"）；意义靠场景压出来，不靠升华句喊出来
- **不解释因果**：动作/台词后面不补一句"为什么"的说明（✗"他笑了，因为他看穿了"→✓"他笑了笑，没接话，慢慢吹茶"）
- **欲望驱动**：制造情绪缺口→读者期待释放→释放时超过预期。满足70%等于失败
- **人设三问**：为什么这么做？符合人设吗？读者会觉得突兀吗？
- **对话**：不同角色说话方式不同——用词习惯、句子长短、口头禅、方言痕迹；遮住人名要能认出是谁；台词不写满，留潜台词
- **章尾钩子**：每章断在让读者必须翻下一章的具体画面/定格上（新问题、威胁、悬而未决的承诺、情绪缺口），不写"风暴将至"式编剧旁白
- **禁止**：资料卡式介绍角色 / 一次引入超3个新角色 / 众人齐声惊呼 / 套话意象（空气凝固、气氛凝重、心跳漏一拍）
- **升级**：坏事叠坏事，每层比上一层过分——被骂→手机掉了→直播课结束了→包子噎住了
- **小目标周期意识**：如果当前处于蓄压阶段，铺新阻力新信息；如果是爆发阶段，写兑现超预期；如果是后效阶段，写改变和代价
- **高潮后影响**：爆发后不能直接跳到下一个蓄压。紧接着的 1-2 章必须写出改变——谁失去了什么、谁得到了什么、关系怎么变了
- **期待管理**：读者期待释放时适当延迟以增强快感；读者即将失去耐心时立即给反馈
- **信息边界**：角色此刻知道什么？不知道什么？对局势有什么误判？角色只能基于已掌握的信息行动${buildChineseCraftHeatLine(chapterHeat)}`;
}

function buildChineseCraftHeatLine(heat: ChapterHeatTarget): string {
  if (isDefaultHeat(heat)) return "";
  const register = {
    warm: "温暖目标：多用对话、照料、触碰、温度与气味词承载情感，允许直接情绪，不把所有情感都压回克制。",
    tense: "紧张目标：短促、悬停、信息克制，高潮/炸裂段允许冲突外显，不用慢镜把爆点磨平。",
    bright: "明快目标：节奏轻、留白少，动作和反馈更干脆，少用阴郁内省压低火候。",
    dialogue: "对话密目标：冲突由台词推进，每 3-4 句对白落一个感官锚点或即时反应。",
    gloomy: "阴郁目标：只在勘验/观察段使用微观慢镜，每段带新信息，不把慢写成空转。",
    neutral: "中性目标：按 memo 执行，不额外改变火候。",
  }[heat.register];
  const tempo = {
    fast: "fast：短句、强动词、行动密度高，打散段落长度，削减铺陈。",
    medium: "medium：推进事件同时落后果与反应，保持长短段呼吸。",
    slow: "slow：允许停驻，但必须落在互动、物证或关系位移上。",
  }[heat.tempo];
  return `\n- **本章火候执行**：${register} ${tempo}`;
}

function buildEnglishCraftHeatLine(heat: ChapterHeatTarget): string {
  if (isDefaultHeat(heat)) return "";
  const register = {
    warm: "Warm target: carry feeling through dialogue, care, touch, warmth, and smell; direct emotion is allowed and should not be flattened back into restraint.",
    tense: "Tense target: clipped suspension and restrained information; climax/explosion beats may show conflict openly instead of sanding it down.",
    bright: "Bright target: lighter rhythm, less withholding, cleaner action and feedback; avoid dragging the chapter back into gloomy introspection.",
    dialogue: "Dialogue target: dialogue carries conflict; every 3-4 exchanges land a sensory anchor or immediate reaction.",
    gloomy: "Gloomy target: use micro slow-motion only for investigation/observation, with new information in every paragraph.",
    neutral: "Neutral target: follow the memo without extra heat shifts.",
  }[heat.register];
  const tempo = {
    fast: "fast: shorter sentences, stronger verbs, high action density, varied paragraph length, reduced setup.",
    medium: "medium: advance events while landing consequence and reaction.",
    slow: "slow: pauses are allowed only when anchored in interaction, evidence, or relationship movement.",
  }[heat.tempo];
  return `\n- **Chapter heat execution**: ${register} ${tempo}`;
}

function isDefaultHeat(heat: ChapterHeatTarget): boolean {
  return heat.register === "neutral" && heat.tempo === "medium";
}

// ---------------------------------------------------------------------------
// 创作宪法（14 条原则精华） — always-on prose; internalise, do not report back
// ---------------------------------------------------------------------------

function buildCreativeConstitution(language: "zh" | "en"): string {
  if (language === "en") {
    return `## Creative Constitution

These fourteen principles are your spine. Internalise them — never quote them, never list them, never narrate them. They tell you how to pick between two plausible next sentences.

Show don't tell: stack real detail to make truth visible, never deliver feeling in a flat declarative line — and never append a clause that explains the cause of an action, nor close a paragraph or chapter with an elevated line that sums up the meaning for the reader. Those three reflexes (the report voice, the explainer voice, the summarizer voice) are the heaviest AI tells. Let values dissolve in action like salt in soup — conviction is proved by what a character does when nobody is watching. Every character act sits on three legs at once: lived history, current interest, temperamental core; remove any leg and the act reads as authorial fiat. Every side character keeps their own ledger with their own profit motive; they exist before the protagonist meets them and continue after; every character with a real part has a voice you could pick out with the name tags covered. Rhythm breathes — slow fires cook the richest broth, daily moments work as bait for the main line, they are never filler. End every chapter on a concrete image or freeze-frame that leaves a small hook or emotional gap; readers must want the next page — never a voice-over forecast like "a storm was coming". Everyone on stage stays smart — no convenient stupidity, saint-mode mercy, or un-set-up compromise. Use after-time references in the voice of the era they land in. Timeline and period common sense cannot be bent. Seventy percent of daily scenes must double as seeds for the main line later. Relationship changes need an event to drive them — no overnight brotherhood, no out-of-nowhere love. Character setup holds across the arc; growth shows its work. Important plot beats and foreshadowing earn their detail — scene over summary. Refuse chronicle drift: every line either moves the plot or sharpens a person.`;
  }
  return `## 创作宪法

这十四条原则是你写作的脊梁。内化它们——绝不引用、绝不列表、绝不在正文里复述。它们的用途是帮你在"两个都说得通的下一句"之间做出选择。

Show don't tell，用细节堆出真实，禁止用一行直白陈述替代情绪，更禁止在动作后补一句解释因果、或在段末章末甩一句拔高的金句替读者总结意义——这三种"报告腔/解释腔/总结腔"是最重的 AI 味。价值观要像盐溶于汤——角色的信念靠"没人看时他在做什么"来证明，不靠口号。任何角色的任何行动都必须同时立于三条腿上：过往经历、当前利益、性格底色；缺一条就成了作者强行安排。每个配角都有自己的账本和利益诉求，他们在遇到主角之前就存在、在离开主角之后继续过日子，不是工具人；每个有戏的人都有一耳朵认得出的说话方式，遮住人名也能分清谁在说。节奏即呼吸——慢火才能炖出高汤，日常当饵用，不是填充。每章结尾必须断在一个具体画面/定格上，留小悬念或情绪缺口，把读者钉在下一章，绝不用"风暴将至"式旁白预告。全员智商在线——禁止降智、圣母心、无铺垫的妥协。后世梗用符合年代语境的说法落地。时间线与时代常识不能错。日常场景的七成必须在后面成为主线伏笔。任何关系的改变都要事件驱动——没有一夜称兄道弟、没有莫名其妙的深情。人设前后一致，成长有过程。重要剧情和伏笔用场景，不用总结。拒绝流水账——每一行字要么推动剧情，要么塑造人物。`;
}

// ---------------------------------------------------------------------------
// 代入感六支柱 — always-on prose; internalise, do not narrate checklist items
// ---------------------------------------------------------------------------

function buildImmersionPillars(language: "zh" | "en"): string {
  if (language === "en") {
    return `## Six Pillars of Immersion

Reader immersion rests on six pillars. Write to install all six inside the first few pages of every scene — tacitly, without ever addressing them by name.

Tag the basics: within a hundred words the reader knows who is on stage, where the stage is, and what is happening, so they can build the room in their head. Reach for visible familiarity: give ground-level specifics the reader has touched in their own life, so the scene loads before the second paragraph ends; open every key beat on a shootable image (who, where, what their hands are doing, what object is in frame) before anything else — never let an abstract noun ("the situation", "the atmosphere") stand in for a picture. Earn resonance twice — cognitive (the reader would make the same choice) and emotional (family feeling, anger at unfair treatment, grief, quiet pride); let emotion be received from the scene, never named by the narrator ("he felt angry") and never summed up by an elevated closing line. Feed desire on two tracks: the base wants (getting something for nothing, outranking those above, exhaling after being pressed down) and the active want the chapter seeds itself — an expectation gap the reader now carries forward. Plant sensory hooks: every scene carries one or two senses beyond sight (sound, smell, touch, taste), specific to THIS scene and dropped in passing, never a paragraph of weather and never stock imagery like "time stood still" or "the air was thick with tension". Make characters alive with a core tag plus one contrasting detail — the cold killer who feeds stray cats, the warm father whose jokes land like knives — and give each one a voice you'd recognize with the name tags covered (vocabulary, sentence length, verbal tics, the rhythm of how they dodge a question); let their lines carry subtext instead of saying everything. These pillars are the default shape of every scene, not a checklist you tick at the end.`;
  }
  return `## 代入感六支柱

读者代入感靠六根支柱支撑。每一个场景的前几页都要把六根柱子立起来——静默地立，不要点名、不要报告。

基础信息标签化：一百字内让读者知道谁在场、在哪儿、发生什么，读者脑里才能搭出这个房间。可视化熟悉感：给出读者亲身碰过的地面级具体细节——医院消毒水的味、地铁座椅的凉、外卖塑料袋的塑胶感——场景在第二段之前就要加载完；任何关键节拍都先落一个能拍出来的镜头（谁、在哪、手上在做什么、画面里有什么实物），再写后续，绝不用"局势""氛围""情况"这种抽象名词糊弄过去。共鸣分两层：认知共鸣（"这种情况下我也会这么选"）+ 情绪共鸣（亲情、被欺压时的愤怒、不公、隐忍的骄傲）；情绪靠场景演出来让读者自己接收，绝不由叙述者命名（不写"他感到愤怒"）或在章末用升华句替读者总结。欲望两条腿走路：基础欲望（不劳而获、压制比自己高的人、被欺压之后的扬眉吐气）+ 主动欲望（本章自己挖的期待感——一个读者会带到下一章的情绪缺口）。五感钩子：每个场景除视觉外放 1-2 种感官细节（听/嗅/触/味），选此情此景独有、读者碰过的，顺手带过，绝不写成大段天气描写、也绝不用"空气仿佛凝固""气氛凝重"这类套话意象。人设要"核心标签 + 一个反差细节"才活——冷面杀手偷偷喂流浪猫、和善父亲开的玩笑像刀子；每个有戏角色还要有一耳朵认得出的说话方式（用词、句长、口头禅、答话节奏），遮住人名也能猜出是谁在说，台词留潜台词、不写满。这六根柱子是场景的默认形状，不是章末打勾的清单。`;
}

// ---------------------------------------------------------------------------
// 黄金三章 prose discipline — Phase 6.5
// Single conditional append (chapterNumber <= 3). No new schema, no new
// runtime branch. Cohesive paragraphs, NOT a numbered checklist.
// ---------------------------------------------------------------------------

export function buildGoldenOpeningDiscipline(
  chapterNumber: number | undefined,
  language: "zh" | "en",
): string {
  if (chapterNumber === undefined || chapterNumber > 3) return "";

  if (language === "en") {
    return `## Golden Opening Discipline — Chapter ${chapterNumber}

This is chapter ${chapterNumber} of the opening three — your prose directly decides whether the reader stays. The Golden Three Chapters rule from new.txt is a hard constraint on your sentences, not advice. Chapter 1: within the first 800 words the protagonist must trip the main-line conflict (chase, dead-end, dispossession, transmigration-as-crisis); long background paragraphs are forbidden, and worldbuilding rides on the protagonist's actions instead of being explained in a block. **The last sentence of the first 300 words (the reader's first phone screen) must land a dramatic / reversal / striking beat — "Officer, I transmigrated"-level, "I'll probably die tomorrow"-level, "I'm attending my own funeral"-level — not background or scene-setting. When the reader scrolls to the bottom of the first screen they must feel pulled into the next line.** Chapter 2: the edge — power, system, rebirth-memory, information advantage — must be **performed** (one concrete event of using it, with a visible consequence), not **announced** (a narrator paragraph saying it exists). Chapter 3: somewhere in this chapter the protagonist's next quantifiable short-term goal must surface, so the reader can name what comes next when they close the page.

The discipline that runs across all three opening chapters: paragraphs of three to five lines (mobile reading), verbs over adjectives, and every chapter ends on a small hook — a cliff, an unresolved question, or an emotional gap. **At most two scenes and at most two named characters who actually clash in the chapter (protagonist + one trigger/opponent; walk-on roles get a role label only, no name, no expansion). Editor Cong Yue's rule tightens the cap from 3 to 2 — readers already mix up 3.** Information is layered into action: basic facts (looks, status, situation) emerge from what the protagonist does; key world rules (system mechanics, the deeper logic) attach to plot triggers; a paragraph of pure exposition is forbidden.`;
  }

  return `## 黄金三章写作纪律 — 第 ${chapterNumber} 章

这是开篇三章中的第 ${chapterNumber} 章——你写出的每一句话都直接决定读者是否留下来。new.txt 的黄金三章法则对你不是建议，是对句子的硬约束。第 1 章：主角出场 800 字以内必须触发主线冲突（追杀、死局、被夺权、穿越即危机），禁止长段背景铺垫，世界观要通过主角的行动自然带出，不要整段解释。**第 1 章正文前 300 字（手机屏第一页）的最后一句必须是带戏剧性/反差/反转的收尾——警察叔叔我穿越了这类、我大概明天就要死了这类、我躺在自己的葬礼上这类——而不是介绍背景或交代环境。读者第一屏刷到页尾时必须产生"下一句是什么"的拉力。** 第 2 章：金手指/能力/系统/重生记忆/信息差必须"做出来"——一次具体使用的事件、一个看得见的后果——而不是"说出来"——旁白介绍它存在。第 3 章：本章中段必须让主角下一个可量化的短期目标浮上水面，读者合上页面要能说出"接下来他要干什么"。

贯穿开篇三章的纪律：段落 3-5 行（手机阅读节奏），动词压过形容词，每一章结尾必有小钩子——小悬念、未解之问、情绪缺口。**本章场景 ≤ 2 个、有名有姓参与正面冲突的人物 ≤ 2 个（主角 + 1 个触发者或对手；路人甲乙只报身份不给名字，不展开）。番茄老师丛月把开篇人物上限从 3 收紧到 2——3 个已经够读者记混，2 个最稳。** 信息分层植入到动作里：基础信息（外貌、身份、处境）通过主角行动自然带出；关键设定（系统规则、世界底层）结合剧情节点揭示；禁止整段 exposition。`;
}

// ---------------------------------------------------------------------------
// 黄金开篇（中文3章/英文5章）
// ---------------------------------------------------------------------------

function buildGoldenChaptersRules(chapterNumber?: number, language?: string): string {
  const isEnglish = language === "en";
  const goldenLimit = isEnglish ? 5 : 3;
  if (chapterNumber === undefined || chapterNumber > goldenLimit) return "";

  const zhRules: Record<number, string> = {
    1: `### 第一章：抛出核心冲突
- 开篇直接进入冲突场景，禁止用背景介绍/世界观设定开头
- 第一段必须有动作或对话，让读者"看到"画面
- **手机屏第一页（正文约前 300 字）的最后一句必须是戏剧性反转/反差句**，不是铺垫——警察叔叔我穿越了、我大概明天就要死了、我躺在自己的葬礼上、妻子和婆婆同时掉水里了，类似这种一句话的钩子
- **开篇场景限制：最多 1-2 个场景，有名有姓参与正面冲突的人物上限 2 个（主角 + 1 个触发者/对手）**；路人甲乙只给身份标签（"穿红衣的女人""跛脚老头"）不给名字
- 主角身份/外貌/背景通过行动自然带出，禁止资料卡式罗列
- 本章结束前，核心矛盾必须浮出水面
- 一句对话能交代的信息不要用一段叙述，角色身份、性格、地位都可以从一句有特色的台词中带出`,
    2: `### 第二章：展现金手指/核心能力
- 主角的核心优势（金手指/特殊能力/信息差等）必须在本章初现
- 金手指的展现必须通过具体事件，不能只是内心独白"我获得了XX"
- 开始建立"主角有什么不同"的读者认知
- 第一个小爽点应在本章出现
- 继续收紧核心冲突，不引入新支线`,
    3: `### 第三章：明确短期目标
- 主角的第一个阶段性目标必须在本章确立
- 目标必须具体可衡量（打败某人/获得某物/到达某处），不能是抽象的"变强"
- 读完本章，读者应能说出"接下来主角要干什么"
- 章尾钩子要足够强，这是读者决定是否继续追读的关键章`,
  };

  const enRules: Record<number, string> = {
    1: `### Chapter 1: Drop into conflict
- Open with action or dialogue — no worldbuilding preamble
- First paragraph must show a scene, not tell backstory
- **The last sentence of the first 300 words (first phone screen) must be a dramatic reversal / striking beat** — "Officer, I transmigrated"-level, "I'll probably die tomorrow"-level — not scene-setting
- **Max 1-2 locations; max 2 named characters who actually clash in the chapter (protagonist + one trigger/opponent)**. Walk-ons get a role tag ("the woman in red", "the limping old man"), no name
- Protagonist identity revealed through behavior, not info-dump
- Core conflict must surface before chapter end`,
    2: `### Chapter 2: Reveal the edge
- The protagonist's unique advantage (power/secret/skill) must appear
- Show it through a concrete event, not internal monologue ("I gained X")
- First small payoff/satisfaction beat should land here
- Tighten the core conflict, don't open new subplots`,
    3: `### Chapter 3: Lock in the short-term goal
- A specific, measurable goal must be established (defeat someone / obtain something / reach somewhere)
- Reader must be able to say "I know what the protagonist wants next"
- End with a strong hook — this is the make-or-break chapter for retention`,
    4: `### Chapter 4: First major payoff
- Deliver the first BIG satisfaction beat — reader has invested 3 chapters, reward them
- Protagonist uses their edge to achieve something meaningful (not just survive)
- Raise the emotional stakes: what the protagonist stands to LOSE becomes clear
- Introduce or deepen a relationship that matters (ally, rival, love interest)`,
    5: `### Chapter 5: Raise the stakes before paywall
- New threat or complication that makes the goal harder (new antagonist, betrayal, revelation)
- The world expands: reader sees there's a bigger game beyond the initial conflict
- End on the strongest cliffhanger yet — reader hits paywall after this chapter
- They must feel "I CANNOT stop here" — this is the conversion chapter`,
  };

  const rules = isEnglish ? enRules : zhRules;
  const header = isEnglish
    ? `## Golden ${goldenLimit} Chapters — Chapter ${chapterNumber}

The opening ${goldenLimit} chapters determine whether readers stay or leave. Before the paywall (ch6-8), every chapter must hook harder than the last.

- Start from an explosion, not the first brick
- No info-dumps: worldbuilding reveals through action
- Each chapter: 1 storyline; **ch1-ch2 keep named characters in conflict ≤ 2** (protagonist + one), ch3+ relax to ≤ 3
- Lead with strong emotion: injustice, danger, mystery, desire`
    : `## 黄金${goldenLimit}章特殊指令（当前第${chapterNumber}章）

开篇${goldenLimit}章决定读者是否追读。遵循以下强制规则：

- 开篇不要从第一块砖头开始砌楼——从炸了一栋楼开始写
- 禁止信息轰炸：世界观、力量体系等设定随剧情自然揭示
- 每章聚焦 1 条故事线；**第 1-2 章有名有姓参与正面冲突的人物 ≤ 2 个（主角 + 1 个触发者/对手），第 3 章起可放宽到 ≤ 3 个**
- 强情绪优先：利用读者共情（亲情纽带、不公待遇、被低估）快速建立代入感`;

  return `${header}

${rules[chapterNumber] ?? ""}`;
}

// ---------------------------------------------------------------------------
// Full cast tracking (conditional)
// ---------------------------------------------------------------------------

function buildFullCastTracking(): string {
  return `## 全员追踪

本书启用全员追踪模式。每章结束时，POST_SETTLEMENT 必须额外包含：
- 本章出场角色清单（名字 + 一句话状态变化）
- 角色间关系变动（如有）
- 未出场但被提及的角色（名字 + 提及原因）`;
}

// ---------------------------------------------------------------------------
// Genre-specific rules
// ---------------------------------------------------------------------------

function buildGenreRules(gp: GenreProfile, genreBody: string): string {
  const fatigueLine = gp.fatigueWords.length > 0
    ? `- 高疲劳词（${gp.fatigueWords.join("、")}）单章最多出现1次`
    : "";

  const chapterTypesLine = gp.chapterTypes.length > 0
    ? `动笔前先判断本章类型：\n${gp.chapterTypes.map(t => `- ${t}`).join("\n")}`
    : "";

  const pacingLine = gp.pacingRule
    ? `- 节奏规则：${gp.pacingRule}`
    : "";

  return [
    `## 题材规范（${gp.name}）`,
    fatigueLine,
    pacingLine,
    chapterTypesLine,
    genreBody,
  ].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Protagonist rules from book_rules
// ---------------------------------------------------------------------------

function buildProtagonistRules(bookRules: BookRules | null): string {
  if (!bookRules?.protagonist) return "";

  const p = bookRules.protagonist;
  const lines = [`## 主角铁律（${p.name}）`];

  if (p.personalityLock.length > 0) {
    lines.push(`\n性格锁定：${p.personalityLock.join("、")}`);
  }
  if (p.behavioralConstraints.length > 0) {
    lines.push("\n行为约束：");
    for (const c of p.behavioralConstraints) {
      lines.push(`- ${c}`);
    }
  }

  if (bookRules.prohibitions.length > 0) {
    lines.push("\n本书禁忌：");
    for (const p of bookRules.prohibitions) {
      lines.push(`- ${p}`);
    }
  }

  if (bookRules.genreLock?.forbidden && bookRules.genreLock.forbidden.length > 0) {
    lines.push(`\n风格禁区：禁止出现${bookRules.genreLock.forbidden.join("、")}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Book rules body (user-written markdown)
// ---------------------------------------------------------------------------

function buildBookRulesBody(body: string): string {
  if (!body) return "";
  return `## 本书专属规则\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Style guide
// ---------------------------------------------------------------------------

function buildStyleGuide(styleGuide: string): string {
  if (!styleGuide || styleGuide === "(文件尚未创建)") return "";
  return `## 文风指南\n\n${styleGuide}`;
}

// ---------------------------------------------------------------------------
// Style fingerprint (Phase 9: C3)
// ---------------------------------------------------------------------------

function buildStyleFingerprint(fingerprint?: string): string {
  if (!fingerprint) return "";
  return `## 文风指纹（模仿目标）

以下是从参考文本中提取的写作风格特征。你的输出必须尽量贴合这些特征：

${fingerprint}`;
}

// ---------------------------------------------------------------------------
// Creative-only output format (no settlement blocks)
// ---------------------------------------------------------------------------

function buildCreativeOutputFormat(book: BookConfig, gp: GenreProfile, lengthSpec: LengthSpec): string {
  const resourceRow = gp.numericalSystem
    ? "| 当前资源总量 | X | 与账本一致 |\n| 本章预计增量 | +X（来源） | 无增量写+0 |"
    : "";

  const preWriteTable = `=== PRE_WRITE_CHECK ===
（必须输出Markdown表格，全部检查项对齐 chapter_memo 七段，而不是卷纲）
| 检查项 | 本章记录 | 备注 |
|--------|----------|------|
| 当前任务 | 复述 chapter_memo 的「当前任务」并写出本章执行动作 | 必须具体，不能抽象 |
| 读者在等什么 | 本章如何处理「读者此刻在等什么」—制造/延迟/兑现 | 与 memo 一致 |
| 该兑现的 / 暂不掀的 | 本章确认要兑现的伏笔 + 必须压住不掀的底牌 | 引用 memo 原文 |
| 日常/过渡承担任务 | 若有日常/过渡段落，说明各自承担的功能 | 对齐 memo 映射表 |
| 章尾必须发生的改变 | 列出 memo「章尾必须发生的改变」中 1-3 条具体改变 | 必须落地 |
| 不要做 | 逐条写出 memo「不要做」每条；若含场景/人物上限，写出本章实际场景数与有戏人物数，自证未超 | 正文不得触碰；超上限必须先收敛再写 |
| 上下文范围 | 第X章至第Y章 / 状态卡 / 设定文件 | |
| 当前锚点 | 地点 / 对手 / 收益目标 | 锚点必须具体 |
${resourceRow}| 待回收伏笔 | 用真实 hook_id 填写（无则写 none） | 与伏笔池一致 |
| 本章冲突 | 一句话概括 | |
| 章节类型 | ${gp.chapterTypes.join("/")} | |
| 风险扫描 | OOC/信息越界/设定冲突${gp.powerScaling ? "/战力崩坏" : ""}/节奏/词汇疲劳 | |`;

  return `## 输出格式（严格遵守）

${preWriteTable}

=== CHAPTER_TITLE ===
(章节标题，不含"第X章"。标题必须与已有章节标题不同，不要重复使用相同或相似的标题；若提供了 recent title history 或高频标题词，必须主动避开重复词根和高频意象)

=== CHAPTER_CONTENT ===
(正文内容，目标${lengthSpec.target}字，允许区间${lengthSpec.softMin}-${lengthSpec.softMax}字)

【重要】本次只需输出以上三个区块（PRE_WRITE_CHECK、CHAPTER_TITLE、CHAPTER_CONTENT）。
状态卡、伏笔池、摘要等追踪文件将由后续结算阶段处理，请勿输出。`;
}

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

function buildOutputFormat(book: BookConfig, gp: GenreProfile, lengthSpec: LengthSpec): string {
  const resourceRow = gp.numericalSystem
    ? "| 当前资源总量 | X | 与账本一致 |\n| 本章预计增量 | +X（来源） | 无增量写+0 |"
    : "";

  const preWriteTable = `=== PRE_WRITE_CHECK ===
（必须输出Markdown表格，全部检查项对齐 chapter_memo 七段，而不是卷纲）
| 检查项 | 本章记录 | 备注 |
|--------|----------|------|
| 当前任务 | 复述 chapter_memo 的「当前任务」并写出本章执行动作 | 必须具体，不能抽象 |
| 读者在等什么 | 本章如何处理「读者此刻在等什么」—制造/延迟/兑现 | 与 memo 一致 |
| 该兑现的 / 暂不掀的 | 本章确认要兑现的伏笔 + 必须压住不掀的底牌 | 引用 memo 原文 |
| 日常/过渡承担任务 | 若有日常/过渡段落，说明各自承担的功能 | 对齐 memo 映射表 |
| 章尾必须发生的改变 | 列出 memo「章尾必须发生的改变」中 1-3 条具体改变 | 必须落地 |
| 不要做 | 逐条写出 memo「不要做」每条；若含场景/人物上限，写出本章实际场景数与有戏人物数，自证未超 | 正文不得触碰；超上限必须先收敛再写 |
| 上下文范围 | 第X章至第Y章 / 状态卡 / 设定文件 | |
| 当前锚点 | 地点 / 对手 / 收益目标 | 锚点必须具体 |
${resourceRow}| 待回收伏笔 | 用真实 hook_id 填写（无则写 none） | 与伏笔池一致 |
| 本章冲突 | 一句话概括 | |
| 章节类型 | ${gp.chapterTypes.join("/")} | |
| 风险扫描 | OOC/信息越界/设定冲突${gp.powerScaling ? "/战力崩坏" : ""}/节奏/词汇疲劳 | |`;

  const postSettlement = gp.numericalSystem
    ? `=== POST_SETTLEMENT ===
（如有数值变动，必须输出Markdown表格）
| 结算项 | 本章记录 | 备注 |
|--------|----------|------|
| 资源账本 | 期初X / 增量+Y / 期末Z | 无增量写+0 |
| 重要资源 | 资源名 -> 贡献+Y（依据） | 无写"无" |
| 伏笔变动 | 新增/回收/延后 Hook | 同步更新伏笔池 |`
    : `=== POST_SETTLEMENT ===
（如有伏笔变动，必须输出）
| 结算项 | 本章记录 | 备注 |
|--------|----------|------|
| 伏笔变动 | 新增/回收/延后 Hook | 同步更新伏笔池 |`;

  const updatedLedger = gp.numericalSystem
    ? `\n=== UPDATED_LEDGER ===\n(更新后的完整资源账本，Markdown表格格式)`
    : "";

  return `## 输出格式（严格遵守）

${preWriteTable}

=== CHAPTER_TITLE ===
(章节标题，不含"第X章"。标题必须与已有章节标题不同，不要重复使用相同或相似的标题；若提供了 recent title history 或高频标题词，必须主动避开重复词根和高频意象)

=== CHAPTER_CONTENT ===
(正文内容，目标${lengthSpec.target}字，允许区间${lengthSpec.softMin}-${lengthSpec.softMax}字)

${postSettlement}

=== UPDATED_STATE ===
(更新后的完整状态卡，Markdown表格格式)
${updatedLedger}
=== UPDATED_HOOKS ===
(更新后的完整伏笔池，Markdown表格格式)

=== CHAPTER_SUMMARY ===
(本章摘要，Markdown表格格式，必须包含以下列)
| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |
|------|------|----------|----------|----------|----------|----------|----------|
| N | 本章标题 | 角色1,角色2 | 一句话概括 | 关键变化 | H01埋设/H02推进 | 情绪走向 | ${gp.chapterTypes.length > 0 ? gp.chapterTypes.join("/") : "过渡/冲突/高潮/收束"} |

=== UPDATED_SUBPLOTS ===
(更新后的完整支线进度板，Markdown表格格式)
| 支线ID | 支线名 | 相关角色 | 起始章 | 最近活跃章 | 距今章数 | 状态 | 进度概述 | 回收ETA |
|--------|--------|----------|--------|------------|----------|------|----------|---------|

=== UPDATED_EMOTIONAL_ARCS ===
(更新后的完整情感弧线，Markdown表格格式)
| 角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向 |
|------|------|----------|----------|------------|----------|

=== UPDATED_CHARACTER_MATRIX ===
(更新后的角色矩阵，每个角色一个 ## 块)

## 角色名
- **定位**: 主角 / 反派 / 盟友 / 配角 / 提及
- **标签**: 核心身份标签
- **反差**: 打破刻板印象的独特细节
- **说话**: 说话风格概述
- **性格**: 性格底色
- **动机**: 根本驱动力
- **当前**: 本章即时目标
- **关系**: 某角色(关系性质/Ch#) | ...
- **已知**: 该角色已知的信息（仅限亲历或被告知）
- **未知**: 该角色不知道的信息`;
}
