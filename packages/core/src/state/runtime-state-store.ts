import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ChapterSummariesStateSchema,
  type ChapterSummariesState,
  CurrentStateStateSchema,
  HooksStateSchema,
  StateManifestSchema,
  type RuntimeStateDelta,
  type StateManifest,
} from "../models/runtime-state.js";
import type { Fact, StoredHook, StoredSummary } from "./memory-db.js";
import { bootstrapStructuredStateFromMarkdown, parseCurrentStateFacts } from "./state-bootstrap.js";
import { renderChapterSummariesProjection, renderCurrentStateProjection, renderHooksProjection } from "./state-projections.js";
import { applyRuntimeStateDelta, type RuntimeStateSnapshot } from "./state-reducer.js";
import { validateRuntimeState } from "./state-validator.js";
import { arbitrateRuntimeStateDeltaHooks } from "../utils/hook-arbiter.js";
import { atomicWriteFile } from "../utils/fs-atomic.js";

export interface RuntimeStateArtifacts {
  readonly snapshot: RuntimeStateSnapshot;
  readonly resolvedDelta: RuntimeStateDelta;
  readonly currentStateMarkdown: string;
  readonly hooksMarkdown: string;
  readonly chapterSummariesMarkdown: string;
}

export interface NarrativeMemorySeed {
  readonly summaries: ReadonlyArray<StoredSummary>;
  readonly hooks: ReadonlyArray<StoredHook>;
}

export async function loadRuntimeStateSnapshot(bookDir: string): Promise<RuntimeStateSnapshot> {
  await bootstrapStructuredStateFromMarkdown({ bookDir });
  const stateDir = join(bookDir, "story", "state");

  const [manifest, currentState, hooks, chapterSummaries] = await Promise.all([
    readJson(join(stateDir, "manifest.json"), StateManifestSchema),
    readJson(join(stateDir, "current_state.json"), CurrentStateStateSchema),
    readJson(join(stateDir, "hooks.json"), HooksStateSchema),
    readJson(join(stateDir, "chapter_summaries.json"), ChapterSummariesStateSchema),
  ]);

  let snapshot = {
    manifest,
    currentState,
    hooks,
    chapterSummaries,
  };

  // 自愈:结构化状态章号超前于 manifest(常见于"重置 / 迁移"后残留的旧缓存,如重置到 1 章但
  // current_state.json 还停在第 15 章)。manifest 是"实际写了多少章"的权威——夹到它即可,
  // 不应该硬报错把后续所有写作永久堵死。一处改,惠及所有书。
  if (manifest && currentState && currentState.chapter > manifest.lastAppliedChapter) {
    snapshot = { ...snapshot, currentState: { ...currentState, chapter: manifest.lastAppliedChapter } };
  }

  const issues = validateRuntimeState(snapshot);
  if (issues.length > 0) {
    const summary = issues
      .map((issue) => `${issue.code}${issue.path ? `@${issue.path}` : ""}`)
      .join(", ");
    throw new Error(`Invalid persisted runtime state: ${summary}`);
  }

  return snapshot;
}

export async function buildRuntimeStateArtifacts(params: {
  readonly bookDir: string;
  readonly delta: RuntimeStateDelta;
  readonly language: "zh" | "en";
  readonly allowReapply?: boolean;
}): Promise<RuntimeStateArtifacts> {
  const snapshot = await loadRuntimeStateSnapshot(params.bookDir);
  const { resolvedDelta } = arbitrateRuntimeStateDeltaHooks({
    hooks: snapshot.hooks.hooks,
    delta: params.delta,
  });
  const next = applyRuntimeStateDelta({
    snapshot,
    delta: resolvedDelta,
    allowReapply: params.allowReapply,
  });

  return {
    snapshot: next,
    resolvedDelta,
    currentStateMarkdown: renderCurrentStateProjection(next.currentState, params.language),
    // Pass the chapter number so the projection can tag stale / blocked hooks.
    hooksMarkdown: renderHooksProjection(next.hooks, params.language, {
      currentChapter: resolvedDelta.chapter,
    }),
    chapterSummariesMarkdown: renderChapterSummariesProjection(next.chapterSummaries, params.language),
  };
}

export async function saveRuntimeStateSnapshot(
  bookDir: string,
  snapshot: RuntimeStateSnapshot,
): Promise<void> {
  const stateDir = join(bookDir, "story", "state");
  await mkdir(stateDir, { recursive: true });

  const existingManifest = await readJsonOrNull(join(stateDir, "manifest.json"), StateManifestSchema);
  const existingSummaries = await readJsonOrNull(join(stateDir, "chapter_summaries.json"), ChapterSummariesStateSchema);
  const manifest = mergeManifestProgress(existingManifest, snapshot.manifest);
  const chapterSummaries = mergeChapterSummaryState(existingSummaries, snapshot.chapterSummaries);

  await atomicWriteFile(join(stateDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await atomicWriteFile(join(stateDir, "current_state.json"), JSON.stringify(snapshot.currentState, null, 2));
  await atomicWriteFile(join(stateDir, "hooks.json"), JSON.stringify(snapshot.hooks, null, 2));
  await atomicWriteFile(join(stateDir, "chapter_summaries.json"), JSON.stringify(chapterSummaries, null, 2));
}

export async function loadNarrativeMemorySeed(bookDir: string): Promise<NarrativeMemorySeed> {
  const snapshot = await loadRuntimeStateSnapshot(bookDir);

  return {
    summaries: snapshot.chapterSummaries.rows.map((row) => ({
      chapter: row.chapter,
      title: row.title,
      characters: row.characters,
      events: row.events,
      stateChanges: row.stateChanges,
      hookActivity: row.hookActivity,
      mood: row.mood,
      chapterType: row.chapterType,
    })),
      hooks: snapshot.hooks.hooks.map((hook) => ({
        hookId: hook.hookId,
        startChapter: hook.startChapter,
        type: hook.type,
        status: hook.status,
        lastAdvancedChapter: hook.lastAdvancedChapter,
        expectedPayoff: hook.expectedPayoff,
        payoffTiming: hook.payoffTiming,
        notes: hook.notes,
      })),
  };
}

export async function loadSnapshotCurrentStateFacts(
  bookDir: string,
  chapterNumber: number,
): Promise<ReadonlyArray<Fact>> {
  const snapshotDir = join(bookDir, "story", "snapshots", String(chapterNumber));
  const structuredState = await readJsonOrNull(
    join(snapshotDir, "state", "current_state.json"),
    CurrentStateStateSchema,
  );
  if (structuredState) {
    return structuredState.facts;
  }

  const markdown = await readFile(join(snapshotDir, "current_state.md"), "utf-8").catch(() => "");
  return parseCurrentStateFacts(markdown, chapterNumber);
}

async function readJson<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T> {
  const raw = await readFile(path, "utf-8");
  return schema.parse(JSON.parse(raw));
}

async function readJsonOrNull<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T | null> {
  try {
    return await readJson(path, schema);
  } catch {
    return null;
  }
}

function mergeManifestProgress(
  existing: StateManifest | null,
  incoming: StateManifest,
): StateManifest {
  if (!existing) return incoming;
  return {
    ...incoming,
    lastAppliedChapter: Math.max(existing.lastAppliedChapter, incoming.lastAppliedChapter),
    migrationWarnings: [...new Set([
      ...existing.migrationWarnings,
      ...incoming.migrationWarnings,
    ])],
  };
}

function mergeChapterSummaryState(
  existing: ChapterSummariesState | null,
  incoming: ChapterSummariesState,
): ChapterSummariesState {
  const rowsByChapter = new Map<number, ChapterSummariesState["rows"][number]>();
  for (const row of existing?.rows ?? []) {
    rowsByChapter.set(row.chapter, row);
  }
  for (const row of incoming.rows) {
    rowsByChapter.set(row.chapter, row);
  }
  return {
    rows: [...rowsByChapter.values()].sort((left, right) => left.chapter - right.chapter),
  };
}
