import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { atomicWriteFile } from "./fs-atomic.js";

export interface TruthWriteLogger {
  readonly warn?: (message: string) => void;
}

const storyWriteLocks = new Map<string, Promise<void>>();

export async function withStoryTruthWriteLock<T>(
  storyDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = resolve(storyDir);
  const previous = storyWriteLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const cleanup = run.then(
    () => undefined,
    () => undefined,
  );
  storyWriteLocks.set(key, cleanup);

  try {
    return await run;
  } finally {
    if (storyWriteLocks.get(key) === cleanup) {
      storyWriteLocks.delete(key);
    }
  }
}

export async function upsertChapterSummaryFile(params: {
  readonly storyDir: string;
  readonly chapterNumber: number;
  readonly summaryMarkdown: string;
  readonly language: "zh" | "en";
  readonly logger?: TruthWriteLogger;
}): Promise<void> {
  await withStoryTruthWriteLock(params.storyDir, () => upsertChapterSummaryFileUnlocked(params));
}

export async function upsertChapterSummaryFileUnlocked(params: {
  readonly storyDir: string;
  readonly chapterNumber: number;
  readonly summaryMarkdown: string;
  readonly language: "zh" | "en";
  readonly logger?: TruthWriteLogger;
}): Promise<void> {
  const rows = extractChapterSummaryRows(params.summaryMarkdown, params.chapterNumber);
  if (rows.length === 0) return;

  const summaryPath = join(params.storyDir, "chapter_summaries.md");
  await mkdir(params.storyDir, { recursive: true });
  const existing = await readFile(summaryPath, "utf-8").catch(() => "");
  const next = renderUpsertedChapterSummaries(existing, rows, params.language);
  await atomicWriteFile(summaryPath, next);

  const verified = await readFile(summaryPath, "utf-8").catch(() => "");
  if (hasChapterSummaryRow(verified, params.chapterNumber)) return;

  params.logger?.warn?.(
    params.language === "en"
      ? `[truth-write] chapter_summaries.md self-heal: row for chapter ${params.chapterNumber} missing after atomic write; retrying upsert.`
      : `[truth-write] chapter_summaries.md 自愈：第${params.chapterNumber}章行在原子写后缺失，重试 upsert。`,
  );
  const healed = renderUpsertedChapterSummaries(verified, rows, params.language);
  await atomicWriteFile(summaryPath, healed);
}

export function extractChapterSummaryRows(
  summaryMarkdown: string,
  chapterNumber: number,
): string[] {
  return summaryMarkdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => parseMarkdownChapterNumber(line) === chapterNumber)
    .map(normalizeMarkdownTableRow);
}

export function hasChapterSummaryRow(markdown: string, chapterNumber: number): boolean {
  return markdown
    .split("\n")
    .some((line) => parseMarkdownChapterNumber(line) === chapterNumber);
}

export function extractChapterSummaryNumbers(markdown: string): number[] {
  return markdown
    .split("\n")
    .map(parseMarkdownChapterNumber)
    .filter((value): value is number => value !== null);
}

export function parseMarkdownChapterNumber(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  if (isMarkdownSeparatorRow(trimmed)) return null;
  const raw = trimmed.split("|")[1]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function renderUpsertedChapterSummaries(
  existingMarkdown: string,
  newRows: ReadonlyArray<string>,
  language: "zh" | "en",
): string {
  const rowByChapter = new Map<number, string>();
  const nonDataLines: string[] = [];

  for (const line of existingMarkdown.split("\n")) {
    const chapter = parseMarkdownChapterNumber(line);
    if (chapter === null) {
      if (line.trim().length > 0 || nonDataLines.length > 0) {
        nonDataLines.push(line);
      }
      continue;
    }
    rowByChapter.set(chapter, normalizeMarkdownTableRow(line));
  }

  for (const row of newRows) {
    const chapter = parseMarkdownChapterNumber(row);
    if (chapter !== null) {
      rowByChapter.set(chapter, normalizeMarkdownTableRow(row));
    }
  }

  const scaffold = ensureChapterSummaryScaffold(nonDataLines, language);
  const rows = [...rowByChapter.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, row]) => row);

  return [...trimTrailingEmptyLines(scaffold), ...rows, ""].join("\n");
}

function ensureChapterSummaryScaffold(lines: string[], language: "zh" | "en"): string[] {
  const cleaned = trimTrailingEmptyLines(lines.length > 0 ? lines : defaultChapterSummaryHeader(language));
  const hasHeader = cleaned.some((line) => /^\|\s*(章节|Chapter)\s*\|/i.test(line.trim()));
  if (!hasHeader) {
    return [
      ...cleaned,
      ...(cleaned.length > 0 ? [""] : []),
      ...defaultChapterSummaryHeader(language).slice(2),
    ];
  }
  return cleaned;
}

export function normalizeMarkdownTableRow(row: string): string {
  const trimmed = row.trim();
  if (!trimmed.startsWith("|")) return `| ${trimmed} |`;
  if (!trimmed.endsWith("|")) return `${trimmed} |`;
  return trimmed;
}

function isMarkdownSeparatorRow(line: string): boolean {
  const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell) || /^-+$/.test(cell));
}

function defaultChapterSummaryHeader(language: "zh" | "en"): string[] {
  return language === "en"
    ? [
        "# Chapter Summaries",
        "",
        "| Chapter | Title | Characters | Key Events | State Changes | Hook Activity | Mood | Chapter Type |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ]
    : [
        "# 章节摘要",
        "",
        "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
        "|------|------|----------|----------|----------|----------|----------|----------|",
      ];
}

function trimTrailingEmptyLines(lines: ReadonlyArray<string>): string[] {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1]!.trim().length === 0) {
    copy.pop();
  }
  return copy;
}
