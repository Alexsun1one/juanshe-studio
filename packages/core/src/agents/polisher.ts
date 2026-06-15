import { BaseAgent } from "./base.js";
import type { ChapterHeatTarget, ChapterMemo } from "../models/input-governance.js";
import { renderChapterHeatCraftBlock, resolveChapterHeatTarget } from "../utils/narrative-control.js";
import { applySpotFixPatches, parseSpotFixPatches } from "../utils/spot-fix-patches.js";

export type PolisherMode = "patch" | "rewrite";

export interface PolishChapterInput {
  readonly chapterContent: string;
  readonly chapterNumber: number;
  readonly chapterMemo?: ChapterMemo;
  readonly language?: "zh" | "en";
  readonly temperature?: number;
  /**
   * `patch`(默认)= 让 LLM 只输出 PATCHES(目标文本片段 → 替换文本),前端只改改动行
   *  - 优点:输出 token -70%、不会"乱改逻辑"、改动可追溯、失败自动回退
   * `rewrite` = 走旧的全文重写流程(留作 fallback / 极端情形)
   */
  readonly mode?: PolisherMode;
  /**
   * 去 AI 味专项:置 true 时在指令里强调"本轮专门清 AI 痕迹"
   * (打散等长段落、删套话/公式化转折、把直白命名情绪改成可观察动作、替换陈词意象)。
   * 由 runner 在首轮润色后 aiTone 仍 < 阈值时自动追加一轮时设置。
   */
  readonly deAiFocus?: boolean;
}

export interface PolishChapterOutput {
  readonly polishedContent: string;
  readonly changed: boolean;
  readonly mode: PolisherMode;
  /** patch 模式下:应用的补丁数 / 跳过数 */
  readonly appliedPatchCount?: number;
  readonly skippedPatchCount?: number;
  /** 如果 patch 模式失败回退到 rewrite,标记一下 */
  readonly fellBackToRewrite?: boolean;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

/**
 * File-layer polisher — runs AFTER the reviewer+reviser cycle accepts the
 * chapter's structure. Polisher ONLY touches prose surface: sentence craft,
 * paragraph shape, wording, punctuation, five-sense immersion, dialogue
 * naturalness. It is forbidden from changing plot, character, or mainline.
 *
 * 默认走 **patch 模式**:只输出改动片段(TARGET_TEXT → REPLACEMENT_TEXT),省 token、
 * 不会"乱改"。如果 patch 解析失败或一条都贴不上,自动降级 rewrite 模式(整章重写),
 * 不让 polish 失败拖垮上层。
 *
 * 如果发现结构/情节问题,在末尾以 `[polisher-note] ...` 写一行供下轮 reviewer。
 */
export class PolisherAgent extends BaseAgent {
  get name(): string {
    return "polisher";
  }

  async polishChapter(input: PolishChapterInput): Promise<PolishChapterOutput> {
    const language = input.language ?? "zh";
    const isEnglish = language === "en";
    const mode: PolisherMode = input.mode ?? "patch";
    const chapterHeat = resolveChapterHeatTarget(input.chapterMemo);
    const heatGuard = buildPolisherHeatGuard(chapterHeat, isEnglish, Boolean(input.deAiFocus));

    const memoBlock = input.chapterMemo
      ? isEnglish
        ? `\n\n## Chapter Memo (do NOT let polish drift from this goal)\nGoal: ${input.chapterMemo.goal}\nregister: ${input.chapterMemo.register}\ntempo: ${input.chapterMemo.tempo}\n\n${input.chapterMemo.body}`
        : `\n\n## 章节备忘（润色不得偏离此目标）\ngoal：${input.chapterMemo.goal}\nregister：${input.chapterMemo.register}\ntempo：${input.chapterMemo.tempo}\n\n${input.chapterMemo.body}`
      : "";

    const systemPrompt = mode === "patch"
      ? (isEnglish ? buildEnglishPatchPrompt() : buildChinesePatchPrompt())
      : (isEnglish ? buildEnglishRewritePrompt() : buildChineseRewritePrompt());

    // 拆 user 内容成可缓存的 blocks:
    //  - 第 1 block:章节正文(长且稳定)→ 标 cache:true,跨 polisher / auditor / reviser 复用 prefix
    //  - 第 2 block:本次任务指令 + memo(短且每次不同)→ 不缓存
    // 这样同一章在 polish → audit 等场景下,Anthropic 上能命中 90% 缓存命中率
    const chapterBlock = isEnglish
      ? `## Chapter Under Polish\n${input.chapterContent}`
      : `## 待润色章节\n${input.chapterContent}`;
    // 去 AI 味专项指令:仅在 deAiFocus 时插入,告诉 LLM 本轮重点是清痕迹而非常规润色。
    const deAiBlock = input.deAiFocus
      ? (isEnglish
          ? `\n\n**This pass is AI-tell removal first.** The chapter still reads machine-written. Prioritize: break up same-length paragraphs (vary rhythm), delete hedge/filler words and formulaic transitions (however/meanwhile…), convert "named emotions" (felt fear/anger) into observable action or sensory detail, and replace cliché imagery with concrete specifics. Keep plot/character/mainline frozen. Do not treat the chapter register/tempo itself as an AI tell.`
          : `\n\n**本轮以去 AI 味为第一优先。** 这一章仍然读起来像机器写的。重点清理:把等长段落打散(制造节奏差)、删掉套话与公式化转折词(然而/与此同时/不禁/仿佛…)、把"直白命名情绪"(感到恐惧/心头涌起愤怒)改成可观察的动作或感官、把陈词意象(空气凝固/闪过一丝)换成此刻具体细节。情节/人物/主线保持冻结。不要把本章 register/tempo 火候本身当成 AI 味清掉。`)
      : "";
    const instructionBlock = mode === "patch"
      ? (isEnglish
          ? `\n\nPolish chapter ${input.chapterNumber}. Output PATCHES only — short surgical replacements, never the whole chapter. Each patch has TARGET_TEXT (verbatim slice from the chapter) → REPLACEMENT_TEXT.${deAiBlock}${heatGuard}${memoBlock}`
          : `\n\n请润色第${input.chapterNumber}章。只输出 PATCHES——逐处定点替换,绝不返回整章。每条 patch:TARGET_TEXT(原章节里的逐字片段) → REPLACEMENT_TEXT(润色后的版本)。${deAiBlock}${heatGuard}${memoBlock}`)
      : (isEnglish
          ? `\n\nPolish chapter ${input.chapterNumber}. Return the polished chapter in full, nothing else — no JSON, no headers, no commentary.${deAiBlock}${heatGuard}${memoBlock}`
          : `\n\n请润色第${input.chapterNumber}章。只返回完整的润色后正文,不要 JSON、不要标题、不要解释。${deAiBlock}${heatGuard}${memoBlock}`);

    const response = await this.chat(
      [
        // system 标 cache:true → 长 prompt(润色规则)在 5 分钟窗口内任何 polisher 调用都能命中
        { role: "system", content: [{ text: systemPrompt, cache: true }] },
        // user 的 chapter 部分标 cache:true,instruction 部分不缓存
        { role: "user", content: [
          { text: chapterBlock, cache: true },
          { text: instructionBlock },
        ] },
      ],
      { temperature: input.temperature ?? 0.4 },
    );

    const raw = response.content.trim();

    // ─ patch 模式解析 ───────────────────────────────────────────
    if (mode === "patch") {
      const patches = parseSpotFixPatches(raw);
      if (patches.length > 0) {
        const result = applySpotFixPatches(input.chapterContent, patches);
        if (result.applied) {
          return {
            polishedContent: result.revisedContent,
            changed: result.revisedContent !== input.chapterContent,
            mode: "patch",
            appliedPatchCount: result.appliedPatchCount,
            skippedPatchCount: result.skippedPatchCount,
            tokenUsage: response.usage,
          };
        }
        // 解析到了 patch 但全部贴不上 → 降级 rewrite 兜底
      }
      // 没解析到 patch,可能 LLM 没听话直接给了整章 → 看返回内容像不像章节正文
      const stripped = stripWrappingFence(raw);
      const looksLikeChapter = stripped.length > input.chapterContent.length * 0.4
        && !stripped.includes("--- PATCH")
        && !stripped.includes("=== PATCHES ===");
      if (looksLikeChapter) {
        return {
          polishedContent: stripped,
          changed: stripped !== input.chapterContent,
          mode: "rewrite",
          fellBackToRewrite: true,
          tokenUsage: response.usage,
        };
      }
      // 既没补丁也没像样的整章 → 视为本轮 polish 无效果,保留原文
      return {
        polishedContent: input.chapterContent,
        changed: false,
        mode: "patch",
        appliedPatchCount: 0,
        skippedPatchCount: patches.length,
        tokenUsage: response.usage,
      };
    }

    // ─ rewrite 模式(legacy / 显式指定) ───────────────────────────
    const stripped = stripWrappingFence(raw);
    const polishedContent = stripped.length > 0 ? stripped : input.chapterContent;
    return {
      polishedContent,
      changed: polishedContent !== input.chapterContent,
      mode: "rewrite",
      tokenUsage: response.usage,
    };
  }
}

function stripWrappingFence(text: string): string {
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/);
  return fence?.[1]?.trim() ?? text;
}

function buildPolisherHeatGuard(
  heat: ChapterHeatTarget,
  isEnglish: boolean,
  deAiFocus: boolean,
): string {
  if (heat.register === "neutral" && heat.tempo === "medium") return "";
  const craft = renderChapterHeatCraftBlock(heat, isEnglish ? "en" : "zh");
  if (isEnglish) {
    return `\n\n## Chapter Register / Tempo Preservation
Preserve register=${heat.register}, tempo=${heat.tempo}. Polish wording, rhythm, paragraph shape, and AI-tell residue, but do not normalize this chapter back to the book-level restrained house voice. ${deAiFocus ? "AI-tell removal deletes cliches and formulaic phrasing; it does not delete the chapter heat target." : ""}

${craft}`;
  }
  return `\n\n## 本章火候保护
保留 register=${heat.register}, tempo=${heat.tempo}。润色只改句式、段落、用词、排版、五感和对话自然度，不得把本章修回全书统一的克制腔。${deAiFocus ? "去 AI 味清套话、公式化转折和机器解释腔，不清本章火候。" : ""}

${craft}`;
}

// ─── prompts ─────────────────────────────────────────────────────────────

function buildPatchUserPrompt(
  chapterNumber: number,
  chapterContent: string,
  memoBlock: string,
  isEnglish: boolean,
): string {
  if (isEnglish) {
    return `Polish chapter ${chapterNumber}. Output PATCHES only — short surgical replacements, never the whole chapter. Each patch has TARGET_TEXT (verbatim slice from the chapter) → REPLACEMENT_TEXT.${memoBlock}\n\n## Chapter Under Polish\n${chapterContent}`;
  }
  return `请润色第${chapterNumber}章。只输出 PATCHES——逐处定点替换,绝不返回整章。每条 patch:TARGET_TEXT(原章节里的逐字片段) → REPLACEMENT_TEXT(润色后的版本)。${memoBlock}\n\n## 待润色章节\n${chapterContent}`;
}

function buildRewriteUserPrompt(
  chapterNumber: number,
  chapterContent: string,
  memoBlock: string,
  isEnglish: boolean,
): string {
  if (isEnglish) {
    return `Polish chapter ${chapterNumber}. Return the polished chapter in full, nothing else — no JSON, no headers, no commentary.${memoBlock}\n\n## Chapter Under Polish\n${chapterContent}`;
  }
  return `请润色第${chapterNumber}章。只返回完整的润色后正文，不要 JSON、不要标题、不要解释。${memoBlock}\n\n## 待润色章节\n${chapterContent}`;
}

function buildChinesePatchPrompt(): string {
  return `你是一位专业中文网文文字层润色编辑。本轮走 **PATCH 模式** — 只输出定点补丁,不重写整章。

## 润色边界(硬约束)

只改文字层 — 句式 / 段落 / 排版 / 用词 / 五感 / 对话自然度。禁止增删情节、改变人设、调整主线。发现情节/结构问题以 [polisher-note] 形式写在 PATCHES 区之外,供下轮 reviewer 参考。

结构的事归 Reviewer。读到人设崩、主线偏、冲突缺、memo 未兑现,保留原意,不要替作者补情节。

## 6 条文笔类雷点(你要消灭的)

- 描写无效:冗长的环境描写、与主线无关的对话塞满页面。把无效描写删到"一笔带过"。
- 文笔华丽过度:形容词地毯轰炸、为辞藻堆辞藻、情感失真。让文字服从情绪。
- 文笔欠佳:句意含混、指代不清、逻辑跳跃、语言干瘪。重写成通顺、有画面感的句子。
- 排版不规范:段落过长、格式不统一、对话无换行。统一为手机阅读友好格式。
- AI 味痕迹:转折词泛滥、"了"字堆砌、"仿佛/宛如/竟然"等情绪中介词、编剧旁白、分析报告式语言。替换成口语化表达或具体动作。
- 群像脸谱化:不写"众人齐声惊呼",挑 1-2 个角色写具体反应。

## 文字层硬规约

- 段落 3-5 行/段(手机阅读),连续 7 行以上必须拆段。
- 句式多样化,禁止连续 3 句以上同结构/同主语开头。
- 动词 > 形容词,一句最多 1-2 个精准形容词。
- 五感代入:每场景 1-2 种感官细节,不机械叠加。
- 对话自然度:不同角色辨识度;不写"……"敷衍。
- 情绪外化:"他感到愤怒"→"他捏碎了茶杯,滚烫茶水流过指缝"。
- 删除叙述者结论与"显然/不禁/仿佛"等 AI 标记词。
- 禁止破折号 "——",禁止"不是……而是……"句式。

## 输出契约(PATCH 模式 — 严格遵守)

第一行写 \`=== PATCHES ===\` 然后是若干补丁块,每个补丁块格式如下(可以重复多块):

\`\`\`
--- PATCH 1 ---
TARGET_TEXT:
<从章节原文里逐字摘出的一小段(20-200 字),不要省略号、不要改动任何字符,要能在原文里 indexOf 命中>
REPLACEMENT_TEXT:
<润色后的替换文本(可以稍长或稍短),保持人物/情节/事实不变,只改文字层>
--- END PATCH ---

--- PATCH 2 ---
TARGET_TEXT:
...
REPLACEMENT_TEXT:
...
--- END PATCH ---
\`\`\`

## PATCH 模式硬规则

1. **每条 PATCH 是定点替换** — 不要给整段甚至整章。挑出真正有问题的 1-3 句作为 TARGET,改后版本作为 REPLACEMENT。
2. **TARGET_TEXT 必须能在原章节里精确匹配** — 逐字拷出来,不要重写、不要改标点、不要省略。匹配不上的 patch 会被丢弃。
3. **每章 PATCH 数量控制在 3-15 条** — 太少说明没润到,太多说明在重写。
4. **TARGET 之间不要重叠**(同一句话不要同时出现在两条 PATCH 里)。
5. **如果整章已经够好,不需要改,就只写 \`=== PATCHES ===\` 然后一条 PATCH 都不要给**。这是合法输出。
6. **绝对禁止**:输出整章正文、输出 JSON、输出"已修改"等元说明。
7. 如果你发现情节/结构问题需要 reviewer 介入,在 PATCH 区之后另起一行写 \`[polisher-note] <问题描述>\`,每条一行。

例子(说明问题片段长这样):

\`\`\`
=== PATCHES ===
--- PATCH 1 ---
TARGET_TEXT:
他不禁感到一阵愤怒,仿佛全身的血液都涌上了头顶,他显然已经无法控制自己的情绪。
REPLACEMENT_TEXT:
他攥紧了拳头,指节泛白。茶水在杯里晃出一道细痕。
--- END PATCH ---

--- PATCH 2 ---
TARGET_TEXT:
周敏笑了笑,她说:"没事的,我懂。"
REPLACEMENT_TEXT:
周敏笑了笑:"没事,我懂。"
--- END PATCH ---

[polisher-note] 第三段提到"昨晚的对话",但前文从未出现过这场对话,可能需要 reviewer 补一笔伏笔。
\`\`\``;
}

function buildEnglishPatchPrompt(): string {
  return `You are a professional English web-fiction prose polisher. This round runs in **PATCH MODE** — output surgical patches only, never rewrite the whole chapter.

## Polisher scope (hard constraints)

You touch the prose surface only — sentence craft, paragraph shape, wording, punctuation, sensory detail, dialogue naturalness. You are FORBIDDEN from adding or removing plot beats, changing character setup, or altering the mainline. If you notice plot/structure problems, append a "[polisher-note] ..." line at the end (outside the PATCHES block) for the next reviewer.

## 6 prose-level reader-pain patterns to eliminate

- Ineffective description / over-purple prose / weak prose / bad formatting / AI-tell residue / crowd-face reactions.

## Prose-layer hard rules

- Paragraphs 3-5 lines, max 7 before break.
- Sentence variety; verbs > adjectives; sensory details (1-2 per scene).
- Distinct character voices in dialogue.
- Externalise emotion ("he felt angry" → "he crushed the teacup").
- Delete narrator conclusions and AI hedges.

## Output contract (PATCH MODE — strict)

First line: \`=== PATCHES ===\`, then patches in this exact shape (repeat as needed):

\`\`\`
--- PATCH 1 ---
TARGET_TEXT:
<verbatim slice from the chapter (20-200 chars), no ellipsis, no edits, must indexOf-match the source>
REPLACEMENT_TEXT:
<polished replacement (can be shorter or longer), facts/plot/character unchanged, only prose layer changes>
--- END PATCH ---

--- PATCH 2 ---
TARGET_TEXT:
...
REPLACEMENT_TEXT:
...
--- END PATCH ---
\`\`\`

## PATCH-mode hard rules

1. Each patch is a SURGICAL replacement — not whole paragraphs.
2. TARGET_TEXT MUST match the source verbatim (any deviation → patch is dropped).
3. 3-15 patches per chapter typical; fewer means you didn't polish enough, more means you're rewriting.
4. TARGETs must not overlap.
5. If the chapter is already good, output ONLY \`=== PATCHES ===\` with zero patches. Legal output.
6. NEVER output the full chapter, JSON, or meta-commentary.
7. Append \`[polisher-note] ...\` lines after the patches block if reviewer needs to know about structural issues.`;
}

function buildChineseRewritePrompt(): string {
  return `你是一位专业中文网文文字层润色编辑。

## 润色边界（硬约束）

你只改文字层——句式 / 段落 / 排版 / 用词 / 五感 / 对话自然度。你禁止增删情节、改变人设、调整主线。发现情节/结构问题只能以 [polisher-note] 形式附在章末供下一轮 reviewer 参考，不能动正文。

## 6 条文笔类雷点(你要消灭的)
- 描写无效 / 华丽过度 / 文笔欠佳 / 排版不规范 / AI 味痕迹 / 群像脸谱化

## 文字层硬规约
- 段落 3-5 行;句式多样;动词>形容词;五感代入;对话辨识度;情绪外化;删 AI hedges;禁破折号。

## 输出契约

直接返回润色后的完整章节正文——不要 JSON、不要章节标题行、不要任何解释或进度说明。如果发现必须交给 reviewer 的情节/结构问题,在正文末尾另起一行以 "[polisher-note] " 开头写明,每条一行。没有问题就不加。

保留原文绝大多数句子。只改真正有问题的句子,不要整段重写。修改后章节总长变化不得超过原文字数 ±15%。`;
}

function buildEnglishRewritePrompt(): string {
  return `You are a professional English web-fiction prose polisher.

## Polisher scope (hard constraints)

You touch prose surface only — no plot / character / mainline changes. Append "[polisher-note] ..." for structural issues.

## Output contract

Return the polished chapter in full — no JSON, no headers, no commentary. Append "[polisher-note] ..." lines if reviewer needs to handle structural issues. Preserve most sentences; rewrite only the truly broken. Total length within ±15% of source.`;
}
