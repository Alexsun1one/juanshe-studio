import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BaseAgent } from "./base.js";
import type { BookConfig } from "../models/book.js";
import { readBookRules as readAuthoritativeBookRules } from "./rules-reader.js";
import {
  ChapterIntentSchema,
  type ChapterIntent,
  type ChapterMemo,
} from "../models/input-governance.js";
import {
  renderHookSnapshot,
  renderSummarySnapshot,
} from "../utils/memory-retrieval.js";
import {
  gatherPlanningMaterials,
  loadPlanningSeedMaterials,
} from "../utils/planning-materials.js";
import { parseMemo, PlannerParseError, validateRecyclableHooksAddressed } from "../utils/chapter-memo-parser.js";
import {
  buildPlannerUserMessage,
  getPlannerMemoSystemPrompt,
} from "./planner-prompts.js";
import {
  buildDormantSubplotRevivalHints,
  composeCurrentArcProse,
  extractCollaboratorRows,
  extractOpponentRows,
  extractProtagonistRow,
  extractRelevantThreads,
  formatRecentSummaries,
  formatRecyclableHooks,
  clearLastAuditFeedback,
  readLastAuditFeedback,
  readBookRules,
  readCharacterMatrix,
  readEmotionalArcs,
  readPendingHooks,
  readVolumeCadenceGuidance,
  readSubplotBoard,
} from "./planner-context.js";
import type { StoredHook } from "../state/memory-db.js";
import { DEFAULT_CHAPTER_CADENCE_WINDOW } from "../utils/chapter-cadence.js";
import { buildOpeningLedgerBrief } from "../utils/opening-ledger.js";
import { buildNarrativeProgressDashboard } from "../utils/narrative-progress-dashboard.js";
import { maybeRenewCoreHooks } from "../utils/hook-renewal.js";

export interface PlanChapterInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly externalContext?: string;
}

export interface PlanChapterOutput {
  readonly intent: ChapterIntent;
  readonly memo: ChapterMemo;
  readonly intentMarkdown: string;
  readonly plannerInputs: ReadonlyArray<string>;
  readonly runtimePath: string;
}

const MEMO_RETRY_LIMIT = 3;

/**
 * Phase 3 planner.
 *
 * Produces:
 *   - a simplified ChapterIntent (goal + outline + keep/avoid/style) —
 *     still deterministic, used for retrieval hints and the intent markdown.
 *   - a full ChapterMemo (YAML frontmatter + 7-section markdown body) via
 *     LLM call + strict parser.
 *
 * Retry policy: up to 3 attempts. Each failed parse appends an error
 * feedback block to the user message and re-invokes the LLM. On the third
 * failure we surface `PlannerParseError` — never silently truncate or
 * rename fields.
 */
export class PlannerAgent extends BaseAgent {
  get name(): string {
    return "planner";
  }

  async planChapter(input: PlanChapterInput): Promise<PlanChapterOutput> {
    const storyDir = join(input.bookDir, "story");
    const runtimeDir = join(storyDir, "runtime");
    await mkdir(runtimeDir, { recursive: true });

    const seedMaterials = await loadPlanningSeedMaterials({
      bookDir: input.bookDir,
      chapterNumber: input.chapterNumber,
    });
    const outlineNode = this.findOutlineNode(seedMaterials.volumeOutline, input.chapterNumber);
    const goal = this.deriveGoal(
      input.externalContext,
      seedMaterials.currentFocus,
      seedMaterials.authorIntent,
      outlineNode,
      input.chapterNumber,
    );
    // Phase hotfix 5: read structured rules through the Phase 5 authoritative
    // loader. It prefers outline/story_frame.md frontmatter, falls back to
    // legacy book_rules.md, and refuses to silently zero out rules when the
    // legacy file is just a compat shim. Reading raw bookRulesRaw via
    // parseBookRules() bypassed all of that.
    const parsedRules = await readAuthoritativeBookRules(input.bookDir);
    const prohibitions = parsedRules?.rules.prohibitions ?? [];
    const mustKeep = this.collectMustKeep(seedMaterials.currentState, seedMaterials.storyBible);
    const mustAvoid = this.collectMustAvoid(seedMaterials.currentFocus, prohibitions);
    const styleEmphasis = this.collectStyleEmphasis(seedMaterials.authorIntent, seedMaterials.currentFocus);
    const materials = await gatherPlanningMaterials({
      bookDir: input.bookDir,
      chapterNumber: input.chapterNumber,
      goal,
      outlineNode,
      mustKeep,
      seed: seedMaterials,
    });
    const memorySelection = materials.memorySelection;
    await maybeRenewCoreHooks({
      storyDir,
      chapterNumber: input.chapterNumber,
      targetChapters: input.book.targetChapters,
      volumeMap: seedMaterials.volumeOutline,
      activeHooks: memorySelection.activeHooks,
      currentFocus: seedMaterials.currentFocus,
      storyFrame: seedMaterials.storyBible,
      authorIntent: seedMaterials.authorIntent,
      language: input.book.language ?? "zh",
    });
    const activeHookCount = memorySelection.activeHooks.filter(
      (hook) => hook.status !== "resolved" && hook.status !== "deferred",
    ).length;
    const progressDashboard = buildNarrativeProgressDashboard({
      chapterNumber: input.chapterNumber,
      targetChapters: input.book.targetChapters,
      volumeMap: seedMaterials.volumeOutline,
      overdueHookCount: memorySelection.recyclableHooks.length,
      language: input.book.language ?? "zh",
    });

    const arcContext = this.buildArcContext(
      input.book.language,
      seedMaterials.volumeOutline,
      outlineNode,
    );

    const intent = ChapterIntentSchema.parse({
      chapter: input.chapterNumber,
      goal,
      outlineNode,
      arcContext,
      mustKeep,
      mustAvoid,
      styleEmphasis,
    });

    const isGoldenOpening = this.isGoldenOpeningChapter(input.book.language, input.chapterNumber);
    const memo = await this.planChapterMemo({
      storyDir,
      bookDir: input.bookDir,
      chapterNumber: input.chapterNumber,
      isGoldenOpening,
      fallbackGoal: goal,
      chapterSummariesRaw: seedMaterials.chapterSummariesRaw,
      previousEndingExcerpt: seedMaterials.previousEndingExcerpt,
      brief: seedMaterials.brief,
      chapterContext: input.externalContext,
      authorIntent: seedMaterials.authorIntent,
      currentFocus: seedMaterials.currentFocus,
      storyFrame: seedMaterials.storyBible,
      recyclableHooks: memorySelection.recyclableHooks,
      progressDashboardPrompt: progressDashboard.promptBlock,
      progressDashboardMemoSection: progressDashboard.memoSection,
      // P1-6: 把"语义召回的历史相关章"和"当前卷纲节点"喂进 memo —— planner 原来只看最近 3 章,
      // 导致长线被遗忘、爽点/冲突跨卷重复、跑题。现在它能看到早年埋的线和本卷该往哪收。
      recalledSummaries: renderSummarySnapshot(memorySelection.summaries, input.book.language ?? "zh"),
      volumeDirection: String(outlineNode ?? ""),
      // Phase hotfix 4: thread book language through so the planner uses
      // English prompts (system + user template + golden opening guidance)
      // for English books instead of always-Chinese.
      language: input.book.language ?? "zh",
    });

    // memo.goal is LLM-produced and specific (<=50 chars, validated).
    // Overwrite intent.goal so downstream composer/retrieval gets the
    // concrete task statement instead of the outline-derived fallback.
    intent.goal = memo.goal;

    const runtimePath = join(runtimeDir, `chapter-${String(input.chapterNumber).padStart(4, "0")}.intent.md`);
    const intentMarkdown = this.renderIntentMarkdown(
      intent,
      memo,
      input.book.language ?? "zh",
      renderHookSnapshot(memorySelection.hooks, input.book.language ?? "zh"),
      renderSummarySnapshot(memorySelection.summaries, input.book.language ?? "zh"),
      activeHookCount,
      progressDashboard.memoSection,
    );
    await writeFile(runtimePath, intentMarkdown, "utf-8");

    return {
      intent,
      memo,
      intentMarkdown,
      plannerInputs: materials.plannerInputs,
      runtimePath,
    };
  }

  /**
   * Invoke the LLM to produce a 7-section memo and parse it. Retries up to
   * 3 times on parse failure, injecting the error message back into the user
   * prompt so the LLM can correct itself.
   */
  async planChapterMemo(input: {
    readonly storyDir: string;
    readonly bookDir: string;
    readonly chapterNumber: number;
    readonly isGoldenOpening: boolean;
    readonly fallbackGoal: string;
    readonly chapterSummariesRaw: string;
    readonly previousEndingExcerpt?: string;
    readonly brief?: string;
    readonly chapterContext?: string;
    readonly authorIntent?: string;
    readonly currentFocus?: string;
    readonly storyFrame?: string;
    readonly recyclableHooks?: ReadonlyArray<StoredHook>;
    readonly progressDashboardPrompt?: string;
    readonly progressDashboardMemoSection?: string;
    readonly recalledSummaries?: string;
    readonly volumeDirection?: string;
    readonly language?: "zh" | "en";
  }): Promise<ChapterMemo> {
    const [characterMatrix, subplotBoard, emotionalArcs, pendingHooks, bookRulesRaw, openingLedgerBrief, auditFeedback, volumeCadenceGuidance] = await Promise.all([
      readCharacterMatrix(input.storyDir),
      readSubplotBoard(input.storyDir),
      readEmotionalArcs(input.storyDir),
      readPendingHooks(input.storyDir),
      readBookRules(input.storyDir),
      buildOpeningLedgerBrief({
        storyDir: input.storyDir,
        currentChapter: input.chapterNumber,
        keepRecent: DEFAULT_CHAPTER_CADENCE_WINDOW,
        language: input.language ?? "zh",
      }),
      readLastAuditFeedback(input.storyDir),
      readVolumeCadenceGuidance(input.storyDir, input.language ?? "zh"),
    ]);

    const language = input.language ?? "zh";
    const noPriorChapter = language === "en"
      ? "(this is the opening chapter — no prior chapter)"
      : "（本章为起始章，无前章）";
    const noBookRules = language === "en"
      ? "(no book_rules entries)"
      : "（暂无 book_rules 条目）";
    const retryFeedbackHeader = language === "en"
      ? "## Error from previous output"
      : "## 上次输出的错误";
    const retryFeedbackTrailer = language === "en"
      ? "Fix and re-emit."
      : "请修正后重新输出。";

    const userMessage = buildPlannerUserMessage({
      chapterNumber: input.chapterNumber,
      previousChapterEndingExcerpt: input.previousEndingExcerpt?.trim()
        ? input.previousEndingExcerpt.trim()
        : noPriorChapter,
      recentSummaries: formatRecentSummaries(input.chapterSummariesRaw, input.chapterNumber, 8),
      progressDashboard: input.progressDashboardPrompt ?? "",
      openingLedgerBrief: openingLedgerBrief ?? "",
      currentArcProse: composeCurrentArcProse(subplotBoard, emotionalArcs, input.chapterNumber),
      dormantSubplotRevivalHints: buildDormantSubplotRevivalHints(subplotBoard, input.chapterNumber, language),
      protagonistMatrixRow: extractProtagonistRow(characterMatrix),
      opponentRows: extractOpponentRows(characterMatrix, 3),
      collaboratorRows: extractCollaboratorRows(characterMatrix, 3),
      relevantThreads: extractRelevantThreads(pendingHooks, subplotBoard),
      recyclableHooks: formatRecyclableHooks(
        input.recyclableHooks ?? [],
        input.chapterNumber,
        language,
      ),
      auditFeedback,
      recalledSummaries: input.recalledSummaries ?? "",
      volumeDirection: appendVolumeCadenceGuidance(input.volumeDirection ?? "", volumeCadenceGuidance),
      isGoldenOpening: input.isGoldenOpening,
      bookRulesRelevant: bookRulesRaw.trim().length > 0 ? bookRulesRaw.trim() : noBookRules,
      brief: input.brief ?? "",
      chapterContext: input.chapterContext ?? "",
      authorIntent: input.authorIntent ?? "",
      currentFocus: input.currentFocus ?? "",
      storyFrame: input.storyFrame ?? "",
      language,
    });

    const systemPrompt = getPlannerMemoSystemPrompt(language);

    let currentUserMessage = userMessage;
    let lastError: PlannerParseError | undefined;

    for (let attempt = 0; attempt < MEMO_RETRY_LIMIT; attempt += 1) {
      const response = await this.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: currentUserMessage },
        ],
        { temperature: 0.7 },
      );

      try {
        const memo = this.parseAndValidateMemo(response.content, input);
        if (auditFeedback.trim()) {
          await clearLastAuditFeedback(input.storyDir);
        }
        return memo;
      } catch (error) {
        if (!(error instanceof PlannerParseError)) {
          throw error;
        }
        lastError = error;
        this.log?.warn(`[planner] memo parse failed (attempt ${attempt + 1}/${MEMO_RETRY_LIMIT}): ${error.message}`);
        currentUserMessage = `${userMessage}\n\n${retryFeedbackHeader}\n${error.message}\n${retryFeedbackTrailer}`;
      }
    }

    const fallback = this.buildDeterministicMemoFallback({
      chapterNumber: input.chapterNumber,
      isGoldenOpening: input.isGoldenOpening,
      fallbackGoal: input.fallbackGoal,
      premiseSignal: this.extractPremiseSignal(input.authorIntent, input.currentFocus, input.storyFrame, language),
      recyclableHooks: input.recyclableHooks,
      language,
    });
    this.log?.warn(`[planner] using deterministic memo fallback for chapter ${input.chapterNumber}: ${lastError?.message ?? "unknown parse error"}`);
    const memo = this.parseAndValidateMemo(fallback, input, { enforceRecyclable: false });
    if (auditFeedback.trim()) {
      await clearLastAuditFeedback(input.storyDir);
    }
    return memo;
  }

  private parseAndValidateMemo(
    raw: string,
    input: {
      readonly chapterNumber: number;
      readonly isGoldenOpening: boolean;
      readonly recyclableHooks?: ReadonlyArray<StoredHook>;
      readonly progressDashboardMemoSection?: string;
    },
    opts?: { readonly enforceRecyclable?: boolean },
  ): ChapterMemo {
    const memo = this.attachProgressDashboardToMemo(
      parseMemo(raw, input.chapterNumber, input.isGoldenOpening),
      input.progressDashboardMemoSection,
    );
    // 兜底 fallback 路径传 enforceRecyclable:false —— 它是最后退路,绝不能因为到期 hook
    // 校验再抛错逃出 planChapterMemo 把整章写崩(fallback 内容已把到期 hook 全部 defer,
    // 本就满足校验,这里是双保险)。LLM 主路径仍强制校验以驱动重试。
    if (opts?.enforceRecyclable !== false) {
      validateRecyclableHooksAddressed(memo.body, input.recyclableHooks ?? []);
    }
    return memo;
  }

  private attachProgressDashboardToMemo(
    memo: ChapterMemo,
    progressDashboardMemoSection?: string,
  ): ChapterMemo {
    const section = progressDashboardMemoSection?.trim();
    if (!section || memo.body.includes("## 全书进度仪表盘") || memo.body.includes("## Whole-book progress dashboard")) {
      return memo;
    }
    return {
      ...memo,
      body: `${section}\n\n${memo.body}`,
    };
  }

  private buildDeterministicMemoFallback(input: {
    readonly chapterNumber: number;
    readonly isGoldenOpening: boolean;
    readonly fallbackGoal: string;
    readonly premiseSignal?: string;
    readonly recyclableHooks?: ReadonlyArray<StoredHook>;
    readonly language: "zh" | "en";
  }): string {
    const goal = (input.fallbackGoal || (input.language === "en" ? "Continue the current conflict" : "承接当前冲突继续推进"))
      .replace(/\s+/g, "")
      .slice(0, 50);
    // recyclableHooks 已在 computeRecyclableHooks 处按 RECYCLABLE_HOOK_LIMIT 截断,
    // 这里全量纳入并一律 defer —— 修掉旧 fallback "只 slice(0,3) → 第 4+ 个到期 hook
    // 缺失 → 二次校验抛错把整章写崩" 的崩点;且 fallback 本是应急退路,诚实 defer 比
    // 假装 advance 更不污染下游 hook 账。
    const recyclableIds = (input.recyclableHooks ?? [])
      .map((hook) => hook.hookId)
      .filter(Boolean);
    const refs = recyclableIds.length > 0
      ? recyclableIds.map((hookId) => `  - ${hookId}`).join("\n")
      : "  - fallback-mainline";

    if (input.language === "en") {
      const deferBlock = [
        ...recyclableIds.map((hookId) => `- ${hookId} -> emergency fallback planning round; deliberately held this chapter, will advance it next round.`),
        "- deeper mastermind/cause -> not enough reliable memo structure this round, keep it for later repair.",
      ].join("\n");
      return `---
chapter: ${input.chapterNumber}
goal: ${goal}
isGoldenOpening: ${input.isGoldenOpening ? "true" : "false"}
threadRefs:
${refs}
---

## Current task
Continue the current mainline from the previous chapter and turn it into one concrete, visible action on page.
${input.premiseSignal ? `\nPremise fidelity: make this core promise visible on page — ${input.premiseSignal}.` : ""}

## What the reader is waiting for right now
1) The reader is waiting to see whether the previous clue or pressure becomes actionable.
2) This chapter partially pays it off while leaving one sharper question for the next chapter.

## To pay off / to keep buried
- Pay off: the protagonist makes one observable move tied to the current goal.
- Keep buried: do not reveal the full hidden cause; leave it as pressure for later.

## What the slow / transitional beats carry
[Opening] -> reconnects location, object, and pressure from the previous chapter.
[Middle] -> forces a choice that shows character interest instead of exposition.
[Ending] -> leaves a concrete trace that can be picked up next chapter.

## Three-question check on the key choice
- Protagonist's key choice:
  - Why: the visible clue or pressure can no longer be ignored.
  - Interest: it protects immediate survival, leverage, or information.
  - Persona: it fits the established cautious and observant behavior.
- Opponent/supporting character's key choice:
  - Why: they react to the protagonist touching the pressure point.
  - Interest: they protect their own position or secret.
  - Persona: they act through practical self-interest, not sudden stupidity.

## Required end-of-chapter change
- Information change: one concrete clue becomes harder to deny.
- Relationship or power change: at least one character adjusts their stance because of that clue.

## Hook ledger for this chapter
open:
- [new] A visible trace left near the ending || Reason: it grows naturally from the failed planner fallback and should not be explained yet.

advance:
- fallback-mainline -> keep the current conflict visible through one concrete object, place, or choice.

resolve:
- none -> no full resolution during fallback planning; preserve continuity first.

defer:
${deferBlock}

## Do not
- Do not introduce an unrelated new subplot to escape the current conflict.
- Do not contradict the previous chapter's visible facts or character positions.
- Do not let the latest local incident replace the book's core premise, protagonist identity, or core edge.
- Do not resolve the whole mystery in a single explanatory paragraph.`;
    }

    const deferBlockZh = [
      ...recyclableIds.map((hookId) => `- ${hookId} → 兜底规划轮，刻意按住本章，下一轮稳定后再正式推进。`),
      "- 幕后完整原因 → 等下一轮结构化 memo 稳定后再处理，避免乱揭。",
    ].join("\n");
    return `---
chapter: ${input.chapterNumber}
goal: ${goal}
isGoldenOpening: ${input.isGoldenOpening ? "true" : "false"}
threadRefs:
${refs}
---

## 当前任务
承接上一章已经形成的现场压力，让主角围绕当前目标做出一个能被看见的具体动作。
${input.premiseSignal ? `\n主设定保真：本章必须让这个核心承诺在页面上可见——${input.premiseSignal}。` : ""}

## 读者此刻在等什么
1) 读者在等上一章留下的线索或压力变成可行动的证据。
2) 本章先部分兑现这个期待，同时把疑问压得更尖，留给下一章继续追。

## 该兑现的 / 暂不掀的
- 该兑现：主角必须围绕当前目标完成一次可观察行动，不能只停留在想法。
- 暂不掀：幕后完整原因先压住，只让表层证据和人物反应继续加压。

## 日常/过渡承担什么任务
[开场] → 接回上一章的地点、物件和压力，让读者知道没有跳章。
[中段] → 用一次选择体现人物利益，而不是靠解释补设定。
[结尾] → 留下一个下一章能直接接住的具体痕迹。

## 关键抉择过三连问
- 主角本章最关键的一次选择：
  - 为什么这么做？因为眼前线索或压力已经无法再忽略。
  - 符合当前利益吗？符合，能保护生存、筹码或信息优势。
  - 符合他的人设吗？符合既有的谨慎、观察和借势行动。
- 对手/配角本章最关键的一次选择：
  - 为什么这么做？因为主角碰到了对方想遮住的压力点。
  - 符合当前利益吗？符合，对方会优先保护位置、秘密或面子。
  - 符合他的人设吗？符合现实利益驱动，不突然降智或转性。

## 章尾必须发生的改变
- 信息改变：一个具体线索变得更难否认。
- 关系或权力改变：至少一个角色因这个线索调整站位或态度。

## 本章 hook 账
open:
- [new] 章尾出现一个可见痕迹 || 理由：从当前冲突自然长出，先不解释。

advance:
- fallback-mainline → 用一个具体物件、地点或选择承接当前冲突，不凭空转场。

resolve:
- 无 → 本轮是兜底规划，不强行彻底解决旧谜团。

defer:
${deferBlockZh}

## 不要做
- 不要新增与当前冲突无关的新支线来逃避断点。
- 不要推翻上一章已经落地的事实、人物位置和可见线索。
- 不要让最近局部事件替换全书主设定、主角身份或核心能力。
- 不要用一整段解释直接揭完谜底，必须保留后续追问。`;
  }

  private extractPremiseSignal(
    authorIntent: string | undefined,
    currentFocus: string | undefined,
    storyFrame: string | undefined,
    language: "zh" | "en",
  ): string | undefined {
    const source = [currentFocus, authorIntent, storyFrame]
      .filter(Boolean)
      .join("\n")
      .split("\n")
      .map((line) => line.trim().replace(/^[-*]\s*/, ""))
      .find((line) =>
        line.length > 0 &&
        !line.startsWith("#") &&
        !/^---+$/.test(line) &&
        /(主设定|核心承诺|重生|三岁|心智|大模型|系统|金手指|protagonist|premise|core promise|rebirth|system|edge)/i.test(line),
      );
    if (source) return source.slice(0, language === "en" ? 220 : 120);
    return language === "en"
      ? "protagonist identity, core edge and limitation, long-horizon mystery, or satisfaction beat with cost"
      : "主角身份、核心能力及限制、长线谜团、或带代价的爽点收益";
  }

  private isGoldenOpeningChapter(language: string | undefined, chapterNumber: number): boolean {
    const isZh = (language ?? "zh").toLowerCase().startsWith("zh");
    return isZh ? chapterNumber <= 3 : chapterNumber <= 5;
  }

  private buildArcContext(
    language: string | undefined,
    volumeOutline: string,
    outlineNode: string | undefined,
  ): string | undefined {
    if (!outlineNode) return undefined;
    if (volumeOutline === "(文件尚未创建)") return undefined;
    return this.isChineseLanguage(language)
      ? `卷纲节点：${outlineNode}`
      : `Outline node: ${outlineNode}`;
  }

  private deriveGoal(
    externalContext: string | undefined,
    currentFocus: string,
    authorIntent: string,
    outlineNode: string | undefined,
    chapterNumber: number,
  ): string {
    const first = this.extractFirstDirective(externalContext);
    if (first) return first;
    const localOverride = this.extractLocalOverrideGoal(currentFocus);
    if (localOverride) return localOverride;
    const outline = this.extractFirstDirective(outlineNode);
    if (outline) return outline;
    const focus = this.extractFocusGoal(currentFocus);
    if (focus) return focus;
    const author = this.extractFirstDirective(authorIntent);
    if (author) return author;
    return `Advance chapter ${chapterNumber} with clear narrative focus.`;
  }

  private collectMustKeep(currentState: string, storyBible: string): string[] {
    return this.unique([
      ...this.extractListItems(currentState, 2),
      ...this.extractListItems(storyBible, 2),
    ]).slice(0, 4);
  }

  private collectMustAvoid(currentFocus: string, prohibitions: ReadonlyArray<string>): string[] {
    const avoidSection = this.extractSection(currentFocus, [
      "avoid",
      "must avoid",
      "禁止",
      "避免",
      "避雷",
    ]);
    const focusAvoids = avoidSection
      ? this.extractListItems(avoidSection, 10)
      : currentFocus
        .split("\n")
        .map((line) => line.trim())
        .filter((line) =>
          line.startsWith("-") &&
          /avoid|don't|do not|不要|别|禁止/i.test(line),
        )
        .map((line) => this.cleanListItem(line))
        .filter((line): line is string => Boolean(line));

    return this.unique([...focusAvoids, ...prohibitions]).slice(0, 6);
  }

  private collectStyleEmphasis(authorIntent: string, currentFocus: string): string[] {
    return this.unique([
      ...this.extractFocusStyleItems(currentFocus),
      ...this.extractListItems(authorIntent, 2),
    ]).slice(0, 4);
  }

  private extractFirstDirective(content?: string): string | undefined {
    if (!content) return undefined;
    return content
      .split("\n")
      .map((line) => line.trim())
      .find((line) =>
        line.length > 0
        && !line.startsWith("#")
        && !line.startsWith("-")
        && !this.isTemplatePlaceholder(line),
      );
  }

  private extractListItems(content: string, limit: number): string[] {
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("-"))
      .map((line) => this.cleanListItem(line))
      .filter((line): line is string => Boolean(line))
      .slice(0, limit);
  }

  private extractFocusGoal(currentFocus: string): string | undefined {
    const focusSection = this.extractSection(currentFocus, [
      "active focus",
      "focus",
      "当前聚焦",
      "当前焦点",
      "近期聚焦",
    ]) ?? currentFocus;
    const directives = this.extractFocusStyleItems(focusSection, 3);
    if (directives.length === 0) {
      return this.extractFirstDirective(focusSection);
    }
    return directives.join(this.containsChinese(focusSection) ? "；" : "; ");
  }

  private extractLocalOverrideGoal(currentFocus: string): string | undefined {
    const overrideSection = this.extractSection(currentFocus, [
      "local override",
      "explicit override",
      "chapter override",
      "local task override",
      "局部覆盖",
      "本章覆盖",
      "临时覆盖",
      "当前覆盖",
    ]);
    if (!overrideSection) {
      return undefined;
    }

    const directives = this.extractListItems(overrideSection, 3);
    if (directives.length > 0) {
      return directives.join(this.containsChinese(overrideSection) ? "；" : "; ");
    }

    return this.extractFirstDirective(overrideSection);
  }

  private extractFocusStyleItems(currentFocus: string, limit = 3): string[] {
    const focusSection = this.extractSection(currentFocus, [
      "active focus",
      "focus",
      "当前聚焦",
      "当前焦点",
      "近期聚焦",
    ]) ?? currentFocus;
    return this.extractListItems(focusSection, limit);
  }

  private renderHookBudget(activeCount: number, language: "zh" | "en"): string {
    const cap = 12;
    if (activeCount < 10) {
      return language === "en"
        ? `### Hook Budget\n- ${activeCount} active hooks (capacity: ${cap})`
        : `### 伏笔预算\n- 当前 ${activeCount} 条活跃伏笔（容量：${cap}）`;
    }
    const remaining = Math.max(0, cap - activeCount);
    return language === "en"
      ? `### Hook Budget\n- ${activeCount} active hooks — approaching capacity (${cap}). Only ${remaining} new hook(s) allowed. Prioritize resolving existing debt over opening new threads.`
      : `### 伏笔预算\n- 当前 ${activeCount} 条活跃伏笔——接近容量上限（${cap}）。仅剩 ${remaining} 个新坑位。优先回收旧债，不要轻易开新线。`;
  }

  private extractSection(content: string, headings: ReadonlyArray<string>): string | undefined {
    const targets = headings.map((heading) => this.normalizeHeading(heading));
    const lines = content.split("\n");
    let buffer: string[] | null = null;
    let sectionLevel = 0;

    for (const line of lines) {
      const headingMatch = line.match(/^(#+)\s*(.+?)\s*$/);
      if (headingMatch) {
        const level = headingMatch[1]!.length;
        const heading = this.normalizeHeading(headingMatch[2]!);

        if (buffer && level <= sectionLevel) {
          break;
        }

        if (targets.includes(heading)) {
          buffer = [];
          sectionLevel = level;
          continue;
        }
      }

      if (buffer) {
        buffer.push(line);
      }
    }

    const section = buffer?.join("\n").trim();
    return section && section.length > 0 ? section : undefined;
  }

  private normalizeHeading(heading: string): string {
    return heading
      .toLowerCase()
      .replace(/[*_`:#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private cleanListItem(line: string): string | undefined {
    const cleaned = line.replace(/^-\s*/, "").trim();
    if (cleaned.length === 0) return undefined;
    if (/^[-|]+$/.test(cleaned)) return undefined;
    if (this.isTemplatePlaceholder(cleaned)) return undefined;
    return cleaned;
  }

  private isTemplatePlaceholder(line: string): boolean {
    const normalized = line.trim();
    if (!normalized) return false;

    return (
      /^\((describe|briefly describe|write)\b[\s\S]*\)$/i.test(normalized)
      || /^（(?:在这里描述|描述|填写|写下)[\s\S]*）$/u.test(normalized)
    );
  }

  private containsChinese(content: string): boolean {
    return /[\u4e00-\u9fff]/.test(content);
  }

  private findOutlineNode(volumeOutline: string, chapterNumber: number): string | undefined {
    const lines = volumeOutline.split("\n").map((line) => line.trim()).filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const match = this.matchExactOutlineLine(line, chapterNumber);
      if (!match) continue;

      const inlineContent = this.cleanOutlineContent(match[1]);
      if (inlineContent) {
        return inlineContent;
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        return nextContent;
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const match = this.matchRangeOutlineLine(line, chapterNumber);
      if (!match) continue;

      const inlineContent = this.cleanOutlineContent(match[3]);
      if (inlineContent) {
        return inlineContent;
      }

      const rangeStart = Number(match[1]);
      const sectionContent = this.extractSectionAroundRange(lines, index);
      if (sectionContent) {
        const beatIndex = chapterNumber - rangeStart;
        const specificBeat = this.extractNumberedBeat(sectionContent, beatIndex);
        return specificBeat ?? sectionContent;
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        return nextContent;
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!this.isOutlineAnchorLine(line)) continue;

      const exactMatch = this.matchAnyExactOutlineLine(line);
      if (exactMatch) {
        const inlineContent = this.cleanOutlineContent(exactMatch[1]);
        if (inlineContent) {
          return inlineContent;
        }
      }

      const rangeMatch = this.matchAnyRangeOutlineLine(line);
      if (rangeMatch) {
        const inlineContent = this.cleanOutlineContent(rangeMatch[3]);
        if (inlineContent) {
          return inlineContent;
        }
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        return nextContent;
      }

      break;
    }

    return this.extractFirstDirective(volumeOutline);
  }

  private cleanOutlineContent(content?: string): string | undefined {
    const cleaned = content?.trim();
    if (!cleaned) return undefined;
    if (/^[*_`~:：-]+$/.test(cleaned)) return undefined;
    return cleaned;
  }

  private extractSectionAroundRange(lines: ReadonlyArray<string>, rangeLineIndex: number): string | undefined {
    let headingIndex = -1;
    for (let i = rangeLineIndex - 1; i >= 0; i--) {
      if (lines[i]!.startsWith("#")) {
        headingIndex = i;
        break;
      }
      if (this.matchAnyRangeOutlineLine(lines[i]!) || this.matchAnyExactOutlineLine(lines[i]!)) {
        break;
      }
    }

    if (headingIndex < 0) {
      return undefined;
    }

    const headingLine = lines[headingIndex]!;
    const headingLevel = headingLine.match(/^(#+)/)?.[1]?.length ?? 3;

    const sectionLines: string[] = [];
    for (let i = headingIndex; i < lines.length; i++) {
      if (i > headingIndex) {
        const nextHeadingMatch = lines[i]!.match(/^(#+)/);
        if (nextHeadingMatch && (nextHeadingMatch[1]?.length ?? 0) <= headingLevel) {
          break;
        }
      }
      sectionLines.push(lines[i]!);
    }

    const content = sectionLines.join("\n").trim();
    return content.length > 0 ? content : undefined;
  }

  private extractNumberedBeat(section: string, beatIndex: number): string | undefined {
    if (beatIndex < 0) return undefined;

    const beats: string[] = [];
    for (const line of section.split("\n")) {
      const trimmed = line.trim();
      if (/^\d+[.)]\s/.test(trimmed)) {
        beats.push(trimmed.replace(/^\d+[.)]\s*/, ""));
      }
    }

    if (beats.length === 0 || beatIndex >= beats.length) return undefined;
    return beats[beatIndex];
  }

  private findNextOutlineContent(lines: ReadonlyArray<string>, startIndex: number): string | undefined {
    for (let index = startIndex; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line) {
        continue;
      }

      if (this.isOutlineAnchorLine(line)) {
        return undefined;
      }

      if (line.startsWith("#")) {
        continue;
      }

      const cleaned = this.cleanOutlineContent(line);
      if (cleaned) {
        return cleaned;
      }
    }

    return undefined;
  }

  private matchExactOutlineLine(line: string, chapterNumber: number): RegExpMatchArray | undefined {
    const patterns = [
      new RegExp(`^(?:#+\\s*)?(?:[-*]\\s+)?(?:\\*\\*)?Chapter\\s*${chapterNumber}(?!\\d|\\s*[-~–—]\\s*\\d)(?:[:：-])?(?:\\*\\*)?\\s*(.*)$`, "i"),
      new RegExp(`^(?:#+\\s*)?(?:[-*]\\s+)?(?:\\*\\*)?第\\s*${chapterNumber}\\s*章(?!\\d|\\s*[-~–—]\\s*\\d)(?:[:：-])?(?:\\*\\*)?\\s*(.*)$`),
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private matchAnyExactOutlineLine(line: string): RegExpMatchArray | undefined {
    const patterns = [
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?Chapter\s*\d+(?!\s*[-~–—]\s*\d)(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?第\s*\d+\s*章(?!\s*[-~–—]\s*\d)(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private matchRangeOutlineLine(line: string, chapterNumber: number): RegExpMatchArray | undefined {
    const match = this.matchAnyRangeOutlineLine(line);
    if (!match) return undefined;
    if (this.isChapterWithinRange(match[1], match[2], chapterNumber)) {
      return match;
    }

    return undefined;
  }

  private matchAnyRangeOutlineLine(line: string): RegExpMatchArray | undefined {
    const patterns = [
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?Chapter\s*(\d+)\s*[-~–—]\s*(\d+)\b(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?第\s*(\d+)\s*[-~–—]\s*(\d+)\s*章(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:[-*]\s+)?(?:\*\*)?章节范围(?:\*\*)?[：:]\s*(\d+)\s*[-~–—]\s*(\d+)\s*章\s*(.*)$/,
      /^(?:[-*]\s+)?(?:\*\*)?Chapter\s*[Rr]ange(?:\*\*)?[：:]\s*(\d+)\s*[-~–—]\s*(\d+)\b\s*(.*)$/i,
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private isOutlineAnchorLine(line: string): boolean {
    return this.matchAnyExactOutlineLine(line) !== undefined
      || this.matchAnyRangeOutlineLine(line) !== undefined;
  }

  private isChapterWithinRange(startText: string | undefined, endText: string | undefined, chapterNumber: number): boolean {
    const start = Number.parseInt(startText ?? "", 10);
    const end = Number.parseInt(endText ?? "", 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    const lower = Math.min(start, end);
    const upper = Math.max(start, end);
    return chapterNumber >= lower && chapterNumber <= upper;
  }

  private renderIntentMarkdown(
    intent: ChapterIntent,
    memo: ChapterMemo,
    language: "zh" | "en",
    pendingHooks: string,
    chapterSummaries: string,
    activeHookCount: number,
    progressDashboard: string,
  ): string {
    const mustKeep = intent.mustKeep.length > 0
      ? intent.mustKeep.map((item) => `- ${item}`).join("\n")
      : "- none";

    const mustAvoid = intent.mustAvoid.length > 0
      ? intent.mustAvoid.map((item) => `- ${item}`).join("\n")
      : "- none";

    const styleEmphasis = intent.styleEmphasis.length > 0
      ? intent.styleEmphasis.map((item) => `- ${item}`).join("\n")
      : "- none";

    const memoBody = memo.body.trim();
    const threadRefsLine = memo.threadRefs.length > 0
      ? memo.threadRefs.map((id) => `- ${id}`).join("\n")
      : "- (none)";

    return [
      "# Chapter Intent",
      "",
      "## Goal",
      intent.goal,
      "",
      "## Outline Node",
      intent.outlineNode ?? "(not found)",
      "",
      "## Arc Context",
      intent.arcContext ?? "(none)",
      "",
      "## Whole-book Progress Dashboard",
      progressDashboard || "(none)",
      "",
      "## Must Keep",
      mustKeep,
      "",
      "## Must Avoid",
      mustAvoid,
      "",
      "## Style Emphasis",
      styleEmphasis,
      "",
      "## Chapter Memo",
      `- isGoldenOpening: ${memo.isGoldenOpening ? "true" : "false"}`,
      "",
      "### Thread Refs",
      threadRefsLine,
      "",
      "### Body",
      memoBody,
      "",
      this.renderHookBudget(activeHookCount, language),
      "",
      "## Pending Hooks Snapshot",
      pendingHooks,
      "",
      "## Chapter Summaries Snapshot",
      chapterSummaries,
      "",
    ].join("\n");
  }

  private unique(values: ReadonlyArray<string>): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }

  private isChineseLanguage(language: string | undefined): boolean {
    return (language ?? "zh").toLowerCase().startsWith("zh");
  }

  // Kept for potential subclasses reading seed files directly.
  protected async readFileOrDefault(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "(文件尚未创建)";
    }
  }
}

function appendVolumeCadenceGuidance(
  volumeDirection: string,
  cadenceGuidance: string,
): string {
  const guidance = cadenceGuidance.trim();
  if (!guidance) return volumeDirection;
  const base = volumeDirection.trim() || "（未匹配到明确卷纲节点）";
  return `${base}\n\n${guidance}`;
}
