import { describe, expect, it, vi } from "vitest";
import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { ChapterMeta } from "../models/chapter.js";
import { persistChapterArtifacts } from "../pipeline/chapter-persistence.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

function createIssue(overrides?: Partial<AuditIssue>): AuditIssue {
  return {
    severity: "warning",
    category: "continuity",
    description: "issue",
    suggestion: "fix",
    ...overrides,
  };
}

function createAuditResult(overrides?: Partial<AuditResult>): AuditResult {
  return {
    passed: true,
    issues: [],
    summary: "clean",
    ...overrides,
  };
}

describe("persistChapterArtifacts", () => {
  it("persists truth files, index, drift guidance, and snapshots for reviewable chapters", async () => {
    const saveChapter = vi.fn().mockResolvedValue(undefined);
    const saveTruthFiles = vi.fn().mockResolvedValue(undefined);
    const saveChapterIndex = vi.fn().mockResolvedValue(undefined);
    const markBookActiveIfNeeded = vi.fn().mockResolvedValue(undefined);
    const persistAuditDriftGuidance = vi.fn().mockResolvedValue(undefined);
    const snapshotState = vi.fn().mockResolvedValue(undefined);
    const syncCurrentStateFactHistory = vi.fn().mockResolvedValue(undefined);
    const logSnapshotStage = vi.fn();

    await persistChapterArtifacts({
      chapterNumber: 3,
      chapterTitle: "Chapter Title",
      content: "他把U盘攥进手心，回头看了一眼档案室的黑窗。",
      status: "ready-for-review",
      auditResult: createAuditResult({
        issues: [
          createIssue({ severity: "info", description: "ignore me" }),
          createIssue({ severity: "warning", description: "keep me" }),
          createIssue({ severity: "critical", description: "keep me too" }),
        ],
      }),
      finalWordCount: 888,
      lengthWarnings: ["warn"],
      degradedIssues: [],
      tokenUsage: ZERO_USAGE,
      loadChapterIndex: async () => [] satisfies ReadonlyArray<ChapterMeta>,
      saveChapter,
      saveTruthFiles,
      saveChapterIndex,
      markBookActiveIfNeeded,
      persistAuditDriftGuidance,
      snapshotState,
      syncCurrentStateFactHistory,
      logSnapshotStage,
      now: () => "2026-04-01T00:00:00.000Z",
    });

    expect(saveChapter).toHaveBeenCalledTimes(1);
    expect(saveTruthFiles).toHaveBeenCalledTimes(1);
    expect(saveChapterIndex).toHaveBeenCalledWith([
      expect.objectContaining({
        number: 3,
        title: "Chapter Title",
        status: "ready-for-review",
        wordCount: 888,
        auditIssues: [
          "[info] ignore me",
          "[warning] keep me",
          "[critical] keep me too",
        ],
        reviewNote: undefined,
        tokenUsage: ZERO_USAGE,
      }),
    ]);
    expect(markBookActiveIfNeeded).toHaveBeenCalledTimes(1);
    expect(persistAuditDriftGuidance).toHaveBeenCalledWith([
      expect.objectContaining({ severity: "warning", description: "keep me" }),
      expect.objectContaining({ severity: "critical", description: "keep me too" }),
    ]);
    expect(logSnapshotStage).toHaveBeenCalledTimes(1);
    expect(snapshotState).toHaveBeenCalledTimes(1);
    expect(syncCurrentStateFactHistory).toHaveBeenCalledTimes(1);
  });

  it("skips truth persistence and snapshots for state-degraded chapters while preserving review note", async () => {
    const saveChapter = vi.fn().mockResolvedValue(undefined);
    const saveTruthFiles = vi.fn().mockResolvedValue(undefined);
    const saveChapterIndex = vi.fn().mockResolvedValue(undefined);
    const markBookActiveIfNeeded = vi.fn().mockResolvedValue(undefined);
    const persistAuditDriftGuidance = vi.fn().mockResolvedValue(undefined);
    const snapshotState = vi.fn().mockResolvedValue(undefined);
    const syncCurrentStateFactHistory = vi.fn().mockResolvedValue(undefined);
    const logSnapshotStage = vi.fn();

    await persistChapterArtifacts({
      chapterNumber: 4,
      chapterTitle: "Degraded Chapter",
      content: "她合上账本，吹熄了灯。",
      status: "state-degraded",
      auditResult: createAuditResult({
        passed: false,
        issues: [createIssue({ description: "audit issue" })],
        summary: "needs review",
      }),
      finalWordCount: 512,
      lengthWarnings: [],
      degradedIssues: [createIssue({ description: "state mismatch" })],
      tokenUsage: ZERO_USAGE,
      loadChapterIndex: async () => [] satisfies ReadonlyArray<ChapterMeta>,
      saveChapter,
      saveTruthFiles,
      saveChapterIndex,
      markBookActiveIfNeeded,
      persistAuditDriftGuidance,
      snapshotState,
      syncCurrentStateFactHistory,
      logSnapshotStage,
      now: () => "2026-04-01T00:00:00.000Z",
    });

    expect(saveChapter).toHaveBeenCalledTimes(1);
    expect(saveTruthFiles).not.toHaveBeenCalled();
    expect(saveChapterIndex).toHaveBeenCalledWith([
      expect.objectContaining({
        number: 4,
        title: "Degraded Chapter",
        status: "state-degraded",
        reviewNote: expect.any(String),
      }),
    ]);
    const reviewNote = saveChapterIndex.mock.calls[0]?.[0]?.[0]?.reviewNote as string;
    expect(JSON.parse(reviewNote)).toMatchObject({
      kind: "state-degraded",
      baseStatus: "audit-failed",
      injectedIssues: ["[warning] state mismatch"],
    });
    expect(persistAuditDriftGuidance).toHaveBeenCalledWith([]);
    expect(logSnapshotStage).not.toHaveBeenCalled();
    expect(snapshotState).not.toHaveBeenCalled();
    expect(syncCurrentStateFactHistory).not.toHaveBeenCalled();
  });

  it("replaces existing entry for the same chapter number instead of appending", async () => {
    const saveChapterIndex = vi.fn().mockResolvedValue(undefined);
    const existingEntry: ChapterMeta = {
      number: 1,
      title: "Old Title",
      status: "drafted",
      wordCount: 500,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    };

    await persistChapterArtifacts({
      chapterNumber: 1,
      chapterTitle: "New Title",
      content: "巷口的灯还亮着，他没急着进去。",
      status: "ready-for-review",
      auditResult: createAuditResult(),
      finalWordCount: 2000,
      lengthWarnings: [],
      degradedIssues: [],
      tokenUsage: ZERO_USAGE,
      loadChapterIndex: async () => [existingEntry],
      saveChapter: vi.fn().mockResolvedValue(undefined),
      saveTruthFiles: vi.fn().mockResolvedValue(undefined),
      saveChapterIndex,
      markBookActiveIfNeeded: vi.fn().mockResolvedValue(undefined),
      persistAuditDriftGuidance: vi.fn().mockResolvedValue(undefined),
      snapshotState: vi.fn().mockResolvedValue(undefined),
      syncCurrentStateFactHistory: vi.fn().mockResolvedValue(undefined),
      logSnapshotStage: vi.fn(),
      now: () => "2026-04-01T00:00:00.000Z",
    });

    const savedIndex = saveChapterIndex.mock.calls[0][0] as ChapterMeta[];
    // Must have exactly 1 entry, not 2
    expect(savedIndex).toHaveLength(1);
    expect(savedIndex[0].number).toBe(1);
    expect(savedIndex[0].title).toBe("New Title");
    expect(savedIndex[0].wordCount).toBe(2000);
    expect(savedIndex[0].status).toBe("ready-for-review");
    // Must preserve original createdAt
    expect(savedIndex[0].createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(savedIndex[0].updatedAt).toBe("2026-04-01T00:00:00.000Z");
  });

  it("落盘门禁:机械修复破折号后落盘,残留硬违规(章末预言句)绝不带病标 ready-for-review", async () => {
    const saveChapter = vi.fn().mockResolvedValue(undefined);
    const saveChapterIndex = vi.fn().mockResolvedValue(undefined);
    const persistAuditDriftGuidance = vi.fn().mockResolvedValue(undefined);
    const padding = "他把收音机搁在桌角，旋钮上全是灰。".repeat(3);
    const content = `${padding}\n\n窗外起风了——他拉紧了外套。\n\n他不知道的是，市场的另一头已经有人在等他。`;

    await persistChapterArtifacts({
      chapterNumber: 5,
      chapterTitle: "门禁测试",
      content,
      language: "zh",
      status: "ready-for-review",
      auditResult: createAuditResult(),
      finalWordCount: content.length,
      lengthWarnings: [],
      degradedIssues: [],
      tokenUsage: ZERO_USAGE,
      loadChapterIndex: async () => [] satisfies ReadonlyArray<ChapterMeta>,
      saveChapter,
      saveTruthFiles: vi.fn().mockResolvedValue(undefined),
      saveChapterIndex,
      markBookActiveIfNeeded: vi.fn().mockResolvedValue(undefined),
      persistAuditDriftGuidance,
      snapshotState: vi.fn().mockResolvedValue(undefined),
      syncCurrentStateFactHistory: vi.fn().mockResolvedValue(undefined),
      logSnapshotStage: vi.fn(),
      now: () => "2026-04-01T00:00:00.000Z",
    });

    // 破折号可机械修复:落盘内容已替换,不构成阻断
    const persisted = saveChapter.mock.calls[0]?.[0] as string;
    expect(persisted).not.toContain("——");
    // 章末预言句不可机械修复:状态降为 audit-failed,违规进章节索引与审计纠偏
    const savedIndex = saveChapterIndex.mock.calls[0]?.[0] as ChapterMeta[];
    expect(savedIndex[0]!.status).toBe("audit-failed");
    expect(savedIndex[0]!.auditIssues.some((line) => line.includes("章末"))).toBe(true);
    const driftIssues = persistAuditDriftGuidance.mock.calls[0]?.[0] as AuditIssue[];
    expect(driftIssues.some((issue) => issue.category.includes("落盘门禁"))).toBe(true);
  });
});
