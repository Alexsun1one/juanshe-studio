import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { LengthTelemetry } from "../models/length-governance.js";
import {
  normalizePostWriteSurface,
  validatePostWriteHardBans,
} from "../agents/post-write-validator.js";
import { buildStateDegradedReviewNote } from "./chapter-state-recovery.js";
import { updatePhraseLedger } from "./phrase-ledger.js";

export interface ChapterPersistenceUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export type ChapterPersistenceStatus = "ready-for-review" | "audit-failed" | "state-degraded";

export async function persistChapterArtifacts(params: {
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  /** 即将落盘的正文。落盘门禁(表面规整 + 硬禁令校验)在此统一执行,任何产文路径都绕不过。 */
  readonly content: string;
  readonly language?: "zh" | "en";
  /** 书目录:传了才更新复读账本(story/runtime/phrase-ledger.json);测试/无盘场景可不传。 */
  readonly bookDir?: string;
  readonly status: ChapterPersistenceStatus;
  readonly auditResult: AuditResult;
  readonly finalWordCount: number;
  readonly lengthWarnings: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly degradedIssues: ReadonlyArray<AuditIssue>;
  readonly tokenUsage?: ChapterPersistenceUsage;
  readonly loadChapterIndex: () => Promise<ReadonlyArray<ChapterMeta>>;
  readonly saveChapter: (finalContent: string) => Promise<void>;
  readonly saveTruthFiles: () => Promise<void>;
  readonly saveChapterIndex: (index: ReadonlyArray<ChapterMeta>) => Promise<void>;
  readonly markBookActiveIfNeeded: () => Promise<void>;
  readonly persistAuditDriftGuidance: (issues: ReadonlyArray<AuditIssue>) => Promise<void>;
  readonly snapshotState: () => Promise<void>;
  readonly syncCurrentStateFactHistory: () => Promise<void>;
  readonly logSnapshotStage: () => void;
  readonly now?: () => string;
}): Promise<{ readonly entry: ChapterMeta; readonly content: string }> {
  // ── 落盘门禁:表面规整 + 硬禁令校验下沉到落盘唯一入口 ──
  // 可机械修复的(破折号→逗号、模型备注行)直接替换;不可机械修复的硬违规
  // (禁句式/章末预言)此时复修预算已耗尽,绝不带病标 ready-for-review:
  // 状态降为 audit-failed 并把违规写进章节索引与审计纠偏,复修闭环与前端都看得见。
  const persistedContent = normalizePostWriteSurface(params.content, params.language);
  const hardViolations = params.status === "state-degraded"
    ? []
    : validatePostWriteHardBans(persistedContent, params.language);
  const gateIssues: AuditIssue[] = hardViolations.map((violation) => ({
    severity: "critical" as const,
    category: `落盘门禁/${violation.rule}`,
    description: violation.description,
    suggestion: violation.suggestion,
  }));
  const resolvedStatus: ChapterPersistenceStatus =
    params.status === "ready-for-review" && gateIssues.length > 0
      ? "audit-failed"
      : params.status;

  await params.saveChapter(persistedContent);
  if (params.status !== "state-degraded") {
    await params.saveTruthFiles();
  }

  const existingIndex = await params.loadChapterIndex();
  const now = params.now?.() ?? new Date().toISOString();
  const entry: ChapterMeta = {
    number: params.chapterNumber,
    title: params.chapterTitle,
    status: resolvedStatus,
    wordCount: params.finalWordCount,
    createdAt: now,
    updatedAt: now,
    auditIssues: [...params.auditResult.issues, ...gateIssues]
      .map((issue) => `[${issue.severity}] ${issue.description}`),
    lengthWarnings: [...params.lengthWarnings],
    reviewNote: params.status === "state-degraded"
      ? buildStateDegradedReviewNote(
          params.auditResult.passed ? "ready-for-review" : "audit-failed",
          params.degradedIssues,
        )
      : undefined,
    lengthTelemetry: params.lengthTelemetry,
    tokenUsage: params.tokenUsage,
  };
  const existingIdx = existingIndex.findIndex((e) => e.number === params.chapterNumber);
  const updatedIndex = existingIdx >= 0
    ? existingIndex.map((e, i) => i === existingIdx ? { ...entry, createdAt: e.createdAt } : e)
    : [...existingIndex, entry];
  await params.saveChapterIndex(updatedIndex);
  await params.markBookActiveIfNeeded();

  const driftIssues = [...params.auditResult.issues, ...gateIssues].filter(
    (issue) => issue.severity === "critical" || issue.severity === "warning",
  );
  await params.persistAuditDriftGuidance(params.status === "state-degraded" ? [] : driftIssues);

  if (params.status !== "state-degraded") {
    params.logSnapshotStage();
    await params.snapshotState();
    await params.syncCurrentStateFactHistory();
  }

  // 复读账本:对落盘正文做零 LLM 的跨章 n-gram 记账(按章幂等)。
  // best-effort:账本任何异常都不阻断落盘主链。
  if (params.bookDir && persistedContent.trim().length > 0) {
    await updatePhraseLedger({
      bookDir: params.bookDir,
      chapterNumber: params.chapterNumber,
      content: persistedContent,
    }).catch(() => undefined);
  }

  return { entry, content: persistedContent };
}
