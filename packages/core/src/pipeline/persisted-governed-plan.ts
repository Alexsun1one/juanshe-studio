import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import YAML from "js-yaml";
import type { PlanChapterOutput } from "../agents/planner.js";
import { ChapterIntentSchema, type ChapterIntent } from "../models/input-governance.js";
import { parseMemo, PlannerParseError } from "../utils/chapter-memo-parser.js";

/**
 * Phase 4: persisted governed plans are stored as a single markdown file
 * containing YAML frontmatter (memo + intent extensions + plannerInputs)
 * followed by the memo body (7 required sections).
 *
 * File path: `story/runtime/chapter-NNNN.plan.md`
 *
 * The sibling `chapter-NNNN.intent.md` file stays as a human-readable
 * render — it is not parsed back. We keep it in sync by regenerating
 * downstream, but only this `.plan.md` is authoritative for restore.
 *
 * If parse fails for any reason we return null and let the runner re-invoke
 * the planner. We never try to partially reconstruct — silent degradation
 * is worse than re-planning.
 */

function planPath(bookDir: string, chapterNumber: number): string {
  const runtimeDir = join(bookDir, "story", "runtime");
  const padded = String(chapterNumber).padStart(4, "0");
  return join(runtimeDir, `chapter-${padded}.plan.md`);
}

function intentPath(bookDir: string, chapterNumber: number): string {
  const runtimeDir = join(bookDir, "story", "runtime");
  const padded = String(chapterNumber).padStart(4, "0");
  return join(runtimeDir, `chapter-${padded}.intent.md`);
}

export async function savePersistedPlan(
  bookDir: string,
  plan: PlanChapterOutput,
): Promise<void> {
  const { intent, memo, plannerInputs } = plan;
  const frontmatter = {
    chapter: memo.chapter,
    goal: memo.goal,
    isGoldenOpening: memo.isGoldenOpening,
    servesKr: memo.servesKr,
    threadRefs: memo.threadRefs,
    intent: {
      goal: intent.goal,
      outlineNode: intent.outlineNode,
      arcContext: intent.arcContext,
      mustKeep: intent.mustKeep,
      mustAvoid: intent.mustAvoid,
      styleEmphasis: intent.styleEmphasis,
    },
    plannerInputs: [...plannerInputs],
    plannerInputSnapshots: await snapshotPlannerInputs(bookDir, plannerInputs),
  };
  const yaml = YAML.dump(frontmatter, { lineWidth: -1 });
  const content = `---\n${yaml}---\n${memo.body}\n`;
  await writeFile(planPath(bookDir, memo.chapter), content, "utf-8");
}

export async function loadPersistedPlan(
  bookDir: string,
  chapterNumber: number,
): Promise<PlanChapterOutput | null> {
  let raw: string;
  try {
    raw = await readFile(planPath(bookDir, chapterNumber), "utf-8");
  } catch {
    return loadLegacyIntentPlan(bookDir, chapterNumber);
  }

  const match = raw.trim().match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  let fm: unknown;
  try {
    fm = YAML.load(match[1]!);
  } catch {
    return null;
  }
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) return null;
  const f = fm as Record<string, unknown>;

  if (typeof f.chapter !== "number" || f.chapter !== chapterNumber) return null;
  if (typeof f.isGoldenOpening !== "boolean") return null;
  if (!f.intent || typeof f.intent !== "object") return null;

  // Reconstruct memo via the same strict parser planner uses. This guarantees
  // the 7 required section headings are still present — any drift triggers
  // re-planning (null return).
  let memo;
  try {
    const reconstructed = `---\n${YAML.dump({
      chapter: f.chapter,
      goal: f.goal,
      servesKr: f.servesKr,
      threadRefs: f.threadRefs,
    })}---\n${match[2]!}`;
    memo = parseMemo(reconstructed, chapterNumber, f.isGoldenOpening);
  } catch (error) {
    if (error instanceof PlannerParseError) return null;
    throw error;
  }

  let intent: ChapterIntent;
  try {
    intent = ChapterIntentSchema.parse({
      chapter: chapterNumber,
      ...(f.intent as Record<string, unknown>),
    });
  } catch {
    return null;
  }

  const plannerInputs = Array.isArray(f.plannerInputs)
    ? f.plannerInputs.filter((value): value is string => typeof value === "string")
    : [];
  if (!(await plannerInputSnapshotsStillFresh(bookDir, f.plannerInputSnapshots, plannerInputs))) {
    return null;
  }

  // intentMarkdown is a display artifact — read the sibling .intent.md so we
  // surface the same content downstream consumers expect. If it's missing we
  // fall back to the memo body, which is usable but less rich.
  let intentMarkdown = memo.body;
  try {
    intentMarkdown = await readFile(intentPath(bookDir, chapterNumber), "utf-8");
  } catch {
    // fall through — memo body is a safe default.
  }

  return {
    intent,
    memo,
    intentMarkdown,
    plannerInputs,
    runtimePath: intentPath(bookDir, chapterNumber),
  };
}

type PlannerInputSnapshot = {
  readonly path: string;
  readonly sha256?: string;
  readonly missing?: boolean;
};

async function snapshotPlannerInputs(
  bookDir: string,
  plannerInputs: ReadonlyArray<string>,
): Promise<PlannerInputSnapshot[]> {
  const snapshots: PlannerInputSnapshot[] = [];
  for (const inputPath of plannerInputs) {
    const normalizedPath = normalizePlannerInputPath(bookDir, inputPath);
    const absolutePath = resolvePlannerInputPath(bookDir, normalizedPath);
    try {
      const content = await readFile(absolutePath);
      snapshots.push({
        path: normalizedPath,
        sha256: sha256(content),
      });
    } catch {
      snapshots.push({
        path: normalizedPath,
        missing: true,
      });
    }
  }
  return snapshots;
}

async function plannerInputSnapshotsStillFresh(
  bookDir: string,
  rawSnapshots: unknown,
  plannerInputs: ReadonlyArray<string>,
): Promise<boolean> {
  if (!Array.isArray(rawSnapshots)) {
    return plannerInputs.length === 0;
  }
  const snapshots = rawSnapshots.filter(isPlannerInputSnapshot);
  if (snapshots.length !== plannerInputs.length) return false;

  for (const snapshot of snapshots) {
    const absolutePath = resolvePlannerInputPath(bookDir, snapshot.path);
    try {
      const content = await readFile(absolutePath);
      if (snapshot.missing || sha256(content) !== snapshot.sha256) {
        return false;
      }
    } catch {
      if (!snapshot.missing) return false;
    }
  }
  return true;
}

function isPlannerInputSnapshot(value: unknown): value is PlannerInputSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.path === "string"
    && (typeof item.sha256 === "string" || item.missing === true);
}

function normalizePlannerInputPath(bookDir: string, inputPath: string): string {
  const absolutePath = resolvePlannerInputPath(bookDir, inputPath);
  const relativePath = relative(bookDir, absolutePath).replaceAll("\\", "/");
  return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)
    ? relativePath
    : absolutePath;
}

function resolvePlannerInputPath(bookDir: string, inputPath: string): string {
  return isAbsolute(inputPath) ? inputPath : resolve(bookDir, inputPath);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function loadLegacyIntentPlan(
  _bookDir: string,
  _chapterNumber: number,
): Promise<PlanChapterOutput | null> {
  // Legacy intent artifacts do not carry input freshness metadata. Reusing them
  // after truth files change is exactly how chapters drift from author intent,
  // so v2 planning must re-plan instead of trusting stale legacy caches.
  return null;
}

export function relativeToBookDir(bookDir: string, absolutePath: string): string {
  return relative(bookDir, absolutePath).replaceAll("\\", "/");
}
