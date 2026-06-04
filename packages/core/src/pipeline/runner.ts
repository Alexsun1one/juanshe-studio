import type { LLMClient, OnStreamProgress } from "../llm/provider.js";
import { chatCompletion, createLLMClient, embedTexts } from "../llm/provider.js";
import { lookupModel } from "../llm/providers/lookup.js";
import type { Logger } from "../utils/logger.js";
import type { BookConfig, FanficMode } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { NotifyChannel, LLMConfig, AgentLLMOverride, InputGovernanceMode } from "../models/project.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { ArchitectAgent, type ArchitectOutput } from "../agents/architect.js";
import { FoundationReviewerAgent } from "../agents/foundation-reviewer.js";
import { PlannerAgent, type PlanChapterOutput } from "../agents/planner.js";
import { composeGovernedChapter, type ComposeChapterOutput } from "../agents/composer.js";
import { syncStoryGraph } from "../utils/graph-sync.js";
import { WriterAgent, type WriteChapterInput, type WriteChapterOutput } from "../agents/writer.js";
import { LengthNormalizerAgent } from "../agents/length-normalizer.js";
import { ChapterAnalyzerAgent } from "../agents/chapter-analyzer.js";
import { ContinuityAuditor } from "../agents/continuity.js";
import { ReviserAgent, DEFAULT_REVISE_MODE, type ReviseMode } from "../agents/reviser.js";
import { StateValidatorAgent } from "../agents/state-validator.js";
import { RadarAgent } from "../agents/radar.js";
import type { RadarSource } from "../agents/radar-source.js";
import { readGenreProfile } from "../agents/rules-reader.js";
import { analyzeAITells } from "../agents/ai-tells.js";
import { analyzeSensitiveWords } from "../agents/sensitive-words.js";
import { StageTracker } from "./stage-tracker.js";
import { validateHandoff } from "./agent-contracts.js";
import { StateManager } from "../state/manager.js";
import { MemoryDB, type Fact } from "../state/memory-db.js";
import { dispatchNotification, dispatchWebhookEvent } from "../notify/dispatcher.js";
import type { WebhookEvent } from "../notify/webhook.js";
import type { AgentContext } from "../agents/base.js";
import type { AuditResult, AuditIssue } from "../agents/continuity.js";
import type { RadarResult } from "../agents/radar.js";
import type { LengthSpec, LengthTelemetry } from "../models/length-governance.js";
import type { ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import { buildLengthSpec, countChapterLength, formatLengthCount, isOutsideSoftRange, resolveLengthCountingMode, type LengthLanguage } from "../utils/length-metrics.js";
import { analyzeLongSpanFatigue } from "../utils/long-span-fatigue.js";
import { buildWritingMethodologySection } from "../utils/writing-methodology.js";
import {
  isNewLayoutBook,
  readCharacterContext,
  readStoryFrame,
  readVolumeMap,
} from "../utils/outline-paths.js";
import { loadNarrativeMemorySeed, loadSnapshotCurrentStateFacts } from "../state/runtime-state-store.js";
import { rewriteStructuredStateFromMarkdown } from "../state/state-bootstrap.js";
import { readFile, readdir, writeFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  parseStateDegradedReviewNote,
  resolveStateDegradedBaseStatus,
  retrySettlementAfterValidationFailure,
} from "./chapter-state-recovery.js";
import { persistChapterArtifacts } from "./chapter-persistence.js";
import {
  runChapterReviewCycle,
  hasPremiseFidelityBlocker,
  loadPremiseAnchor,
  buildPremiseReanchorIssue,
  detectImmersionCollapse,
  buildImmersionReanchorIssue,
} from "./chapter-review-cycle.js";
import { validateChapterTruthPersistence } from "./chapter-truth-validation.js";
import { loadPersistedPlan, relativeToBookDir, savePersistedPlan } from "./persisted-governed-plan.js";
import { buildImportFoundationSource } from "./import-foundation.js";
// 历史调用方(及测试)从 runner.js 导入 buildImportFoundationSource;抽到独立模块后在此再导出,保持对外 API 不变。
export { buildImportFoundationSource } from "./import-foundation.js";
import { postWriteAnalysisTimeoutMs, withPostWriteAnalysisTimeout } from "./post-write-timeout.js";
import { saveRecoverableChapterDraft } from "./recovery-draft.js";
import { buildLengthWarnings, buildLengthTelemetry } from "./length-reporting.js";

const REVISION_BLOCKING_LONG_SPAN_CATEGORIES = new Set([
  "Opening Pattern Repetition", "开头同构",
  "Ending Pattern Repetition", "结尾同构",
  "Opening Scene Repetition", "开头场景同构",
  "Ending Scene Repetition", "结尾场景同构",
  "Structural Flow Repetition", "章节结构同构",
]);

function isRevisionBlockingLongSpanFatigue(issue: AuditIssue): boolean {
  return REVISION_BLOCKING_LONG_SPAN_CATEGORIES.has(issue.category);
}

export interface PipelineConfig {
  readonly client: LLMClient;
  readonly model: string;
  readonly projectRoot: string;
  readonly defaultLLMConfig?: LLMConfig;
  readonly foundationReviewRetries?: number;
  /** 正文章节评分/修复循环的最大轮次（来自 project config writing.reviewRetries，默认 3）。 */
  readonly writingReviewRetries?: number;
  /**
   * 写作强度档位（轻/中/重 = 省 token ↔ 最高质量）。映射到现成旋钮:
   *   light    — 复修 0 轮 + 跳过 polish/去AI味/额外评审(reader-critic+style-governor),最省 token;
   *   standard — 复修 ≤1 轮 + 单遍 polish,跳去AI味与额外评审;
   *   max      — 复修按 writingReviewRetries(默认 3)+ polish + 去AI味 + 额外评审全开(= 既有完整行为)。
   * 未设(undefined)= max,向后兼容,不改既有行为。
   */
  readonly writeIntensity?: "light" | "standard" | "max";
  readonly notifyChannels?: ReadonlyArray<NotifyChannel>;
  readonly radarSources?: ReadonlyArray<RadarSource>;
  readonly externalContext?: string;
  readonly modelOverrides?: Record<string, string | AgentLLMOverride>;
  readonly inputGovernanceMode?: InputGovernanceMode;
  readonly logger?: Logger;
  readonly onStreamProgress?: OnStreamProgress;
  readonly onTextDelta?: (text: string, meta?: { readonly agent?: string }) => void;
}

export interface TokenUsageSummary {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterPipelineResult {
  readonly chapterNumber: number;
  readonly title: string;
  readonly wordCount: number;
  readonly auditResult: AuditResult;
  readonly revised: boolean;
  readonly status: "ready-for-review" | "audit-failed" | "state-degraded";
  readonly lengthWarnings?: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly tokenUsage?: TokenUsageSummary;
}

// Atomic operation results
export interface DraftResult {
  readonly chapterNumber: number;
  readonly title: string;
  readonly wordCount: number;
  readonly filePath: string;
  readonly lengthWarnings?: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly tokenUsage?: TokenUsageSummary;
}

export interface PlanChapterResult {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly intentPath: string;
  readonly goal: string;
  readonly conflicts: ReadonlyArray<string>;
}

export interface ComposeChapterResult extends PlanChapterResult {
  readonly contextPath: string;
  readonly ruleStackPath: string;
  readonly tracePath: string;
}

export interface ReviseResult {
  readonly chapterNumber: number;
  readonly wordCount: number;
  readonly fixedIssues: ReadonlyArray<string>;
  readonly applied: boolean;
  readonly status: "unchanged" | "ready-for-review" | "audit-failed";
  readonly skippedReason?: string;
  readonly lengthWarnings?: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
}

export interface TruthFiles {
  readonly currentState: string;
  readonly particleLedger: string;
  readonly pendingHooks: string;
  readonly storyBible: string;
  readonly volumeOutline: string;
  readonly bookRules: string;
}

export interface BookStatusInfo {
  readonly bookId: string;
  readonly title: string;
  readonly genre: string;
  readonly platform: string;
  readonly status: string;
  readonly chaptersWritten: number;
  readonly totalWords: number;
  readonly nextChapter: number;
  readonly chapters: ReadonlyArray<ChapterMeta>;
}

interface MergedAuditEvaluation {
  readonly auditResult: AuditResult;
  readonly aiTellCount: number;
  readonly blockingCount: number;
  readonly criticalCount: number;
  readonly revisionBlockingIssues: ReadonlyArray<AuditIssue>;
}

export interface ImportChaptersInput {
  readonly bookId: string;
  readonly chapters: ReadonlyArray<{ readonly title: string; readonly content: string }>;
  readonly resumeFrom?: number;
  /** "continuation" (default) = pick up where the text left off, no new spacetime.
   *  "series" = shared universe but independent new story, requires new spacetime. */
  readonly importMode?: "continuation" | "series";
}

export interface ImportChaptersResult {
  readonly bookId: string;
  readonly importedCount: number;
  readonly totalWords: number;
  readonly nextChapter: number;
}

export interface InitBookOptions {
  readonly externalContext?: string;
  readonly authorIntent?: string;
  readonly currentFocus?: string;
}

export class PipelineRunner {
  /**
   * 「快轨」agent:只做结构化抽取 / 字数归一 / 状态校验 / 趋势扫描,不产出正文、
   * 不做连贯性裁决。这些角色对模型质量不敏感,主模型若声明了 fastSibling 就自动走更快
   * 更省的同源 flash 模型(见 resolveOverride)。刻意把所有「碰 prose 质量 / 连贯性判断」
   * 的角色(writer/composer/reviser/polisher/planner/auditor/architect/foundation-reviewer)
   * 排除在外,确保不降低质量。
   */
  private static readonly FAST_TIER_AGENTS: ReadonlySet<string> = new Set([
    "chapter-analyzer",
    "length-normalizer",
    "state-validator",
    "radar",
  ]);

  private readonly state: StateManager;
  private readonly config: PipelineConfig;
  private readonly agentClients = new Map<string, LLMClient>();
  private memoryIndexFallbackWarned = false;

  constructor(config: PipelineConfig) {
    this.config = config;
    this.state = new StateManager(config.projectRoot);
  }

  private localize(language: LengthLanguage, messages: { zh: string; en: string }): string {
    return language === "en" ? messages.en : messages.zh;
  }

  private async resolveBookLanguage(
    book: Pick<BookConfig, "genre" | "language">,
  ): Promise<LengthLanguage> {
    if (book.language) {
      return book.language;
    }

    try {
      const { profile } = await this.loadGenreProfile(book.genre);
      return profile.language;
    } catch {
      return "zh";
    }
  }

  private async resolveBookLanguageById(bookId: string): Promise<LengthLanguage> {
    try {
      const book = await this.state.loadBookConfig(bookId);
      return await this.resolveBookLanguage(book);
    } catch {
      return "zh";
    }
  }

  private languageFromLengthSpec(lengthSpec: Pick<LengthSpec, "countingMode">): LengthLanguage {
    return lengthSpec.countingMode === "en_words" ? "en" : "zh";
  }

  private logStage(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.info(
      `${this.localize(language, { zh: "阶段：", en: "Stage: " })}${this.localize(language, message)}`,
    );
  }

  private logInfo(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.info(this.localize(language, message));
  }

  private logWarn(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.warn(this.localize(language, message));
  }

  private async tryGenerateStyleGuide(
    bookId: string,
    referenceText: string,
    sourceName: string | undefined,
    language?: LengthLanguage,
  ): Promise<void> {
    try {
      await this.generateStyleGuide(bookId, referenceText, sourceName);
    } catch (error) {
      const resolvedLanguage = language ?? await this.resolveBookLanguageById(bookId);
      const detail = error instanceof Error ? error.message : String(error);
      this.logWarn(resolvedLanguage, {
        zh: `风格指纹提取失败，已跳过：${detail}`,
        en: `Style fingerprint extraction failed and was skipped: ${detail}`,
      });
    }
  }

  private async generateAndReviewFoundation(params: {
    readonly generate: (reviewFeedback?: string) => Promise<ArchitectOutput>;
    readonly reviewer: FoundationReviewerAgent;
    readonly mode: "original" | "fanfic" | "series";
    readonly sourceCanon?: string;
    readonly styleGuide?: string;
    readonly language: "zh" | "en";
    readonly stageLanguage: LengthLanguage;
    readonly maxRetries?: number;
  }): Promise<ArchitectOutput> {
    const maxRetries = params.maxRetries ?? this.config.foundationReviewRetries ?? 2;
    let foundation = await params.generate();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      this.logStage(params.stageLanguage, {
        zh: `审核基础设定（第${attempt + 1}轮）`,
        en: `reviewing foundation (round ${attempt + 1})`,
      });

      const review = await params.reviewer.review({
        foundation,
        mode: params.mode,
        sourceCanon: params.sourceCanon,
        styleGuide: params.styleGuide,
        language: params.language,
      });

      this.config.logger?.info(
        `Foundation review: ${review.totalScore}/100 ${review.passed ? "PASSED" : "REJECTED"}`,
      );
      for (const dim of review.dimensions) {
        this.config.logger?.info(`  [${dim.score}] ${dim.name.slice(0, 40)}`);
      }

      if (review.passed) {
        return foundation;
      }

      this.logWarn(params.stageLanguage, {
        zh: `基础设定未通过审核（${review.totalScore}分），正在重新生成...`,
        en: `Foundation rejected (${review.totalScore}/100), regenerating...`,
      });

      foundation = await params.generate(this.buildFoundationReviewFeedback(review, params.language));
    }

    // Final review
    const finalReview = await params.reviewer.review({
      foundation,
      mode: params.mode,
      sourceCanon: params.sourceCanon,
      styleGuide: params.styleGuide,
      language: params.language,
    });
    this.config.logger?.info(
      `Foundation final review: ${finalReview.totalScore}/100 ${finalReview.passed ? "PASSED" : "ACCEPTED (max retries)"}`,
    );
    if (!finalReview.passed) {
      const feedback = this.buildFoundationReviewFeedback(finalReview, params.language);
      this.logWarn(params.stageLanguage, {
        zh: `基础设定最终未通过审核（${finalReview.totalScore}分），已阻止进入写章。`,
        en: `Foundation final review failed (${finalReview.totalScore}/100); writing is blocked.`,
      });
      throw new Error(
        params.language === "en"
          ? `Foundation review failed after ${maxRetries + 1} attempts (${finalReview.totalScore}/100). Fix the blocked foundation modules before writing.\n${feedback}`
          : `基础设定审核 ${maxRetries + 1} 轮后仍未通过（${finalReview.totalScore}/100），已阻止进入写章。请先补齐建书地基。\n${feedback}`,
      );
    }

    return foundation;
  }

  private buildFoundationReviewFeedback(
    review: {
      readonly dimensions: ReadonlyArray<{
        readonly name: string;
        readonly score: number;
        readonly feedback: string;
      }>;
      readonly overallFeedback: string;
    },
    language: "zh" | "en",
  ): string {
    const dimensionLines = review.dimensions
      .map((dimension) => (
        language === "en"
          ? `- ${dimension.name} [${dimension.score}]: ${dimension.feedback}`
          : `- ${dimension.name}（${dimension.score}分）：${dimension.feedback}`
      ))
      .join("\n");

    return language === "en"
      ? [
          "## Overall Feedback",
          review.overallFeedback,
          "",
          "## Dimension Notes",
          dimensionLines || "- none",
        ].join("\n")
      : [
          "## 总评",
          review.overallFeedback,
          "",
          "## 分项问题",
          dimensionLines || "- 无",
        ].join("\n");
  }

  private resolveOverride(agentName: string): { model: string; client: LLMClient } {
    const override = this.config.modelOverrides?.[agentName];
    if (!override) {
      // 自动「快/慢双轨」:机械型 agent(抽取 / 字数归一 / 状态校验 / 趋势扫描,既不产出
      // 正文、也不做连贯性裁决)在主模型声明了 fastSibling 时,自动降配到更快更省的同源
      // flash 模型。用户显式 override 永远优先;主模型没声明 fastSibling 就保持原样。
      // 「一处声明(模型卡 fastSibling + 下方 tier 表)→ 惠及所有书」,且不耦合具体 provider 名。
      if (PipelineRunner.FAST_TIER_AGENTS.has(agentName)) {
        const card = lookupModel(this.config.defaultLLMConfig?.service ?? "", this.config.model);
        if (card?.fastSibling) {
          return { model: card.fastSibling, client: this.config.client };
        }
      }
      return { model: this.config.model, client: this.config.client };
    }
    if (typeof override === "string") {
      return { model: override, client: this.config.client };
    }
    // Full override — needs its own client if baseUrl differs
    if (!override.baseUrl) {
      return { model: override.model, client: this.config.client };
    }
    const base = this.config.defaultLLMConfig;
    const provider = override.provider ?? base?.provider ?? "custom";
    const apiKeySource = override.apiKeyEnv
      ? `env:${override.apiKeyEnv}`
      : `base:${base?.apiKey ?? ""}`;
    const stream = override.stream ?? base?.stream ?? true;
    const apiFormat = base?.apiFormat ?? "chat";
    const cacheKey = [
      provider,
      override.baseUrl,
      apiKeySource,
      `stream:${stream}`,
      `format:${apiFormat}`,
    ].join("|");
    let client = this.agentClients.get(cacheKey);
    if (!client) {
      const apiKey = override.apiKeyEnv
        ? process.env[override.apiKeyEnv] ?? ""
        : base?.apiKey ?? "";
      client = createLLMClient({
        provider,
        service: base?.service ?? "custom",
        configSource: base?.configSource ?? "env",
        baseUrl: override.baseUrl,
        apiKey,
        model: override.model,
        temperature: base?.temperature ?? 0.7,
        thinkingBudget: base?.thinkingBudget ?? 0,
        apiFormat,
        stream,
      });
      this.agentClients.set(cacheKey, client);
    }
    return { model: override.model, client };
  }

  private agentCtxFor(agent: string, bookId?: string): AgentContext {
    const { model, client } = this.resolveOverride(agent);
    return {
      client,
      model,
      projectRoot: this.config.projectRoot,
      bookId,
      logger: this.config.logger?.child(agent),
      onStreamProgress: this.config.onStreamProgress,
      onTextDelta: this.config.onTextDelta
        ? (text) => this.config.onTextDelta?.(text, { agent })
        : undefined,
    };
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private async loadGenreProfile(genre: string): Promise<{ profile: GenreProfile }> {
    const parsed = await readGenreProfile(this.config.projectRoot, genre);
    return { profile: parsed.profile };
  }

  // ---------------------------------------------------------------------------
  // Atomic operations (composable by external orchestrators or agent mode)
  // ---------------------------------------------------------------------------

  async runRadar(): Promise<RadarResult> {
    const radar = new RadarAgent(this.agentCtxFor("radar"), this.config.radarSources);
    return radar.scan();
  }

  async initBook(book: BookConfig, options: InitBookOptions = {}): Promise<void> {
    const architect = new ArchitectAgent(this.agentCtxFor("architect", book.id));
    const bookDir = this.state.bookDir(book.id);
    const stagingBookDir = join(
      this.state.booksDir,
      `.tmp-book-create-${book.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const stageLanguage = await this.resolveBookLanguage(book);
    const effectiveExternalContext = options.externalContext ?? this.config.externalContext;

    this.logStage(stageLanguage, { zh: "生成基础设定", en: "generating foundation" });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const reviewer = new FoundationReviewerAgent(this.agentCtxFor("foundation-reviewer", book.id));
    const resolvedLanguage = (book.language ?? gp.language) === "en" ? "en" as const : "zh" as const;
    const foundation = await this.generateAndReviewFoundation({
      generate: (reviewFeedback) => architect.generateFoundation(
        book,
        effectiveExternalContext,
        reviewFeedback,
      ),
      reviewer,
      mode: "original",
      language: resolvedLanguage,
      stageLanguage,
    });
    try {
      this.logStage(stageLanguage, { zh: "保存书籍配置", en: "saving book config" });
      await this.state.saveBookConfigAt(stagingBookDir, book);

      this.logStage(stageLanguage, { zh: "写入基础设定文件", en: "writing foundation files" });
      await architect.writeFoundationFiles(
        stagingBookDir,
        foundation,
        gp.numericalSystem,
        book.language ?? gp.language,
      );

      if (effectiveExternalContext && effectiveExternalContext.trim().length > 0) {
        const storyDir = join(stagingBookDir, "story");
        await mkdir(storyDir, { recursive: true });
        await writeFile(join(storyDir, "brief.md"), effectiveExternalContext, "utf-8");
      }

      this.logStage(stageLanguage, { zh: "初始化控制文档", en: "initializing control documents" });
      await this.state.ensureControlDocumentsAt(
        stagingBookDir,
        book.language ?? gp.language,
        options.authorIntent ?? effectiveExternalContext,
      );
      await writeFile(
        join(stagingBookDir, "story", "style_guide.md"),
        this.buildInitialBookStyleGuide(book, gp, foundation, resolvedLanguage),
        "utf-8",
      );
      if (options.currentFocus?.trim()) {
        await writeFile(
          join(stagingBookDir, "story", "current_focus.md"),
          options.currentFocus.trimEnd() + "\n",
          "utf-8",
        );
      }

      await this.state.saveChapterIndexAt(stagingBookDir, []);

      this.logStage(stageLanguage, { zh: "创建初始快照", en: "creating initial snapshot" });
      await this.state.snapshotStateAt(stagingBookDir, 0);

      if (await this.pathExists(bookDir)) {
        if (await this.state.isCompleteBookDirectory(bookDir)) {
          throw new Error(`Book "${book.id}" already exists at books/${book.id}/. Use a different title or delete the existing book first.`);
        }
        await rm(bookDir, { recursive: true, force: true });
      }

      await rename(stagingBookDir, bookDir);
    } catch (error) {
      await rm(stagingBookDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Revise an existing book foundation without touching runtime chapter state.
   *
   * Legacy books read the flat foundation files as source. Phase 5+ books read
   * the authoritative outline/ and roles/ files instead of the compatibility
   * shims, otherwise large role/story details can be lost during rewrite.
   */
  async reviseFoundation(bookId: string, feedback: string): Promise<void> {
    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const isPhase5 = await isNewLayoutBook(bookDir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupTag = isPhase5 ? "phase5" : "phase4";
    const backupDir = join(storyDir, `.backup-${backupTag}-${timestamp}`);
    await mkdir(backupDir, { recursive: true });

    const flatFiles = ["story_bible.md", "volume_outline.md", "book_rules.md", "character_matrix.md"];
    for (const fileName of flatFiles) {
      try {
        const content = await readFile(join(storyDir, fileName), "utf-8");
        await writeFile(join(backupDir, fileName), content, "utf-8");
      } catch {
        // Missing legacy shim files are fine for partially migrated books.
      }
    }

    if (isPhase5) {
      await this.copyDirShallow(join(storyDir, "outline"), join(backupDir, "outline"));
      await this.copyDirRecursive(join(storyDir, "roles"), join(backupDir, "roles"));
    }

    const book = await this.state.loadBookConfig(bookId);
    let oldStoryBible: string;
    let oldVolumeOutline: string;
    let oldBookRules: string;
    let oldCharacterMatrix: string;

    if (isPhase5) {
      [oldStoryBible, oldVolumeOutline, oldCharacterMatrix] = await Promise.all([
        readStoryFrame(bookDir),
        readVolumeMap(bookDir),
        readCharacterContext(bookDir),
      ]);
      oldBookRules = await readFile(join(storyDir, "book_rules.md"), "utf-8").catch(() => "");
    } else {
      [oldStoryBible, oldVolumeOutline, oldBookRules, oldCharacterMatrix] = await Promise.all([
        readFile(join(storyDir, "story_bible.md"), "utf-8").catch(() => ""),
        readFile(join(storyDir, "volume_outline.md"), "utf-8").catch(() => ""),
        readFile(join(storyDir, "book_rules.md"), "utf-8").catch(() => ""),
        readFile(join(storyDir, "character_matrix.md"), "utf-8").catch(() => ""),
      ]);
    }

    const architect = new ArchitectAgent(this.agentCtxFor("architect", bookId));
    const foundation = await architect.generateFoundation(book, undefined, undefined, {
      reviseFrom: {
        storyBible: oldStoryBible,
        volumeOutline: oldVolumeOutline,
        bookRules: oldBookRules,
        characterMatrix: oldCharacterMatrix,
        userFeedback: feedback,
      },
    });

    const reviewer = new FoundationReviewerAgent(this.agentCtxFor("foundation-reviewer", bookId));
    const resolvedLanguage = (book.language ?? "zh") === "en" ? "en" as const : "zh" as const;
    try {
      const review = await reviewer.review({
        foundation,
        mode: "original",
        language: resolvedLanguage,
      } as Parameters<FoundationReviewerAgent["review"]>[0]);
      if (!review.passed) {
        this.config.logger?.warn?.(
          `[reviseFoundation] Foundation review did not pass; accepting rewrite. Feedback: ${review.overallFeedback ?? ""}`,
        );
      }
    } catch (error) {
      this.config.logger?.warn?.(
        `[reviseFoundation] Foundation review failed and was skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const outlineDir = join(storyDir, "outline");
    await mkdir(outlineDir, { recursive: true });
    await mkdir(join(storyDir, "roles", "主要角色"), { recursive: true });
    await mkdir(join(storyDir, "roles", "次要角色"), { recursive: true });

    const { profile: gp } = await this.loadGenreProfile(book.genre);
    await architect.writeFoundationFiles(
      bookDir,
      foundation,
      gp.numericalSystem,
      book.language ?? gp.language,
      "revise",
    );
  }

  private async copyDirShallow(src: string, dest: string): Promise<void> {
    try {
      await mkdir(dest, { recursive: true });
      const entries = await readdir(src);
      await Promise.all(entries.map(async (entry) => {
        try {
          const content = await readFile(join(src, entry), "utf-8");
          await writeFile(join(dest, entry), content, "utf-8");
        } catch {
          // Skip unreadable files.
        }
      }));
    } catch {
      // Source directory does not exist.
    }
  }

  private async copyDirRecursive(src: string, dest: string): Promise<void> {
    try {
      await mkdir(dest, { recursive: true });
      const entries = await readdir(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);
        if (entry.isDirectory()) {
          await this.copyDirRecursive(srcPath, destPath);
        } else if (entry.isFile()) {
          try {
            const content = await readFile(srcPath, "utf-8");
            await writeFile(destPath, content, "utf-8");
          } catch {
            // Skip unreadable files.
          }
        }
      }
    } catch {
      // Source directory does not exist.
    }
  }

  /** Import external source material and generate fanfic_canon.md */
  async importFanficCanon(
    bookId: string,
    sourceText: string,
    sourceName: string,
    fanficMode: FanficMode,
  ): Promise<string> {
    const { FanficCanonImporter } = await import("../agents/fanfic-canon-importer.js");
    const importer = new FanficCanonImporter(this.agentCtxFor("fanfic-canon-importer", bookId));
    const result = await importer.importFromText(sourceText, sourceName, fanficMode);

    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "fanfic_canon.md"), result.fullDocument, "utf-8");

    return result.fullDocument;
  }

  /** One-step fanfic book creation: create book + import canon + generate foundation */
  async initFanficBook(
    book: BookConfig,
    sourceText: string,
    sourceName: string,
    fanficMode: FanficMode,
  ): Promise<void> {
    const bookDir = this.state.bookDir(book.id);
    const stageLanguage = await this.resolveBookLanguage(book);

    this.logStage(stageLanguage, { zh: "保存书籍配置", en: "saving book config" });
    await this.state.saveBookConfig(book.id, book);

    // Step 1: Import source material → fanfic_canon.md
    this.logStage(stageLanguage, { zh: "导入同人正典", en: "importing fanfic canon" });
    const fanficCanon = await this.importFanficCanon(book.id, sourceText, sourceName, fanficMode);

    // Step 2: Generate foundation with review loop
    const architect = new ArchitectAgent(this.agentCtxFor("architect", book.id));
    const reviewer = new FoundationReviewerAgent(this.agentCtxFor("foundation-reviewer", book.id));
    this.logStage(stageLanguage, { zh: "生成同人基础设定", en: "generating fanfic foundation" });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const resolvedLanguage = (book.language ?? gp.language) === "en" ? "en" as const : "zh" as const;
    const foundation = await this.generateAndReviewFoundation({
      generate: (reviewFeedback) => architect.generateFanficFoundation(
        book,
        fanficCanon,
        fanficMode,
        reviewFeedback,
      ),
      reviewer,
      mode: "fanfic",
      sourceCanon: fanficCanon,
      language: resolvedLanguage,
      stageLanguage,
    });
    this.logStage(stageLanguage, { zh: "写入基础设定文件", en: "writing foundation files" });
    await architect.writeFoundationFiles(
      bookDir,
      foundation,
      gp.numericalSystem,
      book.language ?? gp.language,
    );
    this.logStage(stageLanguage, { zh: "初始化控制文档", en: "initializing control documents" });
    await this.state.ensureControlDocuments(book.id, this.config.externalContext);

    // Step 3: Generate style guide from source material
    if (sourceText.length >= 500) {
      this.logStage(stageLanguage, { zh: "提取原作风格指纹", en: "extracting source style fingerprint" });
      await this.tryGenerateStyleGuide(book.id, sourceText, sourceName, stageLanguage);
    }

    // Step 4: Initialize chapters directory + snapshot
    this.logStage(stageLanguage, { zh: "创建初始快照", en: "creating initial snapshot" });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await this.state.saveChapterIndex(book.id, []);
    await this.state.snapshotState(book.id, 0);
  }

  /** Write a single draft chapter. Saves chapter file + truth files + index + snapshot. */
  async writeDraft(bookId: string, context?: string, wordCount?: number): Promise<DraftResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      await this.state.ensureControlDocuments(bookId);
      const book = await this.state.loadBookConfig(bookId);
      const bookDir = this.state.bookDir(bookId);
      const chapterNumber = await this.state.getNextChapterNumber(bookId);
      const stageLanguage = await this.resolveBookLanguage(book);
      this.logStage(stageLanguage, { zh: "准备章节输入", en: "preparing chapter inputs" });
      const writeInput = await this.prepareWriteInput(
        book,
        bookDir,
        chapterNumber,
        context ?? this.config.externalContext,
      );

      const { profile: gp } = await this.loadGenreProfile(book.genre);
      const lengthSpec = buildLengthSpec(
        wordCount ?? book.chapterWordCount,
        book.language ?? gp.language,
      );

      const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
      this.logStage(stageLanguage, { zh: "撰写章节草稿", en: "writing chapter draft" });
      const output = await writer.writeChapter({
        book,
        bookDir,
        chapterNumber,
        ...writeInput,
        lengthSpec,
        ...(wordCount ? { wordCountOverride: wordCount } : {}),
      });
      const writerCount = countChapterLength(output.content, lengthSpec.countingMode);
      let totalUsage: TokenUsageSummary = output.tokenUsage ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
      const normalizedDraft = await this.normalizeDraftLengthIfNeeded({
        bookId,
        chapterNumber,
        chapterContent: output.content,
        lengthSpec,
        chapterIntent: writeInput.chapterIntent,
      });
      totalUsage = PipelineRunner.addUsage(totalUsage, normalizedDraft.tokenUsage);
      const draftOutput: WriteChapterOutput = {
        ...output,
        content: normalizedDraft.content,
        wordCount: normalizedDraft.wordCount,
        tokenUsage: totalUsage,
      };
      const lengthWarnings = buildLengthWarnings(
        chapterNumber,
        draftOutput.wordCount,
        lengthSpec,
      );
      const lengthTelemetry = buildLengthTelemetry({
        lengthSpec,
        writerCount,
        postWriterNormalizeCount: normalizedDraft.wordCount,
        postReviseCount: 0,
        finalCount: draftOutput.wordCount,
        normalizeApplied: normalizedDraft.applied,
        lengthWarning: lengthWarnings.length > 0,
      });
      this.logLengthWarnings(lengthWarnings);

      // Save chapter file
      const chaptersDir = join(bookDir, "chapters");
      const paddedNum = String(chapterNumber).padStart(4, "0");
      const sanitized = draftOutput.title.replace(/[/\\?%*:|"<>]/g, "").replace(/\s+/g, "_").slice(0, 50);
      const filename = `${paddedNum}_${sanitized}.md`;
      const filePath = join(chaptersDir, filename);

      const resolvedLang = book.language ?? gp.language;
      const heading = resolvedLang === "en"
        ? `# Chapter ${chapterNumber}: ${draftOutput.title}`
        : `# 第${chapterNumber}章 ${draftOutput.title}`;
      await writeFile(filePath, `${heading}\n\n${draftOutput.content}`, "utf-8");

      // Save truth files
      this.logStage(stageLanguage, { zh: "落盘草稿与真相文件", en: "persisting draft and truth files" });
      await writer.saveChapter(bookDir, draftOutput, gp.numericalSystem, resolvedLang);
      await writer.saveNewTruthFiles(bookDir, draftOutput, resolvedLang);
      await this.syncLegacyStructuredStateFromMarkdown(bookDir, chapterNumber, draftOutput);
      await this.syncNarrativeMemoryIndex(bookId);
      await this.syncStoryGraphIndex(bookId, chapterNumber);

      // Update index
      const existingIndex = await this.state.loadChapterIndex(bookId);
      const now = new Date().toISOString();
      const newEntry: ChapterMeta = {
        number: chapterNumber,
        title: draftOutput.title,
        status: "drafted",
        wordCount: draftOutput.wordCount,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings,
        lengthTelemetry,
        ...(draftOutput.tokenUsage ? { tokenUsage: draftOutput.tokenUsage } : {}),
      };
      const existingIdx = existingIndex.findIndex((e) => e.number === chapterNumber);
      const updatedIndex = existingIdx >= 0
        ? existingIndex.map((e, i) => i === existingIdx ? newEntry : e)
        : [...existingIndex, newEntry];
      await this.state.saveChapterIndex(bookId, updatedIndex);
      await this.markBookActiveIfNeeded(bookId);

      // Snapshot
      this.logStage(stageLanguage, { zh: "更新章节索引与快照", en: "updating chapter index and snapshots" });
      await this.state.snapshotState(bookId, chapterNumber);
      await this.syncCurrentStateFactHistory(bookId, chapterNumber);

      await this.emitWebhook("chapter-complete", bookId, chapterNumber, {
        title: draftOutput.title,
        wordCount: draftOutput.wordCount,
      });

      return {
        chapterNumber,
        title: draftOutput.title,
        wordCount: draftOutput.wordCount,
        filePath,
        lengthWarnings,
        lengthTelemetry,
        tokenUsage: draftOutput.tokenUsage,
      };
    } finally {
      await releaseLock();
    }
  }

  async planChapter(bookId: string, context?: string): Promise<PlanChapterResult> {
    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const chapterNumber = await this.state.getNextChapterNumber(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    this.logStage(stageLanguage, { zh: "规划下一章意图", en: "planning next chapter intent" });
    const { plan } = await this.createGovernedArtifacts(
      book,
      bookDir,
      chapterNumber,
      context ?? this.config.externalContext,
      { reuseExistingIntentWhenContextMissing: false },
    );

    return {
      bookId,
      chapterNumber,
      intentPath: relativeToBookDir(bookDir, plan.runtimePath),
      goal: plan.intent.goal,
      conflicts: [],
    };
  }

  async composeChapter(bookId: string, context?: string): Promise<ComposeChapterResult> {
    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const chapterNumber = await this.state.getNextChapterNumber(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    this.logStage(stageLanguage, { zh: "组装章节运行时上下文", en: "composing chapter runtime context" });
    const { plan, composed } = await this.createGovernedArtifacts(
      book,
      bookDir,
      chapterNumber,
      context ?? this.config.externalContext,
      { reuseExistingIntentWhenContextMissing: true },
    );

    return {
      bookId,
      chapterNumber,
      intentPath: relativeToBookDir(bookDir, plan.runtimePath),
      goal: plan.intent.goal,
      conflicts: [],
      contextPath: relativeToBookDir(bookDir, composed.contextPath),
      ruleStackPath: relativeToBookDir(bookDir, composed.ruleStackPath),
      tracePath: relativeToBookDir(bookDir, composed.tracePath),
    };
  }

  /** Audit the latest (or specified) chapter. Read-only, no lock needed. */
  async auditDraft(bookId: string, chapterNumber?: number): Promise<AuditResult & { readonly chapterNumber: number }> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const targetChapter = chapterNumber ?? (await this.state.getNextChapterNumber(bookId)) - 1;
    if (targetChapter < 1) {
      throw new Error(`No chapters to audit for "${bookId}"`);
    }

    const content = await this.readChapterContent(bookDir, targetChapter);
    const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const language = book.language ?? gp.language;
    this.logStage(language, {
      zh: `审计第${targetChapter}章`,
      en: `auditing chapter ${targetChapter}`,
    });
    const evaluation = await this.evaluateMergedAudit({
      auditor,
      book,
      bookDir,
      chapterContent: content,
      chapterNumber: targetChapter,
      language,
    });
    const result = evaluation.auditResult;

    // Update index with audit result
    const index = await this.state.loadChapterIndex(bookId);
    const updated = index.map((ch) =>
      ch.number === targetChapter
        ? {
            ...ch,
            status: (result.passed ? "ready-for-review" : "audit-failed") as ChapterMeta["status"],
            updatedAt: new Date().toISOString(),
            auditIssues: result.issues.map((i) => `[${i.severity}] ${i.description}`),
          }
        : ch,
    );
    await this.state.saveChapterIndex(bookId, updated);
    const latestChapter = index.length > 0 ? Math.max(...index.map((chapter) => chapter.number)) : targetChapter;
    if (targetChapter === latestChapter) {
      await this.persistAuditDriftGuidance({
        bookDir,
        chapterNumber: targetChapter,
        issues: result.issues.filter((issue) => issue.severity === "critical" || issue.severity === "warning"),
        language,
      }).catch(() => undefined);
    }

    await this.emitWebhook(
      result.passed ? "audit-passed" : "audit-failed",
      bookId,
      targetChapter,
      { summary: result.summary, issueCount: result.issues.length },
    );

    return { ...result, chapterNumber: targetChapter };
  }

  /** Revise the latest (or specified) chapter based on audit issues. */
  async reviseDraft(bookId: string, chapterNumber?: number, mode: ReviseMode = DEFAULT_REVISE_MODE): Promise<ReviseResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      const book = await this.state.loadBookConfig(bookId);
      const bookDir = this.state.bookDir(bookId);
      const targetChapter = chapterNumber ?? (await this.state.getNextChapterNumber(bookId)) - 1;
      if (targetChapter < 1) {
        throw new Error(`No chapters to revise for "${bookId}"`);
      }

      const stageLanguage = await this.resolveBookLanguage(book);
      // Read the current audit issues from index
      this.logStage(stageLanguage, {
        zh: `加载第${targetChapter}章修订上下文`,
        en: `loading revision context for chapter ${targetChapter}`,
      });
      const index = await this.state.loadChapterIndex(bookId);
      const chapterMeta = index.find((ch) => ch.number === targetChapter);
      if (!chapterMeta) {
        throw new Error(`Chapter ${targetChapter} not found in index`);
      }

      // Re-audit to get structured issues (index only stores strings)
      const content = await this.readChapterContent(bookDir, targetChapter);
      const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
      const { profile: gp } = await this.loadGenreProfile(book.genre);
      const language = book.language ?? gp.language;
      const countingMode = resolveLengthCountingMode(language);
      const reviseControlInput = (this.config.inputGovernanceMode ?? "v2") === "legacy"
        ? undefined
        : await this.createGovernedArtifacts(
          book,
          bookDir,
          targetChapter,
          this.config.externalContext,
          { reuseExistingIntentWhenContextMissing: true },
        );
      const preRevision = await this.evaluateMergedAudit({
        auditor,
        book,
        bookDir,
        chapterContent: content,
        chapterNumber: targetChapter,
        language,
        auditOptions: reviseControlInput
          ? {
              chapterIntent: reviseControlInput.plan.intentMarkdown,
              chapterMemo: reviseControlInput.plan.memo,
              contextPackage: reviseControlInput.composed.contextPackage,
              ruleStack: reviseControlInput.composed.ruleStack,
            }
          : undefined,
      });

      if (preRevision.blockingCount === 0 && preRevision.aiTellCount === 0) {
        return {
          chapterNumber: targetChapter,
          wordCount: countChapterLength(content, countingMode),
          fixedIssues: [],
          applied: false,
          status: "unchanged",
          skippedReason: "No warning, critical, or AI-tell issues to fix.",
        };
      }

      const chapterLengthTarget = chapterMeta.lengthTelemetry?.target ?? book.chapterWordCount;
      const lengthLanguage = chapterMeta.lengthTelemetry?.countingMode === "en_words"
        ? "en"
        : language;
      const lengthSpec = buildLengthSpec(
        chapterLengthTarget,
        lengthLanguage,
      );

      const reviser = new ReviserAgent(this.agentCtxFor("reviser", bookId));
      this.logStage(stageLanguage, {
        zh: `修订第${targetChapter}章`,
        en: `revising chapter ${targetChapter}`,
      });

      // 缺陷1 修复：复修路径此前绕过 runChapterReviewCycle，拿不到
      // 主设定漂移的结构重锚。这里复用与写作路径完全一致的
      // premise 重锚逻辑，让复修也能在偏离全书核心设定时自我重锚，
      // 而不是只做泛化局部修后停在 89 平台、每次靠人工拉回。
      // 缺陷5 同处补全：复修路径同样要能处理"沉浸塌方"——它是
      // style/immersion 数值触底却 criticals:0 的头号成因，泛化局部修
      // 永远抬不动。premise 漂移 / 沉浸塌方任一命中即升 rework + 注入
      // 对应结构性重锚指令，与写作路径同机制，不再靠人工拉回。
      const premiseBlockedInRepair = hasPremiseFidelityBlocker(
        preRevision.auditResult.issues,
      );
      const immersionCollapsedInRepair = detectImmersionCollapse(content);
      const isEnglishRepair = !/[一-鿿]/.test(content.slice(0, 2000));
      let repairReviseMode = mode;
      const repairExtraIssues: AuditIssue[] = [];
      if (premiseBlockedInRepair) {
        const anchor = await loadPremiseAnchor(bookDir);
        if (anchor.length > 0) {
          repairReviseMode = "rework";
          repairExtraIssues.push(
            buildPremiseReanchorIssue(anchor, isEnglishRepair),
          );
        }
      }
      if (immersionCollapsedInRepair) {
        repairReviseMode = "rework";
        repairExtraIssues.push(buildImmersionReanchorIssue(isEnglishRepair));
      }
      const repairIssues = repairExtraIssues.length
        ? [...repairExtraIssues, ...preRevision.auditResult.issues]
        : preRevision.auditResult.issues;
      if (repairReviseMode === "rework") {
        const tags = [
          premiseBlockedInRepair ? "主设定漂移" : "",
          immersionCollapsedInRepair ? "沉浸塌方" : "",
        ]
          .filter(Boolean)
          .join("+");
        this.logStage(stageLanguage, {
          zh: `复修检测到${tags} → 结构重锚`,
          en: `repair detected structural defect (${premiseBlockedInRepair ? "premise-drift " : ""}${immersionCollapsedInRepair ? "immersion-collapse" : ""}) → re-anchor`,
        });
      }

      const reviseOutput = await reviser.reviseChapter(
        bookDir,
        content,
        targetChapter,
        repairIssues,
        repairReviseMode,
        book.genre,
        reviseControlInput
          ? {
              chapterIntent: reviseControlInput.plan.intentMarkdown,
              chapterMemo: reviseControlInput.plan.memo,
              chapterIntentData: reviseControlInput.plan.intent,
              contextPackage: reviseControlInput.composed.contextPackage,
              ruleStack: reviseControlInput.composed.ruleStack,
              lengthSpec,
            }
          : { lengthSpec },
      );

      if (reviseOutput.revisedContent.length === 0) {
        throw new Error("Reviser returned empty content");
      }
      const normalizedRevision = await this.normalizeDraftLengthIfNeeded({
        bookId,
        chapterNumber: targetChapter,
        chapterContent: reviseOutput.revisedContent,
        lengthSpec,
      });
      const postRevision = await this.evaluateMergedAudit({
        auditor,
        book,
        bookDir,
        chapterContent: normalizedRevision.content,
        chapterNumber: targetChapter,
        language,
        auditOptions: reviseControlInput
          ? {
              temperature: 0,
              chapterIntent: reviseControlInput.plan.intentMarkdown,
              chapterMemo: reviseControlInput.plan.memo,
              contextPackage: reviseControlInput.composed.contextPackage,
              ruleStack: reviseControlInput.composed.ruleStack,
              truthFileOverrides: {
                currentState: reviseOutput.updatedState !== "(状态卡未更新)" ? reviseOutput.updatedState : undefined,
                ledger: reviseOutput.updatedLedger !== "(账本未更新)" ? reviseOutput.updatedLedger : undefined,
                hooks: reviseOutput.updatedHooks !== "(伏笔池未更新)" ? reviseOutput.updatedHooks : undefined,
              },
            }
          : {
              temperature: 0,
              truthFileOverrides: {
                currentState: reviseOutput.updatedState !== "(状态卡未更新)" ? reviseOutput.updatedState : undefined,
                ledger: reviseOutput.updatedLedger !== "(账本未更新)" ? reviseOutput.updatedLedger : undefined,
                hooks: reviseOutput.updatedHooks !== "(伏笔池未更新)" ? reviseOutput.updatedHooks : undefined,
              },
            },
      });
      const effectivePostRevision = this.restoreActionableAuditIfLost(
        preRevision,
        postRevision,
      );
      const revisionBaseCount = countChapterLength(content, lengthSpec.countingMode);
      const lengthWarnings = buildLengthWarnings(
        targetChapter,
        normalizedRevision.wordCount,
        lengthSpec,
      );
      const lengthTelemetry = buildLengthTelemetry({
        lengthSpec,
        writerCount: revisionBaseCount,
        postWriterNormalizeCount: 0,
        postReviseCount: normalizedRevision.wordCount,
        finalCount: normalizedRevision.wordCount,
        normalizeApplied: normalizedRevision.applied,
        lengthWarning: lengthWarnings.length > 0,
      });

      const improvedBlocking = effectivePostRevision.blockingCount < preRevision.blockingCount;
      const improvedAITells = effectivePostRevision.aiTellCount < preRevision.aiTellCount;
      const blockingDidNotWorsen = effectivePostRevision.blockingCount <= preRevision.blockingCount;
      const criticalDidNotWorsen = effectivePostRevision.criticalCount <= preRevision.criticalCount;
      const aiDidNotWorsen = effectivePostRevision.aiTellCount <= preRevision.aiTellCount;
      const shouldApplyRevision = blockingDidNotWorsen
        && criticalDidNotWorsen
        && aiDidNotWorsen
        && (improvedBlocking || improvedAITells);

      if (!shouldApplyRevision) {
        return {
          chapterNumber: targetChapter,
          wordCount: revisionBaseCount,
          fixedIssues: [],
          applied: false,
          status: "unchanged",
          skippedReason: "Manual revision did not improve merged audit or AI-tell metrics; kept original chapter.",
        };
      }
      this.logLengthWarnings(lengthWarnings);

      // Save revised chapter file
      this.logStage(stageLanguage, {
        zh: `落盘第${targetChapter}章修订结果`,
        en: `persisting revision for chapter ${targetChapter}`,
      });
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(targetChapter).padStart(4, "0");
      const existingFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!existingFile) {
        throw new Error(`Chapter ${targetChapter} file not found in ${chaptersDir} (expected filename starting with ${paddedNum})`);
      }
      const reviseLang = book.language ?? gp.language;
      const reviseHeading = reviseLang === "en"
        ? `# Chapter ${targetChapter}: ${chapterMeta.title}`
        : `# 第${targetChapter}章 ${chapterMeta.title}`;
      await writeFile(
        join(chaptersDir, existingFile),
        `${reviseHeading}\n\n${normalizedRevision.content}`,
        "utf-8",
      );

      // Update truth files
      const storyDir = join(bookDir, "story");
      if (reviseOutput.updatedState !== "(状态卡未更新)") {
        await writeFile(join(storyDir, "current_state.md"), reviseOutput.updatedState, "utf-8");
      }
      if (gp.numericalSystem && reviseOutput.updatedLedger && reviseOutput.updatedLedger !== "(账本未更新)") {
        await writeFile(join(storyDir, "particle_ledger.md"), reviseOutput.updatedLedger, "utf-8");
      }
      if (reviseOutput.updatedHooks !== "(伏笔池未更新)") {
        await writeFile(join(storyDir, "pending_hooks.md"), reviseOutput.updatedHooks, "utf-8");
      }
      await this.syncLegacyStructuredStateFromMarkdown(bookDir, targetChapter);

      // Update index
      const updatedIndex = index.map((ch) =>
        ch.number === targetChapter
          ? {
              ...ch,
              status: (effectivePostRevision.auditResult.passed ? "ready-for-review" : "audit-failed") as ChapterMeta["status"],
              wordCount: normalizedRevision.wordCount,
              updatedAt: new Date().toISOString(),
              auditIssues: effectivePostRevision.auditResult.issues.map((i) => `[${i.severity}] ${i.description}`),
              lengthWarnings,
              lengthTelemetry,
            }
          : ch,
      );
      await this.state.saveChapterIndex(bookId, updatedIndex);
      const latestChapter = index.length > 0 ? Math.max(...index.map((chapter) => chapter.number)) : targetChapter;
      if (targetChapter === latestChapter) {
        await this.persistAuditDriftGuidance({
          bookDir,
          chapterNumber: targetChapter,
          issues: effectivePostRevision.auditResult.issues.filter(
            (issue) => issue.severity === "critical" || issue.severity === "warning",
          ),
          language,
        }).catch(() => undefined);
      }

      // Re-snapshot
      this.logStage(stageLanguage, {
        zh: `更新第${targetChapter}章索引与快照`,
        en: `updating chapter index and snapshots for chapter ${targetChapter}`,
      });
      await this.state.snapshotState(bookId, targetChapter);
      await this.syncNarrativeMemoryIndex(bookId);
      await this.syncStoryGraphIndex(bookId, targetChapter);
      await this.syncCurrentStateFactHistory(bookId, targetChapter);

      await this.emitWebhook("revision-complete", bookId, targetChapter, {
        wordCount: normalizedRevision.wordCount,
        fixedCount: reviseOutput.fixedIssues.length,
      });

      return {
        chapterNumber: targetChapter,
        wordCount: normalizedRevision.wordCount,
        fixedIssues: reviseOutput.fixedIssues,
        applied: true,
        status: effectivePostRevision.auditResult.passed ? "ready-for-review" : "audit-failed",
        lengthWarnings,
        lengthTelemetry,
      };
    } finally {
      await releaseLock();
    }
  }

  /** Read all truth files for a book. */
  async readTruthFiles(bookId: string): Promise<TruthFiles> {
    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const readSafe = async (path: string): Promise<string> => {
      try {
        return await readFile(path, "utf-8");
      } catch {
        return "(文件不存在)";
      }
    };

    // Phase 5: prefer the new prose outline files; fall back to legacy paths.
    const readOutline = async (newRel: string, legacyRel: string): Promise<string> => {
      const preferred = await readSafe(join(storyDir, newRel));
      if (preferred.trim() && preferred !== "(文件不存在)") return preferred;
      return readSafe(join(storyDir, legacyRel));
    };

    const [currentState, particleLedger, pendingHooks, storyBible, volumeOutline, bookRules] =
      await Promise.all([
        readSafe(join(storyDir, "current_state.md")),
        readSafe(join(storyDir, "particle_ledger.md")),
        readSafe(join(storyDir, "pending_hooks.md")),
        readOutline("outline/story_frame.md", "story_bible.md"),
        readOutline("outline/volume_map.md", "volume_outline.md"),
        readSafe(join(storyDir, "book_rules.md")),
      ]);

    return { currentState, particleLedger, pendingHooks, storyBible, volumeOutline, bookRules };
  }

  /** Get book status overview. */
  async getBookStatus(bookId: string): Promise<BookStatusInfo> {
    const book = await this.state.loadBookConfig(bookId);
    const chapters = await this.state.loadChapterIndex(bookId);
    const nextChapter = await this.state.getNextChapterNumber(bookId);
    const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0);

    return {
      bookId,
      title: book.title,
      genre: book.genre,
      platform: book.platform,
      status: book.status,
      chaptersWritten: chapters.length,
      totalWords,
      nextChapter,
      chapters: [...chapters],
    };
  }

  // ---------------------------------------------------------------------------
  // Full pipeline (convenience — runs draft + audit + revise in one shot)
  // ---------------------------------------------------------------------------

  async writeNextChapter(bookId: string, wordCount?: number, temperatureOverride?: number): Promise<ChapterPipelineResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      return await this._writeNextChapterLocked(bookId, wordCount, temperatureOverride, this.config.externalContext);
    } finally {
      await releaseLock();
    }
  }

  async repairChapterState(bookId: string, chapterNumber?: number): Promise<ChapterPipelineResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      return await this._repairChapterStateLocked(bookId, chapterNumber);
    } finally {
      await releaseLock();
    }
  }

  async resyncChapterArtifacts(bookId: string, chapterNumber?: number): Promise<ChapterPipelineResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      return await this._resyncChapterArtifactsLocked(bookId, chapterNumber);
    } finally {
      await releaseLock();
    }
  }

  private async _writeNextChapterLocked(
    bookId: string,
    wordCount?: number,
    temperatureOverride?: number,
    externalContext?: string,
  ): Promise<ChapterPipelineResult> {
    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    await this.assertNoPendingStateRepair(bookId);
    // 写作强度档位 → 各阶段开关(轻=省 token / 重=最高质量);未设 = max(向后兼容,不改既有行为)。
    const _wi = this.config.writeIntensity ?? "max";
    const intensityKnobs = {
      reviewRetries: _wi === "light" ? 0 : _wi === "standard" ? Math.min(this.config.writingReviewRetries ?? 1, 1) : this.config.writingReviewRetries,
      polish: _wi !== "light",
      deAiPolish: _wi === "max",
      extraReviewers: _wi === "max",
    };
    if (_wi !== "max") {
      this.logInfo(await this.resolveBookLanguage(book), {
        zh: `写作强度档位:${_wi === "light" ? "轻量(省 token)" : "均衡"} —— 复修≤${intensityKnobs.reviewRetries ?? 3}轮${intensityKnobs.polish ? " + 润色" : ""}${intensityKnobs.extraReviewers ? " + 读者/风格评审" : ""}`,
        en: `write intensity: ${_wi} — review ≤${intensityKnobs.reviewRetries ?? 3}${intensityKnobs.polish ? " + polish" : ""}${intensityKnobs.extraReviewers ? " + extra reviewers" : ""}`,
      });
    }
    const chapterNumber = await this.state.getNextChapterNumber(bookId);
    // 单章时间预算 + 阶段追踪:防止单章在重试/挂起里无限耗时,并让"卡在哪个阶段/多久"可观测。
    const chapterTracker = new StageTracker(Number(process.env.HARDWRITE_CHAPTER_BUDGET_MS) || 1_200_000);
    const stageLanguage = await this.resolveBookLanguage(book);
    chapterTracker.mark("prepare");
    this.logStage(stageLanguage, { zh: "准备章节输入", en: "preparing chapter inputs" });
    const writeInput = await this.prepareWriteInput(
      book,
      bookDir,
      chapterNumber,
      externalContext,
    );
    const reducedControlInput = writeInput.chapterIntent && writeInput.contextPackage && writeInput.ruleStack
      ? {
          chapterIntent: writeInput.chapterIntent,
          chapterMemo: writeInput.chapterMemo,
          chapterIntentData: writeInput.chapterIntentData,
          contextPackage: writeInput.contextPackage,
          ruleStack: writeInput.ruleStack,
        }
      : undefined;
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const pipelineLang = book.language ?? gp.language;
    const lengthSpec = buildLengthSpec(
      wordCount ?? book.chapterWordCount,
      pipelineLang,
    );
    const {
      normalizePostWriteSurface,
      validatePostWrite: postWriteValidate,
    } = await import("../agents/post-write-validator.js");
    const { validateHookLedger } = await import("../utils/hook-ledger-validator.js");
    const { readBookRules } = await import("../agents/rules-reader.js");
    const parsedBookRules = (await readBookRules(bookDir))?.rules ?? null;

    // 1. Write chapter
    // 显式交接校验:写手启动前确认 planner 该产出的章节意图/上下文是否到位(缺失记警告+归因,不阻断 legacy 路径)。
    const writerHandoff = validateHandoff("writer", {
      chapter_intent: writeInput.chapterIntent,
      context_package: writeInput.contextPackage,
      rule_stack: writeInput.ruleStack,
    });
    if (!writerHandoff.ok) {
      this.logWarn(stageLanguage, {
        zh: `交接告警:${writerHandoff.reason};写手以降级上下文继续(legacy 路径)`,
        en: `handoff warning: ${writerHandoff.reason}; writer continues with degraded context (legacy path)`,
      });
    }
    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    chapterTracker.mark("write");
    this.logStage(stageLanguage, { zh: "撰写章节草稿", en: "writing chapter draft" });
    const output = await writer.writeChapter({
      book,
      bookDir,
      chapterNumber,
      ...writeInput,
      lengthSpec,
      ...(wordCount ? { wordCountOverride: wordCount } : {}),
      ...(temperatureOverride ? { temperatureOverride } : {}),
    });
    const writerCount = countChapterLength(output.content, lengthSpec.countingMode);
    await saveRecoverableChapterDraft({
      bookDir,
      chapterNumber,
      title: output.title,
      content: output.content,
      stage: "writer",
      language: pipelineLang,
      wordCount: writerCount,
    }).catch((error) => {
      this.config.logger?.warn(`[recovery] failed to save writer draft for chapter ${chapterNumber}: ${error instanceof Error ? error.message : String(error)}`);
    });

    // Token usage accumulator
    let totalUsage: TokenUsageSummary = output.tokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
    chapterTracker.mark("review");
    const reviewResult = await runChapterReviewCycle({
      book: { genre: book.genre },
      bookDir,
      chapterNumber,
      initialOutput: output,
      reducedControlInput,
      lengthSpec,
      reviewRetries: intensityKnobs.reviewRetries,
      deadlineAt: chapterTracker.deadlineAt,
      initialUsage: totalUsage,
      createReviser: () => new ReviserAgent(this.agentCtxFor("reviser", bookId)),
      auditor,
      normalizeDraftLengthIfNeeded: (chapterContent) => this.normalizeDraftLengthIfNeeded({
        bookId,
        chapterNumber,
        chapterContent,
        lengthSpec,
        chapterIntent: writeInput.chapterIntent,
      }),
      normalizePostWriteSurface: (chapterContent) =>
        normalizePostWriteSurface(chapterContent, pipelineLang),
      assertChapterContentNotEmpty: (content, stage) =>
        this.assertChapterContentNotEmpty(content, chapterNumber, stage),
      addUsage: PipelineRunner.addUsage,
      analyzeAITells: (content) => analyzeAITells(content, pipelineLang),
      analyzeSensitiveWords: (content) => analyzeSensitiveWords(content, undefined, pipelineLang),
      runPostWriteChecks: (content) => {
        const baseIssues = postWriteValidate(content, gp, parsedBookRules, pipelineLang)
          .filter((v) => v.severity === "error")
          .map((v) => ({
            severity: "critical" as const,
            category: v.rule,
            description: v.description,
            suggestion: v.suggestion,
          }));
        // Phase 9-3: verify the draft acts on every hook the memo committed to.
        const memoBody = writeInput.chapterMemo?.body ?? "";
        const ledgerIssues = memoBody
          ? validateHookLedger(memoBody, content)
          : [];
        return [...baseIssues, ...ledgerIssues];
      },
      logWarn: (message) => this.logWarn(pipelineLang, message),
      logStage: (message) => this.logStage(stageLanguage, message),
    });
    totalUsage = reviewResult.totalUsage;
    chapterTracker.mark("persist");
    this.logInfo(stageLanguage, {
      zh: `章节阶段耗时:${chapterTracker.summary()}${chapterTracker.overBudget ? "(已超单章预算)" : ""}`,
      en: `chapter stage timing: ${chapterTracker.summary()}${chapterTracker.overBudget ? " (over budget)" : ""}`,
    });
    let finalContent = reviewResult.finalContent;
    let finalWordCount = reviewResult.finalWordCount;
    let revised = reviewResult.revised;
    let auditResult = reviewResult.auditResult;
    const postReviseCount = reviewResult.postReviseCount;
    const normalizeApplied = reviewResult.normalizeApplied;

    // 3b. File-layer polish pass — runs AFTER structural audit accepts the
    // chapter. Polisher only touches sentence craft / paragraph shape /
    // wording / sensory detail / dialogue naturalness. Plot / character /
    // mainline stay frozen. Skipped when audit did not produce a passing
    // chapter (leave the failing draft visible for the next cycle) or when
    // length is dangerously off-range (normalize should handle it, not polish).
    if (auditResult.passed && intensityKnobs.polish) {
      try {
        const { PolisherAgent } = await import("../agents/polisher.js");
        const { aiToneScore } = await import("../agents/ai-tells.js");
        const polisher = new PolisherAgent(this.agentCtxFor("polisher", bookId));
        const polishLang = pipelineLang === "en" ? "en" : "zh";
        this.logStage(stageLanguage, { zh: "文字层润色", en: "polishing prose" });
        const polishOutput = await polisher.polishChapter({
          chapterContent: finalContent,
          chapterNumber,
          chapterMemo: reducedControlInput?.chapterMemo,
          language: polishLang,
        });
        totalUsage = PipelineRunner.addUsage(totalUsage, polishOutput.tokenUsage);
        if (polishOutput.changed && polishOutput.polishedContent.trim().length > 0) {
          finalContent = normalizePostWriteSurface(polishOutput.polishedContent, pipelineLang);
          finalWordCount = countChapterLength(finalContent, lengthSpec.countingMode);
        }
        // 去 AI 味自动追加一轮:首轮润色后人味指数仍 < 阈值,就再跑一轮专项去 AI 味润色。
        // 单轮触发(不递归循环),避免烧 token;阈值与总编签发硬门禁一致(70)。
        const AI_TONE_POLISH_FLOOR = 70;
        const toneAfterFirst = aiToneScore(finalContent, polishLang);
        if (toneAfterFirst < AI_TONE_POLISH_FLOOR && intensityKnobs.deAiPolish) {
          this.logStage(stageLanguage, {
            zh: `人味 ${toneAfterFirst} < ${AI_TONE_POLISH_FLOOR},自动追加一轮去 AI 味润色`,
            en: `humanness ${toneAfterFirst} < ${AI_TONE_POLISH_FLOOR}, auto extra de-AI polish pass`,
          });
          const deAiOutput = await polisher.polishChapter({
            chapterContent: finalContent,
            chapterNumber,
            chapterMemo: reducedControlInput?.chapterMemo,
            language: polishLang,
            deAiFocus: true,
          });
          totalUsage = PipelineRunner.addUsage(totalUsage, deAiOutput.tokenUsage);
          if (deAiOutput.changed && deAiOutput.polishedContent.trim().length > 0) {
            finalContent = normalizePostWriteSurface(deAiOutput.polishedContent, pipelineLang);
            finalWordCount = countChapterLength(finalContent, lengthSpec.countingMode);
            this.logInfo(pipelineLang, {
              zh: `去 AI 味润色完成:人味 ${toneAfterFirst} → ${aiToneScore(finalContent, polishLang)}`,
              en: `de-AI polish done: humanness ${toneAfterFirst} → ${aiToneScore(finalContent, polishLang)}`,
            });
          }
        }
      } catch (error) {
        this.logWarn(pipelineLang, {
          zh: `润色阶段失败：${error instanceof Error ? error.message : String(error)}`,
          en: `polish stage failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    // 3.5 B6 — 高质量模式:reader-critic + style-governor 并行评分
    // 默认开,可以 HARDWRITE_DISABLE_EXTRA_REVIEWERS=1 关掉。
    // 这两个 agent 不触发 reviser 二次修(audit 已经做了那件事),
    // 它们的输出作为额外评分 + warning 添加到 auditResult.issues 给 UI 显示。
    // 配合 B2 prompt caching,chapter content 在 audit / reviser / polisher / reader-critic / style-governor
    // 之间复用 → 同章重复 read 的 token 走缓存价(1/10)。
    if (auditResult.passed && intensityKnobs.extraReviewers && process.env.HARDWRITE_DISABLE_EXTRA_REVIEWERS !== "1") {
      try {
        const [{ ReaderCriticAgent }, { StyleGovernorAgent }] = await Promise.all([
          import("../agents/reader-critic.js"),
          import("../agents/style-governor.js"),
        ]);
        const readerCritic = new ReaderCriticAgent(this.agentCtxFor("reader-critic", bookId));
        const styleGovernor = new StyleGovernorAgent(this.agentCtxFor("style-governor", bookId));
        this.logStage(stageLanguage, { zh: "读者评审 + 风格审计", en: "reader critic + style audit" });
        const [readerScores, styleScores] = await Promise.all([
          readerCritic.assess({
            chapterContent: finalContent,
            chapterNumber,
            chapterMemo: reducedControlInput?.chapterMemo,
            language: pipelineLang === "en" ? "en" : "zh",
          }).catch((err) => {
            this.logWarn(pipelineLang, {
              zh: `读者评审失败,跳过(不影响落库)：${err instanceof Error ? err.message : String(err)}`,
              en: `reader-critic failed, skipping: ${err instanceof Error ? err.message : String(err)}`,
            });
            return null;
          }),
          styleGovernor.assess({
            chapterContent: finalContent,
            chapterNumber,
            language: pipelineLang === "en" ? "en" : "zh",
          }).catch((err) => {
            this.logWarn(pipelineLang, {
              zh: `风格审计失败,跳过(不影响落库)：${err instanceof Error ? err.message : String(err)}`,
              en: `style-governor failed, skipping: ${err instanceof Error ? err.message : String(err)}`,
            });
            return null;
          }),
        ]);
        if (readerScores) {
          totalUsage = PipelineRunner.addUsage(totalUsage, readerScores.tokenUsage);
          // pain points 作为 warning 加进 issues(不阻塞,user 可见参考)
          for (const p of readerScores.painPoints) {
            auditResult = {
              ...auditResult,
              issues: [...auditResult.issues, {
                severity: "warning",
                category: "reader-critic",
                description: `[读者] ${p}`,
                suggestion: `读者评分:沉浸 ${readerScores.immersion.score} / 期待 ${readerScores.anticipation.score} / 动机 ${readerScores.motivation.score} / 共鸣 ${readerScores.emotional.score} = ${readerScores.overall}`,
              }],
            };
          }
          this.logInfo(pipelineLang, {
            zh: `读者评审:综合 ${readerScores.overall}/10 · ${readerScores.verdict === "pass" ? "合格" : "建议复修"}${readerScores.readerVoice ? " · 「" + readerScores.readerVoice + "」" : ""}`,
            en: `reader-critic: overall ${readerScores.overall}/10 · ${readerScores.verdict}${readerScores.readerVoice ? " · \"" + readerScores.readerVoice + "\"" : ""}`,
          });
        }
        if (styleScores) {
          totalUsage = PipelineRunner.addUsage(totalUsage, styleScores.tokenUsage);
          for (const w of styleScores.driftWarnings) {
            auditResult = {
              ...auditResult,
              issues: [...auditResult.issues, {
                severity: "warning",
                category: "style-drift",
                description: `[风格漂移] ${w}`,
                suggestion: `风格评分:声音 ${styleScores.voiceMatch.score} / 语气 ${styleScores.toneDrift.score} / 用词 ${styleScores.diction.score} / 节奏 ${styleScores.cadence.score} = ${styleScores.overall}`,
              }],
            };
          }
          this.logInfo(pipelineLang, {
            zh: `风格审计:综合 ${styleScores.overall}/10 · 漂移点 ${styleScores.driftWarnings.length} 条`,
            en: `style-governor: overall ${styleScores.overall}/10 · drift points ${styleScores.driftWarnings.length}`,
          });
        }
      } catch (error) {
        this.logWarn(pipelineLang, {
          zh: `读者/风格评分模块加载失败:${error instanceof Error ? error.message : String(error)}`,
          en: `extra reviewers module failed to load: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    await saveRecoverableChapterDraft({
      bookDir,
      chapterNumber,
      title: output.title,
      content: finalContent,
      stage: "candidate",
      language: pipelineLang,
      wordCount: finalWordCount,
    }).catch((error) => {
      this.config.logger?.warn(`[recovery] failed to save candidate draft for chapter ${chapterNumber}: ${error instanceof Error ? error.message : String(error)}`);
    });

    // 3c. Lightweight per-chapter promotion pass — check if any hooks should
    // be promoted based on advanced_count derived from chapter_summaries.
    // Runs BEFORE persistence so the reviewer of the NEXT chapter sees the
    // updated ledger. No LLM calls — pure ledger parse + threshold check.
    {
      const { rerunPromotionPass } = await import("../utils/hook-promotion.js");
      const { parsePendingHooksMarkdown, renderHookSnapshot } = await import("../utils/story-markdown.js");
      const promotionStoryDir = join(bookDir, "story");
      const ledgerPath = join(promotionStoryDir, "pending_hooks.md");
      const ledgerRaw = await readFile(ledgerPath, "utf-8").catch(() => "");
      if (ledgerRaw.trim()) {
        const hooks = parsePendingHooksMarkdown(ledgerRaw);
        if (hooks.length > 0) {
          const summariesRaw = await readFile(join(promotionStoryDir, "chapter_summaries.md"), "utf-8").catch(() => "");
          const promotionResult = rerunPromotionPass(hooks, summariesRaw);
          if (promotionResult.updated) {
            const ledgerLang: "zh" | "en" = /[\u4e00-\u9fff]/.test(ledgerRaw) ? "zh" : "en";
            await writeFile(ledgerPath, renderHookSnapshot([...promotionResult.hooks], ledgerLang), "utf-8");
            this.config.logger?.info(`[promotion] ${promotionResult.flippedCount} hook(s) promoted after chapter ${chapterNumber}`);
          }
        }
      }
    }

    // 4. Save the final chapter and truth files from a single persistence source
    this.logStage(stageLanguage, { zh: "落盘最终章节", en: "persisting final chapter" });
    this.logStage(stageLanguage, { zh: "生成最终真相文件", en: "rebuilding final truth files" });
    const chapterIndexBeforePersist = await this.state.loadChapterIndex(bookId);
    const { resolveDuplicateTitle } = await import("../agents/post-write-validator.js");
    const initialTitleResolution = resolveDuplicateTitle(
      output.title,
      chapterIndexBeforePersist.map((chapter) => chapter.title),
      pipelineLang,
      { content: finalContent },
    );
    let persistenceOutput = await this.buildPersistenceOutput(
      bookId,
      book,
      bookDir,
      chapterNumber,
      initialTitleResolution.title === output.title
        ? output
        : { ...output, title: initialTitleResolution.title },
      finalContent,
      lengthSpec.countingMode,
      reducedControlInput,
    );
    const finalTitleResolution = resolveDuplicateTitle(
      persistenceOutput.title,
      chapterIndexBeforePersist.map((chapter) => chapter.title),
      pipelineLang,
      { content: finalContent },
    );
    if (finalTitleResolution.title !== persistenceOutput.title) {
      persistenceOutput = {
        ...persistenceOutput,
        title: finalTitleResolution.title,
      };
    }
    if (persistenceOutput.title !== output.title) {
      const description = pipelineLang === "en"
        ? `Chapter title "${output.title}" was auto-adjusted to "${persistenceOutput.title}".`
        : `章节标题"${output.title}"已自动调整为"${persistenceOutput.title}"。`;
      this.config.logger?.warn(`[title] ${description}`);
      auditResult = {
        ...auditResult,
        issues: [...auditResult.issues, {
          severity: "warning",
          category: "title-dedup",
          description,
          suggestion: pipelineLang === "en"
            ? "If the auto-renamed title is weak, revise the chapter title manually."
            : "如果自动改名不理想，可以在后续手动修订章节标题。",
        }],
      };
    }
    // ─ 写后并行化(B1#2):longSpanFatigue 跟 6 个真相文件读没有数据依赖,
    //   两个 Promise.all 合一,省掉 longSpanFatigue 的串行等待(~100-500ms / 章)。
    //   注意:validator 仍依赖二者结果,所以这里只是把"先 fatigue 再 reads"改成"两边并行"。
    this.logStage(stageLanguage, { zh: "校验真相文件变更", en: "validating truth file updates" });
    const storyDir = join(bookDir, "story");
    const [longSpanFatigue, [oldState, oldHooks, oldLedger, authorityStoryFrame, authorityBookRules, authorityChapterSummaries]] = await Promise.all([
      analyzeLongSpanFatigue({
        bookDir,
        chapterNumber,
        chapterContent: finalContent,
        chapterSummary: persistenceOutput.chapterSummary,
        language: pipelineLang,
      }),
      Promise.all([
        readFile(join(storyDir, "current_state.md"), "utf-8").catch(() => ""),
        readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
        readFile(join(storyDir, "particle_ledger.md"), "utf-8").catch(() => ""),
        readStoryFrame(bookDir).catch(() => ""),
        readFile(join(storyDir, "book_rules.md"), "utf-8").catch(() => ""),
        readFile(join(storyDir, "chapter_summaries.md"), "utf-8").catch(() => ""),
      ]),
    ]);
    auditResult = {
      ...auditResult,
      issues: [
        ...auditResult.issues,
        ...longSpanFatigue.issues,
        ...(persistenceOutput.hookHealthIssues ?? []),
      ],
    };
    finalWordCount = persistenceOutput.wordCount;
    const lengthWarnings = buildLengthWarnings(
      chapterNumber,
      finalWordCount,
      lengthSpec,
    );
    const lengthTelemetry = buildLengthTelemetry({
      lengthSpec,
      writerCount,
      postWriterNormalizeCount: reviewResult.preAuditNormalizedWordCount,
      postReviseCount,
      finalCount: finalWordCount,
      normalizeApplied,
      lengthWarning: lengthWarnings.length > 0,
    });
    this.logLengthWarnings(lengthWarnings);
    const validator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
    const truthValidation = await validateChapterTruthPersistence({
      writer,
      validator,
      book,
      bookDir,
      chapterNumber,
      title: persistenceOutput.title,
      content: finalContent,
      persistenceOutput,
      auditResult,
      previousTruth: {
        oldState,
        oldHooks,
        oldLedger,
      },
      authorityContext: {
        storyFrame: authorityStoryFrame,
        bookRules: authorityBookRules,
        chapterSummaries: authorityChapterSummaries,
      },
      reducedControlInput,
      language: pipelineLang,
      logWarn: (message) => this.logWarn(pipelineLang, message),
      logger: this.config.logger,
    });
    let chapterStatus: ChapterPipelineResult["status"] | null = truthValidation.chapterStatus;
    let degradedIssues: ReadonlyArray<AuditIssue> = truthValidation.degradedIssues;
    persistenceOutput = truthValidation.persistenceOutput;
    auditResult = truthValidation.auditResult;

    // 4.2 Final paragraph shape check on persisted content (post-normalize, post-revise)
    {
      const {
        detectParagraphLengthDrift,
        detectParagraphShapeWarnings,
      } = await import("../agents/post-write-validator.js");
      const chapDir = join(bookDir, "chapters");
      const recentFiles = (await readdir(chapDir).catch(() => [] as string[]))
        .filter((f) => f.endsWith(".md") && /^\d{4}/.test(f))
        .sort()
        .slice(-5);
      const recentContent = (await Promise.all(
        recentFiles.map((f) => readFile(join(chapDir, f), "utf-8").catch(() => "")),
      )).join("\n\n");
      const paragraphIssues = [
        ...detectParagraphShapeWarnings(finalContent, pipelineLang),
        ...detectParagraphLengthDrift(finalContent, recentContent, pipelineLang),
      ];
      if (paragraphIssues.length > 0) {
        for (const issue of paragraphIssues) {
          this.config.logger?.warn(`[paragraph] ${issue.description}`);
        }
        auditResult = {
          ...auditResult,
          issues: [...auditResult.issues, ...paragraphIssues.map((v) => ({
            severity: v.severity as "warning",
            category: "paragraph-shape",
            description: v.description,
            suggestion: v.suggestion,
          }))],
        };
      }
    }

    const resolvedStatus = chapterStatus ?? (auditResult.passed ? "ready-for-review" : "audit-failed");
    await persistChapterArtifacts({
      chapterNumber,
      chapterTitle: persistenceOutput.title,
      status: resolvedStatus,
      auditResult,
      finalWordCount,
      lengthWarnings,
      lengthTelemetry,
      degradedIssues,
      tokenUsage: totalUsage,
      loadChapterIndex: () => this.state.loadChapterIndex(bookId),
      saveChapter: () => writer.saveChapter(bookDir, persistenceOutput, gp.numericalSystem, pipelineLang),
      saveTruthFiles: async () => {
        await writer.saveNewTruthFiles(bookDir, persistenceOutput, pipelineLang);
        await this.syncLegacyStructuredStateFromMarkdown(bookDir, chapterNumber, persistenceOutput);
        this.logStage(stageLanguage, { zh: "同步记忆索引", en: "syncing memory indexes" });
        await this.syncNarrativeMemoryIndex(bookId);
        await this.syncStoryGraphIndex(bookId, chapterNumber);
      },
      saveChapterIndex: (index) => this.state.saveChapterIndex(bookId, index),
      markBookActiveIfNeeded: () => this.markBookActiveIfNeeded(bookId),
      persistAuditDriftGuidance: (issues) => this.persistAuditDriftGuidance({
        bookDir,
        chapterNumber,
        issues,
        language: stageLanguage,
      }).catch(() => undefined),
      snapshotState: () => this.state.snapshotState(bookId, chapterNumber),
      syncCurrentStateFactHistory: () => this.syncCurrentStateFactHistory(bookId, chapterNumber),
      logSnapshotStage: () =>
        this.logStage(stageLanguage, { zh: "更新章节索引与快照", en: "updating chapter index and snapshots" }),
    });

    // 6. Send notification
    if (this.config.notifyChannels && this.config.notifyChannels.length > 0) {
      const statusEmoji = resolvedStatus === "state-degraded"
        ? "🧯"
        : auditResult.passed ? "✅" : "⚠️";
      const chapterLength = formatLengthCount(finalWordCount, lengthSpec.countingMode);
      await dispatchNotification(this.config.notifyChannels, {
        title: `${statusEmoji} ${book.title} 第${chapterNumber}章`,
        body: [
          `**${persistenceOutput.title}** | ${chapterLength}`,
          revised ? "📝 已自动修正" : "",
          resolvedStatus === "state-degraded"
            ? "状态结算: 已降级保存，需先修复 state 再继续"
            : `审稿: ${auditResult.passed ? "通过" : "需人工审核"}`,
          ...auditResult.issues
            .filter((i) => i.severity !== "info")
            .map((i) => `- [${i.severity}] ${i.description}`),
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }

    await this.emitWebhook("pipeline-complete", bookId, chapterNumber, {
      title: persistenceOutput.title,
      wordCount: finalWordCount,
      passed: auditResult.passed,
      revised,
      status: resolvedStatus,
    });

    return {
      chapterNumber,
      title: persistenceOutput.title,
      wordCount: finalWordCount,
      auditResult,
      revised,
      status: resolvedStatus,
      lengthWarnings,
      lengthTelemetry,
      tokenUsage: totalUsage,
    };
  }

  private async _repairChapterStateLocked(bookId: string, chapterNumber?: number): Promise<ChapterPipelineResult> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    const index = [...(await this.state.loadChapterIndex(bookId))];
    if (index.length === 0) {
      throw new Error(`Book "${bookId}" has no persisted chapters to repair.`);
    }

    const targetChapter = chapterNumber ?? index[index.length - 1]!.number;
    const targetIndex = index.findIndex((chapter) => chapter.number === targetChapter);
    if (targetIndex < 0) {
      throw new Error(`Chapter ${targetChapter} not found in "${bookId}".`);
    }
    const targetMeta = index[targetIndex]!;
    const latestChapter = Math.max(...index.map((chapter) => chapter.number));
    if (targetMeta.status !== "state-degraded") {
      throw new Error(`Chapter ${targetChapter} is not state-degraded.`);
    }
    if (targetChapter !== latestChapter) {
      throw new Error(`Only the latest state-degraded chapter can be repaired safely (latest is ${latestChapter}).`);
    }

    this.logStage(stageLanguage, { zh: "修复章节状态结算", en: "repairing chapter state settlement" });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const pipelineLang = book.language ?? gp.language;
    const content = await this.readChapterContent(bookDir, targetChapter);
    const storyDir = join(bookDir, "story");
    const [oldState, oldHooks] = await Promise.all([
      readFile(join(storyDir, "current_state.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
    ]);

    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    let repairedOutput = await writer.settleChapterState({
      book,
      bookDir,
      chapterNumber: targetChapter,
      title: targetMeta.title,
      content,
      allowReapply: true,
    });
    const validator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
    let validation = await validator.validate(
      content,
      targetChapter,
      oldState,
      repairedOutput.updatedState,
      oldHooks,
      repairedOutput.updatedHooks,
      pipelineLang,
    );

    if (!validation.passed) {
      const recovery = await retrySettlementAfterValidationFailure({
        writer,
        validator,
        book,
        bookDir,
        chapterNumber: targetChapter,
        title: targetMeta.title,
        content,
        oldState,
        oldHooks,
        originalValidation: validation,
        language: pipelineLang,
        logWarn: (message) => this.logWarn(pipelineLang, message),
        logger: this.config.logger,
      });
      if (recovery.kind !== "recovered") {
        throw new Error(
          recovery.issues[0]?.description
            ?? `State repair still failed for chapter ${targetChapter}.`,
        );
      }
      repairedOutput = recovery.output;
      validation = recovery.validation;
    }

    if (!validation.passed) {
      throw new Error(`State repair still failed for chapter ${targetChapter}.`);
    }

    await writer.saveChapter(bookDir, repairedOutput, gp.numericalSystem, pipelineLang);
    await writer.saveNewTruthFiles(bookDir, repairedOutput, pipelineLang);
    await this.syncLegacyStructuredStateFromMarkdown(bookDir, targetChapter, repairedOutput);
    await this.syncNarrativeMemoryIndex(bookId);
    await this.syncStoryGraphIndex(bookId, targetChapter);
    await this.state.snapshotState(bookId, targetChapter);
    await this.syncCurrentStateFactHistory(bookId, targetChapter);

    const baseStatus = resolveStateDegradedBaseStatus(targetMeta);
    const degradedMetadata = parseStateDegradedReviewNote(targetMeta.reviewNote);
    const injectedIssues = new Set(degradedMetadata?.injectedIssues ?? []);
    index[targetIndex] = {
      ...targetMeta,
      status: baseStatus,
      updatedAt: new Date().toISOString(),
      auditIssues: targetMeta.auditIssues.filter((issue) => !injectedIssues.has(issue)),
      reviewNote: undefined,
    };
    await this.state.saveChapterIndex(bookId, index);

    const repairedPassesAudit = baseStatus !== "audit-failed";
    return {
      chapterNumber: targetChapter,
      title: targetMeta.title,
      wordCount: targetMeta.wordCount,
      auditResult: {
        passed: repairedPassesAudit,
        issues: [],
        summary: repairedPassesAudit ? "state repaired" : "state repaired but chapter still needs review",
      },
      revised: false,
      status: baseStatus,
      lengthWarnings: targetMeta.lengthWarnings,
      lengthTelemetry: targetMeta.lengthTelemetry,
      tokenUsage: targetMeta.tokenUsage,
    };
  }

  private async _resyncChapterArtifactsLocked(bookId: string, chapterNumber?: number): Promise<ChapterPipelineResult> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    const index = [...(await this.state.loadChapterIndex(bookId))];
    if (index.length === 0) {
      throw new Error(`Book "${bookId}" has no persisted chapters to sync.`);
    }

    const targetChapter = chapterNumber ?? index[index.length - 1]!.number;
    const targetIndex = index.findIndex((chapter) => chapter.number === targetChapter);
    if (targetIndex < 0) {
      throw new Error(`Chapter ${targetChapter} not found in "${bookId}".`);
    }

    const targetMeta = index[targetIndex]!;
    const latestChapter = Math.max(...index.map((chapter) => chapter.number));
    if (targetChapter !== latestChapter) {
      throw new Error(`Only the latest persisted chapter can be synced safely (latest is ${latestChapter}).`);
    }

    this.logStage(stageLanguage, { zh: "根据已编辑正文同步真相文件与索引", en: "syncing truth files and indexes from edited chapter body" });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const pipelineLang = book.language ?? gp.language;
    const content = await this.readChapterContent(bookDir, targetChapter);
    const storyDir = join(bookDir, "story");
    const [oldState, oldHooks] = await Promise.all([
      readFile(join(storyDir, "current_state.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
    ]);

    const reducedControlInput = (this.config.inputGovernanceMode ?? "v2") === "legacy"
      ? undefined
      : await this.createGovernedArtifacts(
        book,
        bookDir,
        targetChapter,
        this.config.externalContext,
        { reuseExistingIntentWhenContextMissing: true },
      );

    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    let syncedOutput = await writer.settleChapterState({
      book,
      bookDir,
      chapterNumber: targetChapter,
      title: targetMeta.title,
      content,
      chapterIntent: reducedControlInput?.plan.intentMarkdown,
      contextPackage: reducedControlInput?.composed.contextPackage,
      ruleStack: reducedControlInput?.composed.ruleStack,
      allowReapply: true,
    });
    const validator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
    let validation = await validator.validate(
      content,
      targetChapter,
      oldState,
      syncedOutput.updatedState,
      oldHooks,
      syncedOutput.updatedHooks,
      pipelineLang,
    );

    if (!validation.passed) {
      const recovery = await retrySettlementAfterValidationFailure({
        writer,
        validator,
        book,
        bookDir,
        chapterNumber: targetChapter,
        title: targetMeta.title,
        content,
        reducedControlInput: reducedControlInput
          ? {
              chapterIntent: reducedControlInput.plan.intentMarkdown,
              contextPackage: reducedControlInput.composed.contextPackage,
              ruleStack: reducedControlInput.composed.ruleStack,
            }
          : undefined,
        oldState,
        oldHooks,
        originalValidation: validation,
        language: pipelineLang,
        logWarn: (message) => this.logWarn(pipelineLang, message),
        logger: this.config.logger,
      });
      if (recovery.kind !== "recovered") {
        throw new Error(
          recovery.issues[0]?.description
            ?? `Chapter sync still failed for chapter ${targetChapter}.`,
        );
      }
      syncedOutput = recovery.output;
      validation = recovery.validation;
    }

    if (!validation.passed) {
      throw new Error(`Chapter sync still failed for chapter ${targetChapter}.`);
    }

    await writer.saveChapter(bookDir, syncedOutput, gp.numericalSystem, pipelineLang);
    await writer.saveNewTruthFiles(bookDir, syncedOutput, pipelineLang);
    await this.syncLegacyStructuredStateFromMarkdown(bookDir, targetChapter, syncedOutput);
    await this.syncNarrativeMemoryIndex(bookId);
    await this.state.snapshotState(bookId, targetChapter);
    await this.syncCurrentStateFactHistory(bookId, targetChapter);

    const finalStatus: "ready-for-review" | "audit-failed" = targetMeta.status === "state-degraded"
      ? resolveStateDegradedBaseStatus(targetMeta)
      : "ready-for-review";

    if (targetMeta.status === "state-degraded") {
      const degradedMetadata = parseStateDegradedReviewNote(targetMeta.reviewNote);
      const injectedIssues = new Set(degradedMetadata?.injectedIssues ?? []);
      index[targetIndex] = {
        ...targetMeta,
        status: finalStatus,
        updatedAt: new Date().toISOString(),
        auditIssues: targetMeta.auditIssues.filter((issue) => !injectedIssues.has(issue)),
        reviewNote: undefined,
      };
    } else {
      index[targetIndex] = {
        ...targetMeta,
        status: "ready-for-review",
        updatedAt: new Date().toISOString(),
      };
    }
    await this.state.saveChapterIndex(bookId, index);
    return {
      chapterNumber: targetChapter,
      title: targetMeta.title,
      wordCount: targetMeta.wordCount,
      auditResult: {
        passed: finalStatus !== "audit-failed",
        issues: [],
        summary: finalStatus === "audit-failed"
          ? "chapter truth/state resynced from edited body, but chapter still needs audit fixes"
          : "chapter truth/state resynced from edited body",
      },
      revised: false,
      status: finalStatus,
      lengthWarnings: targetMeta.lengthWarnings,
      lengthTelemetry: targetMeta.lengthTelemetry,
      tokenUsage: targetMeta.tokenUsage,
    };
  }

  // ---------------------------------------------------------------------------
  // Import operations (style imitation + canon for spinoff)
  // ---------------------------------------------------------------------------

  /**
   * Generate a qualitative style guide from reference text via LLM.
   * Also saves the statistical style_profile.json.
   */
  async generateStyleGuide(bookId: string, referenceText: string, sourceName?: string): Promise<string> {
    const sample = referenceText.trim();
    if (!sample) {
      throw new Error("Reference text is required for style extraction.");
    }

    const { analyzeStyle } = await import("../agents/style-analyzer.js");
    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    // Statistical fingerprint
    const profile = analyzeStyle(sample, sourceName);
    await writeFile(join(storyDir, "style_profile.json"), JSON.stringify(profile, null, 2), "utf-8");

    const book = await this.state.loadBookConfig(bookId);
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const lang = (book.language ?? gp.language) === "en" ? "en" as const : "zh" as const;

    let qualitativeGuide: string;
    if (sample.length < 500) {
      qualitativeGuide = this.buildDeterministicStyleGuide(profile, {
        language: lang,
        reason: lang === "en"
          ? `The sample is short (${sample.length} chars), so this guide uses the statistical fingerprint instead of LLM qualitative extraction.`
          : `样本文本较短（${sample.length}字），本次先使用统计指纹生成文风指南，不强行调用 LLM 做定性拆解。`,
      });
    } else {
      try {
        // LLM qualitative extraction
        const response = await chatCompletion(this.config.client, this.config.model, [
          {
            role: "system",
            content: `你是一位文学风格分析专家。分析参考文本的写作风格，提取可供模仿的定性特征。

输出格式（Markdown）：
## 叙事声音与语气
（冷峻/热烈/讽刺/温情/...，附1-2个原文例句）

## 对话风格
（角色说话的共性特征：句子长短、口头禅倾向、方言痕迹、对话节奏）

## 场景描写特征
（五感偏好、意象选择、描写密度、环境与情绪的关联方式）

## 转折与衔接手法
（场景如何切换、时间跳跃的处理方式、段落间的过渡特征）

## 节奏特征
（长短句分布、段落长度偏好、高潮/舒缓的交替方式）

## 词汇偏好
（高频特色用词、比喻/修辞倾向、口语化程度）

## 情绪表达方式
（直白抒情 vs 动作外化、内心独白的频率和风格）

## 独特习惯
（任何值得模仿的个人写作习惯）

分析必须基于原文实际特征，不要泛泛而谈。每个部分用1-2个原文例句佐证。`,
          },
          {
            role: "user",
            content: `分析以下参考文本的写作风格：\n\n${sample.slice(0, 20000)}`,
          },
        ], { temperature: 0.3 });
        qualitativeGuide = response.content.trim()
          ? response.content
          : this.buildDeterministicStyleGuide(profile, {
              language: lang,
              reason: lang === "en"
                ? "The LLM returned empty style analysis; using the statistical fingerprint fallback."
                : "LLM 未返回有效文风分析，本次使用统计指纹兜底生成文风指南。",
            });
      } catch (error) {
        qualitativeGuide = this.buildDeterministicStyleGuide(profile, {
          language: lang,
          reason: lang === "en"
            ? `LLM qualitative extraction failed: ${error instanceof Error ? error.message : String(error)}. Using the statistical fingerprint fallback.`
            : `LLM 定性拆解失败：${error instanceof Error ? error.message : String(error)}。本次使用统计指纹兜底生成文风指南。`,
        });
      }
    }

    const craftMethodology = buildWritingMethodologySection(lang);
    const fullStyleGuide = `${qualitativeGuide}\n\n${craftMethodology}`;
    await writeFile(join(storyDir, "style_guide.md"), fullStyleGuide, "utf-8");
    return fullStyleGuide;
  }

  private buildDeterministicStyleGuide(
    profile: {
      readonly avgSentenceLength: number;
      readonly sentenceLengthStdDev: number;
      readonly avgParagraphLength: number;
      readonly vocabularyDiversity: number;
      readonly topPatterns: ReadonlyArray<string>;
      readonly rhetoricalFeatures: ReadonlyArray<string>;
      readonly sourceName?: string;
    },
    options: { readonly language: "zh" | "en"; readonly reason: string },
  ): string {
    if (options.language === "en") {
      return [
        "# Style Guide",
        "",
        `> ${options.reason}`,
        "",
        "## Statistical Fingerprint",
        `- Source: ${profile.sourceName ?? "unknown"}`,
        `- Average sentence length: ${profile.avgSentenceLength}`,
        `- Sentence length variance: ${profile.sentenceLengthStdDev}`,
        `- Average paragraph length: ${profile.avgParagraphLength}`,
        `- Vocabulary diversity: ${Math.round(profile.vocabularyDiversity * 100)}%`,
        profile.topPatterns.length > 0 ? `- Repeated openings: ${profile.topPatterns.join(", ")}` : "- Repeated openings: none obvious in this sample",
        profile.rhetoricalFeatures.length > 0 ? `- Rhetorical features: ${profile.rhetoricalFeatures.join(", ")}` : "- Rhetorical features: none obvious in this sample",
        "",
        "## How To Use",
        "- Treat this as a lightweight style fingerprint, not a full imitation bible.",
        "- Keep sentence and paragraph rhythm close to the sample when drafting.",
        "- If this guide feels too thin, import a longer excerpt later; the file will be replaced.",
      ].join("\n");
    }

    return [
      "# 文风指南",
      "",
      `> ${options.reason}`,
      "",
      "## 统计风格指纹",
      `- 来源：${profile.sourceName ?? "unknown"}`,
      `- 平均句长：${profile.avgSentenceLength}`,
      `- 句长波动：${profile.sentenceLengthStdDev}`,
      `- 平均段落长度：${profile.avgParagraphLength}`,
      `- 词汇多样性：${Math.round(profile.vocabularyDiversity * 100)}%`,
      profile.topPatterns.length > 0 ? `- 高频句首/模式：${profile.topPatterns.join("、")}` : "- 高频句首/模式：样本内不明显",
      profile.rhetoricalFeatures.length > 0 ? `- 修辞特征：${profile.rhetoricalFeatures.join("、")}` : "- 修辞特征：样本内不明显",
      "",
      "## 使用方式",
      "- 这是一份轻量文风指纹，不是完整仿写圣经。",
      "- 后续写作优先参考句长、段落长度、节奏波动和可见修辞。",
      "- 如果想得到更稳定的定性拆解，后续可以导入更长片段覆盖本文件。",
    ].join("\n");
  }

  private buildInitialBookStyleGuide(
    book: BookConfig,
    gp: GenreProfile,
    foundation: ArchitectOutput,
    language: "zh" | "en",
  ): string {
    const storyFrame = this.compactStyleAnchor(foundation.storyFrame ?? foundation.storyBible);
    const volumeMap = this.compactStyleAnchor(foundation.volumeMap ?? foundation.volumeOutline);
    const roleAnchors = (foundation.roles ?? [])
      .slice(0, 4)
      .map((role) => {
        const name = role.name.trim();
        const body = this.compactStyleAnchor(role.content, 160);
        return name ? `${name}: ${body}` : body;
      })
      .filter(Boolean);
    const methodology = buildWritingMethodologySection(language);

    if (language === "en") {
      return [
        "# Initial Style Guide",
        "",
        `> Created during book initialization from this book's foundation files. Replace with an imported sample guide if the author supplies reference prose later.`,
        "",
        "## Book Voice Anchor",
        `- Title: ${book.title}`,
        `- Platform: ${book.platform}`,
        `- Genre: ${gp.name} (${book.genre})`,
        `- Chapter target: ${book.chapterWordCount} words`,
        "",
        "## Narrative Voice",
        storyFrame || "Keep the prose grounded in the approved story_frame; do not invent a generic voice detached from the book premise.",
        "",
        "## Rhythm And Chapter Texture",
        volumeMap || "Use the approved volume_map as the pacing source of truth; every chapter should advance a visible volume objective.",
        "",
        "## Character Texture",
        roleAnchors.length ? roleAnchors.map((item) => `- ${item}`).join("\n") : "- Use roles/ as the source of voice, desire, wound, behavior limits, and current state.",
        "",
        "## Agent Usage Rules",
        "- Writer follows this guide before drafting; Editor flags drift; Polisher may tune sentences but cannot change plot facts.",
        "- Avoid repeated chapter openings, repeated closing beats, and interchangeable scene temperature across consecutive chapters.",
        "- When this guide conflicts with roles/, pending_hooks, or current_state, the truth files win and the guide must be revised.",
        "",
        methodology,
      ].join("\n");
    }

    return [
      "# 初始文风指南",
      "",
      "> 建书时由本书基础设定自动生成。后续如果导入作者样本，可用样本文风指南覆盖本文件。",
      "",
      "## 本书文风锚点",
      `- 书名：${book.title}`,
      `- 平台：${book.platform}`,
      `- 题材：${gp.name}（${book.genre}）`,
      `- 单章目标：${book.chapterWordCount} 字`,
      "",
      "## 叙事声音",
      storyFrame || "以已通过复审的 story_frame 为声音来源；禁止脱离本书命题套用泛化网文腔。",
      "",
      "## 节奏与章节质感",
      volumeMap || "以已通过复审的 volume_map 为节奏来源；每章必须推进可见的卷级目标。",
      "",
      "## 角色质地",
      roleAnchors.length ? roleAnchors.map((item) => `- ${item}`).join("\n") : "- 以 roles/ 为人物声音、欲望、伤口、行为边界和当前状态的唯一来源。",
      "",
      "## Agent 使用规则",
      "- 写手起草前必须读本文件；审稿官负责标记漂移；润色师只调语言，不改事实和情节。",
      "- 连续章节禁止重复开头姿势、重复结尾动作、重复场景温度，避免读感同构。",
      "- 本指南若与 roles/、pending_hooks、current_state 冲突，以 truth files 为准，并由提示词治理官推动修订。",
      "",
      methodology,
    ].join("\n");
  }

  private compactStyleAnchor(value: string | undefined, maxLength = 260): string {
    const compact = (value ?? "").replace(/\s+/g, " ").trim();
    if (compact.length <= maxLength) return compact;
    return `${compact.slice(0, maxLength).trimEnd()}...`;
  }

  /**
   * Import canon from parent book for spinoff writing.
   * Reads parent's truth files, uses LLM to generate parent_canon.md in target book.
   */
  async importCanon(targetBookId: string, parentBookId: string): Promise<string> {
    // Validate both books exist
    const bookIds = await this.state.listBooks();
    if (!bookIds.includes(parentBookId)) {
      throw new Error(`Parent book "${parentBookId}" not found. Available: ${bookIds.join(", ") || "(none)"}`);
    }
    if (!bookIds.includes(targetBookId)) {
      throw new Error(`Target book "${targetBookId}" not found. Available: ${bookIds.join(", ") || "(none)"}`);
    }

    const parentDir = this.state.bookDir(parentBookId);
    const targetDir = this.state.bookDir(targetBookId);
    const storyDir = join(targetDir, "story");
    await mkdir(storyDir, { recursive: true });

    const readSafe = async (path: string): Promise<string> => {
      try { return await readFile(path, "utf-8"); } catch { return "(无)"; }
    };

    const parentBook = await this.state.loadBookConfig(parentBookId);

    // Phase 5: parent book may be on the new prose layout; prefer outline/.
    const readParentOutline = async (newRel: string, legacyRel: string): Promise<string> => {
      const preferred = await readSafe(join(parentDir, "story", newRel));
      if (preferred.trim() && preferred !== "(无)") return preferred;
      return readSafe(join(parentDir, "story", legacyRel));
    };

    const [storyBible, currentState, ledger, hooks, summaries, subplots, emotions, matrix] =
      await Promise.all([
        readParentOutline("outline/story_frame.md", "story_bible.md"),
        readSafe(join(parentDir, "story/current_state.md")),
        readSafe(join(parentDir, "story/particle_ledger.md")),
        readSafe(join(parentDir, "story/pending_hooks.md")),
        readSafe(join(parentDir, "story/chapter_summaries.md")),
        readSafe(join(parentDir, "story/subplot_board.md")),
        readSafe(join(parentDir, "story/emotional_arcs.md")),
        readSafe(join(parentDir, "story/character_matrix.md")),
      ]);

    const response = await chatCompletion(this.config.client, this.config.model, [
      {
        role: "system",
        content: `你是一位网络小说架构师。基于正传的全部设定和状态文件，生成一份完整的"正传正典参照"文档，供番外写作和审计使用。

输出格式（Markdown）：
# 正传正典（《{正传书名}》）

## 世界规则（完整，来自正传设定）
（力量体系、地理设定、阵营关系、核心规则——完整复制，不压缩）

## 正典约束（不可违反的事实）
| 约束ID | 类型 | 约束内容 | 严重性 |
|---|---|---|---|
| C01 | 人物存亡 | ... | critical |
（列出所有硬性约束：谁活着、谁死了、什么事件已经发生、什么规则不可违反）

## 角色快照
| 角色 | 当前状态 | 性格底色 | 对话特征 | 已知信息 | 未知信息 |
|---|---|---|---|---|---|
（从状态卡和角色矩阵中提取每个重要角色的完整快照）

## 角色双态处理原则
- 未来会变强的角色：写潜力暗示
- 未来会黑化的角色：写微小裂痕
- 未来会死的角色：写导致死亡的性格底色

## 关键事件时间线
| 章节 | 事件 | 涉及角色 | 对番外的约束 |
|---|---|---|---|
（从章节摘要中提取关键事件）

## 伏笔状态
| Hook ID | 类型 | 状态 | 内容 | 预期回收 |
|---|---|---|---|---|

## 资源账本快照
（当前资源状态）

---
meta:
  parentBookId: "{parentBookId}"
  parentTitle: "{正传书名}"
  generatedAt: "{ISO timestamp}"

要求：
1. 世界规则完整复制，不压缩——准确性优先
2. 正典约束必须穷尽，遗漏会导致番外与正传矛盾
3. 角色快照必须包含信息边界（已知/未知），防止番外中角色引用不该知道的信息`,
      },
      {
        role: "user",
        content: `正传书名：${parentBook.title}
正传ID：${parentBookId}

## 正传世界设定
${storyBible}

## 正传当前状态卡
${currentState}

## 正传资源账本
${ledger}

## 正传伏笔池
${hooks}

## 正传章节摘要
${summaries}

## 正传支线进度
${subplots}

## 正传情感弧线
${emotions}

## 正传角色矩阵
${matrix}`,
      },
    ], { temperature: 0.3 });

    // Append deterministic meta block (LLM may hallucinate timestamps)
    const metaBlock = [
      "",
      "---",
      "meta:",
      `  parentBookId: "${parentBookId}"`,
      `  parentTitle: "${parentBook.title}"`,
      `  generatedAt: "${new Date().toISOString()}"`,
    ].join("\n");
    const canon = response.content + metaBlock;

    await writeFile(join(storyDir, "parent_canon.md"), canon, "utf-8");

    // Also generate style guide from parent's chapter text if available
    const parentChaptersDir = join(parentDir, "chapters");
    const parentChapterText = await this.readParentChapterSample(parentChaptersDir);
    if (parentChapterText.length >= 500) {
      await this.tryGenerateStyleGuide(targetBookId, parentChapterText, parentBook.title);
    }

    return canon;
  }

  private async readParentChapterSample(chaptersDir: string): Promise<string> {
    try {
      const entries = await readdir(chaptersDir);
      const mdFiles = entries
        .filter((file) => file.endsWith(".md"))
        .sort()
        .slice(0, 5);
      const chunks: string[] = [];
      let totalLength = 0;
      for (const file of mdFiles) {
        if (totalLength >= 20000) break;
        const content = await readFile(join(chaptersDir, file), "utf-8");
        chunks.push(content);
        totalLength += content.length;
      }
      return chunks.join("\n\n---\n\n");
    } catch {
      return "";
    }
  }

  // ---------------------------------------------------------------------------
  // Chapter import (for continuation writing from existing chapters)
  // ---------------------------------------------------------------------------

  /**
   * Import existing chapters into a book. Reverse-engineers all truth files
   * via sequential replay so the Writer and Auditor can continue naturally.
   *
   * Step 1: Generate foundation (story_frame, volume_map, book_rules) from all chapters.
   * Step 2: Sequentially replay each chapter through ChapterAnalyzer to build truth files.
   */
  async importChapters(input: ImportChaptersInput): Promise<ImportChaptersResult> {
    const releaseLock = await this.state.acquireBookLock(input.bookId);
    try {
      const book = await this.state.loadBookConfig(input.bookId);
      const bookDir = this.state.bookDir(input.bookId);
      const { profile: gp } = await this.loadGenreProfile(book.genre);
      const resolvedLanguage = book.language ?? gp.language;

      const startFrom = input.resumeFrom ?? 1;

      const log = this.config.logger?.child("import");

      // Step 1: Generate foundation on first run (not on resume)
      if (startFrom === 1) {
        log?.info(this.localize(resolvedLanguage, {
          zh: `步骤 1：从 ${input.chapters.length} 章生成基础设定...`,
          en: `Step 1: Generating foundation from ${input.chapters.length} chapters...`,
        }));
        const foundationSource = buildImportFoundationSource(input.chapters, resolvedLanguage);

        const architect = new ArchitectAgent(this.agentCtxFor("architect", input.bookId));
        const isSeries = input.importMode === "series";
        const foundation = isSeries
          ? await this.generateAndReviewFoundation({
              generate: (reviewFeedback) => architect.generateFoundationFromImport(book, foundationSource, undefined, reviewFeedback, { importMode: "series" }),
              reviewer: new FoundationReviewerAgent(this.agentCtxFor("foundation-reviewer", input.bookId)),
              mode: "series",
              language: resolvedLanguage === "en" ? "en" : "zh",
              stageLanguage: resolvedLanguage,
            })
          : await architect.generateFoundationFromImport(book, foundationSource);
        await architect.writeFoundationFiles(
          bookDir,
          foundation,
          gp.numericalSystem,
          resolvedLanguage,
        );
        await this.resetImportReplayTruthFiles(bookDir, resolvedLanguage);
        await this.state.saveChapterIndex(input.bookId, []);
        await this.state.snapshotState(input.bookId, 0);

        // Generate style guide from imported chapters
        if (foundationSource.length >= 500) {
          log?.info(this.localize(resolvedLanguage, {
            zh: "提取原文风格指纹...",
            en: "Extracting source style fingerprint...",
          }));
          await this.tryGenerateStyleGuide(input.bookId, foundationSource, book.title, resolvedLanguage);
        }

        log?.info(this.localize(resolvedLanguage, {
          zh: "基础设定已生成。",
          en: "Foundation generated.",
        }));
      }

      // Step 2: Sequential replay
      log?.info(this.localize(resolvedLanguage, {
        zh: `步骤 2：从第 ${startFrom} 章开始顺序回放...`,
        en: `Step 2: Sequential replay from chapter ${startFrom}...`,
      }));
      const analyzer = new ChapterAnalyzerAgent(this.agentCtxFor("chapter-analyzer", input.bookId));
      const writer = new WriterAgent(this.agentCtxFor("writer", input.bookId));
      const countingMode = resolveLengthCountingMode(book.language ?? gp.language);
      let totalWords = 0;
      let importedCount = 0;

      for (let i = startFrom - 1; i < input.chapters.length; i++) {
        const ch = input.chapters[i]!;
        const chapterNumber = i + 1;
        const governedInput = await this.prepareWriteInput(book, bookDir, chapterNumber);

        log?.info(this.localize(resolvedLanguage, {
          zh: `分析章节 ${chapterNumber}/${input.chapters.length}：${ch.title}...`,
          en: `Analyzing chapter ${chapterNumber}/${input.chapters.length}: ${ch.title}...`,
        }));

        // Analyze chapter to get truth file updates
        const output = await analyzer.analyzeChapter({
          book,
          bookDir,
          chapterNumber,
          chapterContent: ch.content,
          chapterTitle: ch.title,
          chapterIntent: governedInput.chapterIntent,
          contextPackage: governedInput.contextPackage,
          ruleStack: governedInput.ruleStack,
        });

        // Save chapter file + core truth files (state, ledger, hooks)
        await writer.saveChapter(bookDir, {
          ...output,
          postWriteErrors: [],
          postWriteWarnings: [],
        }, gp.numericalSystem, resolvedLanguage);

        // Save extended truth files (summaries, subplots, emotional arcs, character matrix)
        await writer.saveNewTruthFiles(bookDir, {
          ...output,
          postWriteErrors: [],
          postWriteWarnings: [],
        }, resolvedLanguage);
        await this.syncLegacyStructuredStateFromMarkdown(bookDir, chapterNumber, output);
        await this.syncNarrativeMemoryIndex(input.bookId);

        // Update chapter index
        const existingIndex = await this.state.loadChapterIndex(input.bookId);
        const now = new Date().toISOString();
        const chapterWordCount = countChapterLength(ch.content, countingMode);
        const newEntry: ChapterMeta = {
          number: chapterNumber,
          title: output.title,
          status: "imported",
          wordCount: chapterWordCount,
          createdAt: now,
          updatedAt: now,
          auditIssues: [],
          lengthWarnings: [],
        };
        // Replace if exists (resume case), otherwise append
        const existingIdx = existingIndex.findIndex((e) => e.number === chapterNumber);
        const updatedIndex = existingIdx >= 0
          ? existingIndex.map((e, idx) => idx === existingIdx ? newEntry : e)
          : [...existingIndex, newEntry];
        await this.state.saveChapterIndex(input.bookId, updatedIndex);

        // Snapshot state after each chapter for rollback + resume support
        await this.state.snapshotState(input.bookId, chapterNumber);

        importedCount++;
        totalWords += chapterWordCount;
      }

      if (input.chapters.length > 0) {
        await this.markBookActiveIfNeeded(input.bookId);
        await this.syncCurrentStateFactHistory(input.bookId, input.chapters.length);
      }

      const nextChapter = input.chapters.length + 1;
      log?.info(this.localize(resolvedLanguage, {
        zh: `完成。已导入 ${importedCount} 章，共 ${formatLengthCount(totalWords, countingMode)}。下一章：${nextChapter}`,
        en: `Done. ${importedCount} chapters imported, ${formatLengthCount(totalWords, countingMode)}. Next chapter: ${nextChapter}`,
      }));

      return {
        bookId: input.bookId,
        importedCount,
        totalWords,
        nextChapter,
      };
    } finally {
      await releaseLock();
    }
  }

  private static addUsage(
    a: TokenUsageSummary,
    b?: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number },
  ): TokenUsageSummary {
    if (!b) return a;
    return {
      promptTokens: a.promptTokens + b.promptTokens,
      completionTokens: a.completionTokens + b.completionTokens,
      totalTokens: a.totalTokens + b.totalTokens,
    };
  }

  /**
   * 字符三元组 Jaccard 相似度(0~1),用于判定润色/字数微调是否实质改写了正文。
   * 设计取舍:不引第三方依赖、对中文无需分词、对"仅润色"这种局部增删足够敏感,
   * 又能在大段重写时显著掉到阈值以下,触发重新分析。空串保护避免除零。
   */
  static contentSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    const grams = (s: string): Set<string> => {
      const set = new Set<string>();
      const t = s.replace(/\s+/g, "");
      for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3));
      return set;
    };
    const A = grams(a);
    const B = grams(b);
    if (A.size === 0 || B.size === 0) return a === b ? 1 : 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    return inter / (A.size + B.size - inter);
  }

  private async buildPersistenceOutput(
    bookId: string,
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    output: WriteChapterOutput,
    finalContent: string,
    countingMode: Parameters<typeof countChapterLength>[1],
    reducedControlInput?: {
      chapterIntent: string;
      contextPackage: ContextPackage;
      ruleStack: RuleStack;
    },
  ): Promise<WriteChapterOutput> {
    if (finalContent === output.content) {
      return output;
    }

    // 性能优化:正文与写手草稿高度一致(仅润色/字数微调,事实未变)→ 直接信任写手阶段已结算的
    // state/hooks/matrix,省掉一次"全章重读"的 LLM 分析(关键路径最贵的冗余调用之一)。
    // 仅当正文被实质改写(相似度低)才重新分析;后续状态校验仍会兜底捕捉矛盾。
    if (PipelineRunner.contentSimilarity(output.content, finalContent) >= 0.9) {
      return {
        ...output,
        content: finalContent,
        wordCount: countChapterLength(finalContent, countingMode),
      };
    }

    const analyzer = new ChapterAnalyzerAgent(this.agentCtxFor("chapter-analyzer", bookId));
    const timeoutMs = postWriteAnalysisTimeoutMs();
    let analyzed;
    try {
      analyzed = await withPostWriteAnalysisTimeout(
        analyzer.analyzeChapter({
          book,
          bookDir,
          chapterNumber,
          chapterContent: finalContent,
          chapterTitle: output.title,
          chapterIntent: reducedControlInput?.chapterIntent,
          contextPackage: reducedControlInput?.contextPackage,
          ruleStack: reducedControlInput?.ruleStack,
        }),
        timeoutMs,
        `chapter ${chapterNumber} post-write analysis timed out after ${timeoutMs}ms`,
      );
    } catch (error) {
      this.logWarn(book.language === "en" ? "en" : "zh", {
        zh: `第${chapterNumber}章最终真相分析超时/失败，沿用写作阶段状态并先保存正文：${error instanceof Error ? error.message : String(error)}`,
        en: `Chapter ${chapterNumber} post-write truth analysis timed out or failed; saving the body with writer-stage state: ${error instanceof Error ? error.message : String(error)}`,
      });
      return {
        ...output,
        content: finalContent,
        wordCount: countChapterLength(finalContent, countingMode),
        postWriteErrors: [{
          rule: "post-write-analysis",
          severity: "error",
          description: book.language === "en"
            ? "Post-write truth analysis timed out or failed after final prose changed."
            : "最终正文已变化，但真相分析超时或失败。",
          suggestion: book.language === "en"
            ? "Mark this chapter as state-degraded and repair state before continuing."
            : "本章必须视为状态不可信，先进行状态修复后才允许续写。",
        }],
        postWriteWarnings: [],
        hookHealthIssues: output.hookHealthIssues,
        tokenUsage: output.tokenUsage,
      };
    }

    return {
      ...analyzed,
      content: finalContent,
      wordCount: countChapterLength(finalContent, countingMode),
      postWriteErrors: [],
      postWriteWarnings: [],
      hookHealthIssues: output.hookHealthIssues,
      tokenUsage: output.tokenUsage,
    };
  }

  private async assertNoPendingStateRepair(bookId: string): Promise<void> {
    const existingIndex = await this.state.loadChapterIndex(bookId);
    const latestChapter = [...existingIndex].sort((left, right) => right.number - left.number)[0];
    if (latestChapter?.status !== "state-degraded") {
      return;
    }

    throw new Error(
      `Latest chapter ${latestChapter.number} is state-degraded. Repair state or rewrite that chapter before continuing.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async prepareWriteInput(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
  ): Promise<Pick<WriteChapterInput, "externalContext" | "chapterIntent" | "chapterMemo" | "chapterIntentData" | "contextPackage" | "ruleStack">> {
    if ((this.config.inputGovernanceMode ?? "v2") === "legacy") {
      return { externalContext };
    }

    const { plan, composed } = await this.createGovernedArtifacts(
      book,
      bookDir,
      chapterNumber,
      externalContext,
      { reuseExistingIntentWhenContextMissing: true },
    );

    return {
      externalContext,
      chapterIntent: plan.intentMarkdown,
      chapterMemo: plan.memo,
      chapterIntentData: plan.intent,
      contextPackage: composed.contextPackage,
      ruleStack: composed.ruleStack,
    };
  }

  private async resetImportReplayTruthFiles(
    bookDir: string,
    language: LengthLanguage,
  ): Promise<void> {
    const storyDir = join(bookDir, "story");

    await Promise.all([
      writeFile(
        join(storyDir, "current_state.md"),
        this.buildImportReplayStateSeed(language),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        this.buildImportReplayHooksSeed(language),
        "utf-8",
      ),
      rm(join(storyDir, "chapter_summaries.md"), { force: true }),
      rm(join(storyDir, "subplot_board.md"), { force: true }),
      rm(join(storyDir, "emotional_arcs.md"), { force: true }),
      rm(join(storyDir, "character_matrix.md"), { force: true }),
      rm(join(storyDir, "volume_summaries.md"), { force: true }),
      rm(join(storyDir, "particle_ledger.md"), { force: true }),
      rm(join(storyDir, "memory.db"), { force: true }),
      rm(join(storyDir, "memory.db-shm"), { force: true }),
      rm(join(storyDir, "memory.db-wal"), { force: true }),
      rm(join(storyDir, "state"), { recursive: true, force: true }),
      rm(join(storyDir, "snapshots"), { recursive: true, force: true }),
    ]);
  }

  private buildImportReplayStateSeed(language: LengthLanguage): string {
    if (language === "en") {
      return [
        "# Current State",
        "",
        "| Field | Value |",
        "| --- | --- |",
        "| Current Chapter | 0 |",
        "| Current Location | (not set) |",
        "| Protagonist State | (not set) |",
        "| Current Goal | (not set) |",
        "| Current Constraint | (not set) |",
        "| Current Alliances | (not set) |",
        "| Current Conflict | (not set) |",
        "",
      ].join("\n");
    }

    return [
      "# 当前状态",
      "",
      "| 字段 | 值 |",
      "| --- | --- |",
      "| 当前章节 | 0 |",
      "| 当前位置 | （未设定） |",
      "| 主角状态 | （未设定） |",
      "| 当前目标 | （未设定） |",
      "| 当前限制 | （未设定） |",
      "| 当前敌我 | （未设定） |",
      "| 当前冲突 | （未设定） |",
      "",
    ].join("\n");
  }

  private buildImportReplayHooksSeed(language: LengthLanguage): string {
    if (language === "en") {
      return [
        "# Pending Hooks",
        "",
        "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "",
      ].join("\n");
    }

    return [
      "# 伏笔池",
      "",
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "",
    ].join("\n");
  }

  private async normalizeDraftLengthIfNeeded(params: {
    bookId: string;
    chapterNumber: number;
    chapterContent: string;
    lengthSpec: LengthSpec;
    chapterIntent?: string;
  }): Promise<{
    content: string;
    wordCount: number;
    applied: boolean;
    tokenUsage?: TokenUsageSummary;
  }> {
    const writerCount = countChapterLength(
      params.chapterContent,
      params.lengthSpec.countingMode,
    );
    if (!isOutsideSoftRange(writerCount, params.lengthSpec)) {
      return {
        content: params.chapterContent,
        wordCount: writerCount,
        applied: false,
      };
    }

    const normalizer = new LengthNormalizerAgent(
      this.agentCtxFor("length-normalizer", params.bookId),
    );
    const normalized = await normalizer.normalizeChapter({
      chapterContent: params.chapterContent,
      lengthSpec: params.lengthSpec,
      chapterIntent: params.chapterIntent,
    });

    // Safety net: reject the normalization if it gutted the draft (>75% cut) OR a COMPRESS
    // pass overshot below the hard-minimum target length. A compress that lands below the floor
    // has failed its job — it must bring an over-long draft INTO range, not destroy it — so keep
    // the complete original draft and let the downstream gate/repair handle the over-length.
    // (Expansion is exempt: an under-target expand still grows the draft and is better than the
    // shorter original, so we never reject it for being below the floor.)
    const hardFloor = Number(params.lengthSpec?.hardMin) || 0;
    const overCompressed = normalized.mode === "compress" && hardFloor > 0 && normalized.finalCount < hardFloor;
    if (normalized.finalCount < writerCount * 0.25 || overCompressed) {
      this.logWarn(this.languageFromLengthSpec(params.lengthSpec), {
        zh: `字数归一化被拒绝：第${params.chapterNumber}章 ${writerCount} -> ${normalized.finalCount}（低于安全阈值或硬下限 ${hardFloor}，保留原稿）`,
        en: `Length normalization rejected for chapter ${params.chapterNumber}: ${writerCount} -> ${normalized.finalCount} (below safety threshold or hard floor ${hardFloor}; keeping original draft)`,
      });
      return {
        content: params.chapterContent,
        wordCount: writerCount,
        applied: false,
      };
    }

    this.logInfo(this.languageFromLengthSpec(params.lengthSpec), {
      zh: `审计前字数归一化：第${params.chapterNumber}章 ${writerCount} -> ${normalized.finalCount}`,
      en: `Length normalization before audit for chapter ${params.chapterNumber}: ${writerCount} -> ${normalized.finalCount}`,
    });

    return {
      content: normalized.normalizedContent,
      wordCount: normalized.finalCount,
      applied: normalized.applied,
      tokenUsage: normalized.tokenUsage,
    };
  }

  private assertChapterContentNotEmpty(content: string, chapterNumber: number, stage: string): void {
    if (content.trim().length > 0) return;
    throw new Error(`Chapter ${chapterNumber} has empty chapter content after ${stage}`);
  }

  private async syncCurrentStateFactHistory(bookId: string, uptoChapter: number): Promise<void> {
    const bookDir = this.state.bookDir(bookId);
    try {
      await this.rebuildCurrentStateFactHistory(bookDir, uptoChapter);
    } catch (error) {
      if (this.isMemoryIndexUnavailableError(error)) {
        if (this.canOpenMemoryIndex(bookDir)) {
          try {
            await this.rebuildCurrentStateFactHistory(bookDir, uptoChapter);
            return;
          } catch (retryError) {
            error = retryError;
          }
        } else {
          if (!this.memoryIndexFallbackWarned) {
            this.memoryIndexFallbackWarned = true;
            this.logWarn(await this.resolveBookLanguageById(bookId), {
              zh: "当前 Node 运行时不支持 SQLite 记忆索引，继续使用 Markdown 回退方案。",
              en: "SQLite memory index unavailable on this Node runtime; continuing with markdown fallback.",
            });
            await this.logMemoryIndexDebugInfo(bookId, error);
          }
          return;
        }
      }
      this.logWarn(await this.resolveBookLanguageById(bookId), {
        zh: `状态事实同步已跳过：${String(error)}`,
        en: `State fact sync skipped: ${String(error)}`,
      });
    }
  }

  private async syncLegacyStructuredStateFromMarkdown(
    bookDir: string,
    chapterNumber: number,
    output?: {
      readonly runtimeStateDelta?: WriteChapterOutput["runtimeStateDelta"];
      readonly runtimeStateSnapshot?: WriteChapterOutput["runtimeStateSnapshot"];
    },
  ): Promise<void> {
    if (output?.runtimeStateDelta || output?.runtimeStateSnapshot) {
      return;
    }

    await rewriteStructuredStateFromMarkdown({
      bookDir,
      fallbackChapter: chapterNumber,
    });
  }

  private async syncNarrativeMemoryIndex(bookId: string): Promise<void> {
    const bookDir = this.state.bookDir(bookId);
    try {
      await this.rebuildNarrativeMemoryIndex(bookDir);
    } catch (error) {
      if (this.isMemoryIndexUnavailableError(error)) {
        if (this.canOpenMemoryIndex(bookDir)) {
          try {
            await this.rebuildNarrativeMemoryIndex(bookDir);
            return;
          } catch (retryError) {
            error = retryError;
          }
        } else {
          if (!this.memoryIndexFallbackWarned) {
            this.memoryIndexFallbackWarned = true;
            this.logWarn(await this.resolveBookLanguageById(bookId), {
              zh: "当前 Node 运行时不支持 SQLite 记忆索引，继续使用 Markdown 回退方案。",
              en: "SQLite memory index unavailable on this Node runtime; continuing with markdown fallback.",
            });
            await this.logMemoryIndexDebugInfo(bookId, error);
          }
          return;
        }
      }
      this.logWarn(await this.resolveBookLanguageById(bookId), {
        zh: `叙事记忆同步已跳过：${String(error)}`,
        en: `Narrative memory sync skipped: ${String(error)}`,
      });
    }
  }

  /**
   * Phase 2 · 活的故事知识图谱:每章把已落盘的 character_matrix / current_state 增量入图
   * (实体 + 关系 + 单值状态自动作废旧值)。best-effort,失败绝不阻断写作主链。
   */
  private async syncStoryGraphIndex(bookId: string, chapterNumber: number): Promise<void> {
    try {
      const result = await syncStoryGraph({ bookDir: this.state.bookDir(bookId), chapterNumber });
      if (result.entitiesUpserted > 0 || result.relationsAdded > 0 || result.superseded > 0) {
        this.config.logger?.info(
          `[graph] 第 ${chapterNumber} 章入图:实体 ${result.entitiesUpserted} · 关系 +${result.relationsAdded} · 矛盾消解 ${result.superseded}`,
        );
      }
      // ③ 矛盾守门:图谱查出"不可变事实被推翻"的硬矛盾(canon 违反)→ 记日志。
      // 注:不在这里写 index.auditIssues —— syncStoryGraphIndex 在主写链保存章节条目之前/之中运行,
      // 而主链是整文件覆盖 index.json,append 会被 last-writer-wins 抹掉(race + 不可靠)。
      // 矛盾的主防线是下面 §canon 注入写手做"预防";如需把检测接入复修,应由 gate 侧读图谱(后续)。
      if (result.contradictions.length > 0) {
        for (const c of result.contradictions) {
          this.config.logger?.warn?.(`[graph] ⚠️ canon 矛盾:${c.description}`);
        }
      }
    } catch (error) {
      this.config.logger?.warn?.(`[graph] 第 ${chapterNumber} 章入图跳过：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 把额外审稿问题(如图谱矛盾守门)去重追加到指定章节的 auditIssues。 */
  private async appendChapterAuditIssues(bookId: string, chapterNumber: number, issues: ReadonlyArray<string>): Promise<void> {
    if (issues.length === 0) return;
    const chapters = await this.state.loadChapterIndex(bookId).catch(() => [] as ChapterMeta[]);
    const list = chapters.map((c) => ({ ...c }));
    const target = list.find((c) => Number(c.number) === chapterNumber);
    if (!target) return;
    const existing = Array.isArray(target.auditIssues) ? target.auditIssues : [];
    const additions = issues.filter((it) => !existing.includes(it));
    if (additions.length === 0) return;
    target.auditIssues = [...existing, ...additions];
    await this.state.saveChapterIndex(bookId, list);
  }

  private async rebuildCurrentStateFactHistory(bookDir: string, uptoChapter: number): Promise<void> {
    const memoryDb = await this.withMemoryIndexRetry(async () => {
      const db = new MemoryDB(bookDir);
      try {
        db.resetFacts();

        const activeFacts = new Map<string, { id: number; object: string }>();

        for (let chapter = 0; chapter <= uptoChapter; chapter++) {
          const snapshotFacts = await loadSnapshotCurrentStateFacts(bookDir, chapter);
          if (snapshotFacts.length === 0) continue;
          const nextFacts = new Map<string, Omit<Fact, "id">>();

          for (const fact of snapshotFacts) {
            nextFacts.set(this.factKey(fact), {
              subject: fact.subject,
              predicate: fact.predicate,
              object: fact.object,
              validFromChapter: chapter,
              validUntilChapter: null,
              sourceChapter: chapter,
            });
          }

          for (const [key, previous] of activeFacts.entries()) {
            const next = nextFacts.get(key);
            if (!next || next.object !== previous.object) {
              db.invalidateFact(previous.id, chapter);
              activeFacts.delete(key);
            }
          }

          for (const [key, fact] of nextFacts.entries()) {
            if (activeFacts.has(key)) continue;
            const id = db.addFact(fact);
            activeFacts.set(key, { id, object: fact.object });
          }
        }

        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    });

    try {
      // No-op: keep the db open only for the duration of the rebuild.
    } finally {
      memoryDb.close();
    }
  }

  private async rebuildNarrativeMemoryIndex(bookDir: string): Promise<void> {
    const memorySeed = await loadNarrativeMemorySeed(bookDir);

    const memoryDb = await this.withMemoryIndexRetry(() => {
      const db = new MemoryDB(bookDir);
      try {
        db.replaceSummaries(memorySeed.summaries);
        db.replaceHooks(memorySeed.hooks);
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    });

    try {
      // No-op: keep the db open only for the duration of the rebuild.
    } finally {
      memoryDb.close();
    }
  }

  private canOpenMemoryIndex(bookDir: string): boolean {
    let memoryDb: MemoryDB | null = null;
    try {
      memoryDb = new MemoryDB(bookDir);
      return true;
    } catch {
      return false;
    } finally {
      memoryDb?.close();
    }
  }

  private async logMemoryIndexDebugInfo(bookId: string, error: unknown): Promise<void> {
    if (process.env.AUTOW_DEBUG_SQLITE_MEMORY !== "1") {
      return;
    }

    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    const message = error instanceof Error
      ? error.message
      : String(error);

    this.logWarn(await this.resolveBookLanguageById(bookId), {
      zh: `SQLite 记忆索引调试：node=${process.version}; execArgv=${JSON.stringify(process.execArgv)}; code=${code || "(none)"}; message=${message}`,
      en: `SQLite memory debug: node=${process.version}; execArgv=${JSON.stringify(process.execArgv)}; code=${code || "(none)"}; message=${message}`,
    });
  }

  private async withMemoryIndexRetry<T>(operation: () => Promise<T> | T): Promise<T> {
    const retryDelaysMs = [0, 25, 75];
    let lastError: unknown;

    for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!this.isMemoryIndexBusyError(error) || attempt === retryDelaysMs.length - 1) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt + 1]!));
      }
    }

    throw lastError;
  }

  private isMemoryIndexUnavailableError(error: unknown): boolean {
    if (!error) return false;

    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    const message = error instanceof Error
      ? error.message
      : String(error);
    const normalizedMessage = message.trim();

    return /^No such built-in module:\s*node:sqlite$/i.test(normalizedMessage)
      || /^Cannot find module ['"]node:sqlite['"]$/i.test(normalizedMessage)
      || (code === "ERR_UNKNOWN_BUILTIN_MODULE" && /\bnode:sqlite\b/i.test(normalizedMessage));
  }

  private isMemoryIndexBusyError(error: unknown): boolean {
    if (!error) return false;

    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    const message = error instanceof Error
      ? error.message
      : String(error);

    return code === "SQLITE_BUSY"
      || code === "SQLITE_LOCKED"
      || /\bSQLITE_BUSY\b/i.test(message)
      || /\bSQLITE_LOCKED\b/i.test(message)
      || /database is locked/i.test(message)
      || /database is busy/i.test(message);
  }

  private factKey(fact: Pick<Fact, "subject" | "predicate">): string {
    return `${fact.subject}::${fact.predicate}`;
  }

  private async persistAuditDriftGuidance(params: {
    readonly bookDir: string;
    readonly chapterNumber: number;
    readonly issues: ReadonlyArray<AuditIssue>;
    readonly language: LengthLanguage;
  }): Promise<void> {
    const storyDir = join(params.bookDir, "story");
    const driftPath = join(storyDir, "audit_drift.md");
    const statePath = join(storyDir, "current_state.md");
    const currentState = await readFile(statePath, "utf-8").catch(() => "");
    const sanitizedState = this.stripAuditDriftCorrectionBlock(currentState).trimEnd();

    if (sanitizedState !== currentState) {
      await writeFile(statePath, sanitizedState, "utf-8");
    }

    if (params.issues.length === 0) {
      await rm(driftPath, { force: true }).catch(() => undefined);
      return;
    }

    const block = [
      this.localize(params.language, {
        zh: "# 审计纠偏",
        en: "# Audit Drift",
      }),
      "",
      this.localize(params.language, {
        zh: "## 审计纠偏（自动生成，下一章写作前参照）",
        en: "## Audit Drift Correction",
      }),
      "",
      this.localize(params.language, {
        zh: `> 第${params.chapterNumber}章审计发现以下问题，下一章写作时必须避免：`,
        en: `> Chapter ${params.chapterNumber} audit found the following issues to avoid in the next chapter:`,
      }),
      ...params.issues.map((issue) => `> - [${issue.severity}] ${issue.category}: ${issue.description}`),
      "",
    ].join("\n");

    await writeFile(driftPath, block, "utf-8");
  }

  private stripAuditDriftCorrectionBlock(currentState: string): string {
    const headers = [
      "## 审计纠偏（自动生成，下一章写作前参照）",
      "## Audit Drift Correction",
      "# 审计纠偏",
      "# Audit Drift",
    ];

    let cutIndex = -1;
    for (const header of headers) {
      const index = currentState.indexOf(header);
      if (index >= 0 && (cutIndex < 0 || index < cutIndex)) {
        cutIndex = index;
      }
    }

    if (cutIndex < 0) {
      return currentState;
    }

    return currentState.slice(0, cutIndex).trimEnd();
  }

  private logLengthWarnings(lengthWarnings: ReadonlyArray<string>): void {
    for (const warning of lengthWarnings) {
      this.config.logger?.warn(warning);
    }
  }

  private restoreLostAuditIssues(previous: AuditResult, next: AuditResult): AuditResult {
    if (next.passed || next.issues.length > 0 || previous.issues.length === 0) {
      return next;
    }

    return {
      ...next,
      issues: previous.issues,
      summary: next.summary || previous.summary,
    };
  }

  private restoreActionableAuditIfLost(
    previous: {
      auditResult: AuditResult;
      aiTellCount: number;
      blockingCount: number;
      criticalCount: number;
      revisionBlockingIssues: ReadonlyArray<AuditIssue>;
    },
    next: {
      auditResult: AuditResult;
      aiTellCount: number;
      blockingCount: number;
      criticalCount: number;
      revisionBlockingIssues: ReadonlyArray<AuditIssue>;
    },
  ): MergedAuditEvaluation {
    const auditResult = this.restoreLostAuditIssues(previous.auditResult, next.auditResult);
    if (auditResult === next.auditResult) {
      return next;
    }

    return {
      ...next,
      auditResult,
      revisionBlockingIssues: previous.revisionBlockingIssues,
      blockingCount: previous.blockingCount,
      criticalCount: previous.criticalCount,
    };
  }

  private async evaluateMergedAudit(params: {
    auditor: ContinuityAuditor;
    book: BookConfig;
    bookDir: string;
    chapterContent: string;
    chapterNumber: number;
    language: LengthLanguage;
    auditOptions?: {
      temperature?: number;
      chapterIntent?: string;
      chapterMemo?: ChapterMemo;
      contextPackage?: ContextPackage;
      ruleStack?: RuleStack;
      truthFileOverrides?: {
        currentState?: string;
        ledger?: string;
        hooks?: string;
      };
    };
  }): Promise<MergedAuditEvaluation> {
    const llmAudit = await params.auditor.auditChapter(
      params.bookDir,
      params.chapterContent,
      params.chapterNumber,
      params.book.genre,
      params.auditOptions,
    );
    const aiTells = analyzeAITells(params.chapterContent, params.language);
    const sensitiveResult = analyzeSensitiveWords(params.chapterContent, undefined, params.language);
    const longSpanFatigue = await analyzeLongSpanFatigue({
      bookDir: params.bookDir,
      chapterNumber: params.chapterNumber,
      chapterContent: params.chapterContent,
      language: params.language,
    });
    const hasBlockedWords = sensitiveResult.found.some((f) => f.severity === "block");
    const issues: ReadonlyArray<AuditIssue> = [
      ...llmAudit.issues,
      ...aiTells.issues,
      ...sensitiveResult.issues,
      ...longSpanFatigue.issues,
    ];
    const blockingLongSpanFatigue = longSpanFatigue.issues.filter(isRevisionBlockingLongSpanFatigue);
    // Most sequence-level fatigue remains drift guidance only, but chapter-shape
    // sameness (same opening/ending/template skeleton) must trigger revision.
    const revisionBlockingIssues: ReadonlyArray<AuditIssue> = [
      ...llmAudit.issues,
      ...aiTells.issues,
      ...sensitiveResult.issues,
      ...blockingLongSpanFatigue,
    ];

    return {
      auditResult: {
        passed: hasBlockedWords ? false : llmAudit.passed,
        issues,
        summary: llmAudit.summary,
        tokenUsage: llmAudit.tokenUsage,
      },
      aiTellCount: aiTells.issues.length,
      blockingCount: revisionBlockingIssues.filter((issue) => issue.severity === "warning" || issue.severity === "critical").length,
      criticalCount: revisionBlockingIssues.filter((issue) => issue.severity === "critical").length,
      revisionBlockingIssues,
    };
  }

  private async markBookActiveIfNeeded(bookId: string): Promise<void> {
    const book = await this.state.loadBookConfig(bookId);
    if (book.status !== "outlining") return;

    await this.state.saveBookConfig(bookId, {
      ...book,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
  }

  private async createGovernedArtifacts(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
    options?: {
      readonly reuseExistingIntentWhenContextMissing?: boolean;
    },
  ): Promise<{
    plan: PlanChapterOutput;
    composed: ComposeChapterOutput;
  }> {
    const plan = await this.resolveGovernedPlan(book, bookDir, chapterNumber, externalContext, options);
    // 语义检索:仅当配置了 embedding 模型时启用(复用 composer 的 client baseUrl/key)。
    // 未配置 → embed 为 undefined → retrieveMemorySelection 走纯词面,行为与改动前完全一致。
    const composerClient = this.agentCtxFor("composer", book.id).client;
    // 嵌入模型/baseUrl:优先用项目配置(embeddingModel/embeddingBaseUrl),再用环境变量兜底(原型期便于开关)。
    // embeddingBaseUrl 让嵌入走独立服务(如本地 Ollama bge-m3),与 chat(deepseek 无 /embeddings)解耦。
    const embeddingModel = composerClient.embeddingModel ?? process.env.JUANSHE_EMBED_MODEL;
    const embeddingBaseUrl = composerClient.embeddingBaseUrl ?? process.env.JUANSHE_EMBED_BASE_URL;
    const embed = embeddingModel
      ? (texts: ReadonlyArray<string>) => embedTexts(composerClient, texts, embeddingModel as string, embeddingBaseUrl)
      : undefined;
    const composed = await composeGovernedChapter({
      book,
      bookDir,
      chapterNumber,
      plan,
      embed,
    });

    return { plan, composed };
  }

  private async resolveGovernedPlan(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
    options?: {
      readonly reuseExistingIntentWhenContextMissing?: boolean;
    },
  ): Promise<PlanChapterOutput> {
    if (
      options?.reuseExistingIntentWhenContextMissing &&
      (!externalContext || externalContext.trim().length === 0)
    ) {
      const persisted = await loadPersistedPlan(bookDir, chapterNumber);
      if (persisted) return persisted;
    }

    const planner = new PlannerAgent(this.agentCtxFor("planner", book.id));
    const plan = await planner.planChapter({
      book,
      bookDir,
      chapterNumber,
      externalContext,
    });
    // Persist in the new memo format so subsequent compose/write phases can
    // skip the planner LLM call when no new context is supplied.
    await savePersistedPlan(bookDir, plan);
    return plan;
  }

  private async emitWebhook(
    event: WebhookEvent,
    bookId: string,
    chapterNumber?: number,
    data?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.notifyChannels || this.config.notifyChannels.length === 0) return;
    await dispatchWebhookEvent(this.config.notifyChannels, {
      event,
      bookId,
      chapterNumber,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  private async readChapterContent(bookDir: string, chapterNumber: number): Promise<string> {
    const chaptersDir = join(bookDir, "chapters");
    const files = await readdir(chaptersDir);
    const paddedNum = String(chapterNumber).padStart(4, "0");
    const chapterFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
    if (!chapterFile) {
      throw new Error(`Chapter ${chapterNumber} file not found in ${chaptersDir}`);
    }
    const raw = await readFile(join(chaptersDir, chapterFile), "utf-8");
    // Strip the title line
    const lines = raw.split("\n");
    const contentStart = lines.findIndex((l, i) => i > 0 && l.trim().length > 0);
    return contentStart >= 0 ? lines.slice(contentStart).join("\n") : raw;
  }
}
