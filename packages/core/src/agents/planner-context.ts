import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseMarkdownTableRows } from "../utils/story-markdown.js";
import { readCharacterContext } from "../utils/outline-paths.js";
import { readBookRules as readStructuredBookRules } from "./rules-reader.js";
import type { StoredHook } from "../state/memory-db.js";
import { withStoryTruthWriteLock } from "../utils/story-truth-writer.js";

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Phase 5: prefer roles/ directory; fall back to legacy character_matrix.md.
 * storyDir is <bookDir>/story, so the caller indirectly points us at bookDir
 * via dirname().
 */
export async function readCharacterMatrix(storyDir: string): Promise<string> {
  const bookDir = dirname(storyDir);
  return readCharacterContext(bookDir, "");
}

export async function readSubplotBoard(storyDir: string): Promise<string> {
  return readOrEmpty(join(storyDir, "subplot_board.md"));
}

export async function readEmotionalArcs(storyDir: string): Promise<string> {
  return readOrEmpty(join(storyDir, "emotional_arcs.md"));
}

export async function readPendingHooks(storyDir: string): Promise<string> {
  return readOrEmpty(join(storyDir, "pending_hooks.md"));
}

export async function readLastAuditFeedback(storyDir: string): Promise<string> {
  const jsonRaw = await readOrEmpty(join(storyDir, "runtime", "last_audit_feedback.json"));
  const jsonBlock = formatLastAuditFeedbackJson(jsonRaw);
  if (jsonBlock) {
    return jsonBlock;
  }

  const legacyDrift = await readOrEmpty(join(storyDir, "audit_drift.md"));
  return formatLegacyAuditDrift(legacyDrift);
}

export async function clearLastAuditFeedback(storyDir: string): Promise<void> {
  await withStoryTruthWriteLock(storyDir, async () => {
    await rm(join(storyDir, "runtime", "last_audit_feedback.json"), { force: true }).catch(() => undefined);
  });
}

export async function readVolumeCadenceGuidance(
  storyDir: string,
  language: "zh" | "en" = "zh",
): Promise<string> {
  const [cadenceRaw, krRaw] = await Promise.all([
    readOrEmpty(join(storyDir, "volume_chapter_cadence.md")),
    readOrEmpty(join(storyDir, "progress_against_volume_kr.json")),
  ]);
  return formatVolumeCadenceGuidance(cadenceRaw, krRaw, language);
}

export async function readBrief(storyDir: string): Promise<string> {
  return readOrEmpty(join(storyDir, "brief.md"));
}

/**
 * Render the structured book rules (protagonist / prohibitions / genreLock /
 * behavioral constraints) as a compact markdown block for the planner prompt.
 *
 * Phase 5 cleanup #3: reads the YAML frontmatter via readStructuredBookRules
 * (which prefers story_frame.md and falls back to legacy book_rules.md).
 * Returns "" when no structured rules are defined — the planner template
 * provides its own placeholder for that case.
 */
export async function readBookRules(storyDir: string): Promise<string> {
  const bookDir = dirname(storyDir);
  const parsed = await readStructuredBookRules(bookDir);
  if (!parsed) return "";

  const { rules, body } = parsed;
  const lines: string[] = [];

  if (rules.protagonist) {
    const proto = rules.protagonist;
    const personality = proto.personalityLock.join("、");
    const constraints = proto.behavioralConstraints.join("、");
    lines.push(`- 主角 ${proto.name}${personality ? ` / 人设锁：${personality}` : ""}${constraints ? ` / 行为约束：${constraints}` : ""}`);
  }

  if (rules.prohibitions.length > 0) {
    lines.push("- 本书禁忌：");
    for (const p of rules.prohibitions) {
      lines.push(`  - ${p}`);
    }
  }

  if (rules.genreLock) {
    const forbidden = rules.genreLock.forbidden.join("、");
    lines.push(`- 题材锁：${rules.genreLock.primary}${forbidden ? ` / 禁止混入：${forbidden}` : ""}`);
  }

  if (rules.fanficMode) {
    lines.push(`- 同人模式：${rules.fanficMode}`);
  }

  const trimmedBody = body.trim();
  // The body holds narrative guidance prose (e.g. 叙事视角). Include it verbatim
  // so the planner sees the same text as before the cleanup.
  if (trimmedBody) {
    lines.push("", trimmedBody);
  }

  return lines.join("\n").trim();
}

/**
 * Grab the last N row(s) from chapter_summaries.md formatted as markdown
 * table. Returns original table slice (with header) so the planner gets
 * column meaning implicitly.
 */
export function formatRecentSummaries(
  chapterSummariesRaw: string,
  chapterNumber: number,
  limit: number,
): string {
  const rows = parseMarkdownTableRows(chapterSummariesRaw)
    .filter((row) => /^\d+$/.test(row[0] ?? ""))
    .filter((row) => parseInt(row[0]!, 10) < chapterNumber)
    .sort((a, b) => parseInt(a[0]!, 10) - parseInt(b[0]!, 10));

  const recent = rows.slice(-limit);
  if (recent.length === 0) {
    return "（暂无前章摘要）";
  }

  const header = "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = recent.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return [header, divider, body].join("\n");
}

/**
 * Option A: temporarily compose current_arc prose from subplot_board.md
 * active rows + emotional_arcs.md recent rows. Phase 8 will replace this
 * source with a dedicated tier2_current_arc.md file.
 */
export function composeCurrentArcProse(
  subplotBoardRaw: string,
  emotionalArcsRaw: string,
  chapterNumber: number,
): string {
  const activeSubplots = extractActiveSubplotLines(subplotBoardRaw);
  const recentArcs = extractRecentEmotionalArcLines(emotionalArcsRaw, chapterNumber, 3);

  const parts: string[] = [];
  if (activeSubplots.length > 0) {
    parts.push("活跃支线：\n" + activeSubplots.map((line) => `- ${line}`).join("\n"));
  }
  if (recentArcs.length > 0) {
    parts.push("近期情感线：\n" + recentArcs.map((line) => `- ${line}`).join("\n"));
  }
  if (parts.length === 0) {
    return "（暂无 arc 数据——可能是新书起始阶段）";
  }
  return parts.join("\n\n");
}

export function buildDormantSubplotRevivalHints(
  subplotBoardRaw: string,
  chapterNumber: number,
  language: "zh" | "en" = "zh",
): string {
  const dormantRows = extractDormantSubplotRows(subplotBoardRaw, chapterNumber);
  const activeCount = countActiveSubplots(subplotBoardRaw);
  const shouldPrompt = chapterNumber >= 12 && activeCount <= 1 && dormantRows.length > 0;
  if (!shouldPrompt) {
    return language === "en"
      ? "(no dormant subplot needs revival right now)"
      : "（暂无需要复活的 dormant 支线）";
  }

  const heading = language === "en"
    ? `Active subplot count is ${activeCount}. Consider reviving up to 2 dormant subplots if they can serve this chapter's mainline:`
    : `当前活跃支线 ${activeCount} 条。若能服务本章主线，可复活以下 dormant 支线中的至多 2 条：`;
  return [
    heading,
    ...dormantRows.slice(0, 2).map((row) => {
      const silenceText = row.silentChapters > 0
        ? (language === "en" ? `, dormant ${row.silentChapters} ch` : `，沉寂 ${row.silentChapters} 章`)
        : "";
      const statusText = row.status ? (language === "en" ? `, status=${row.status}` : `，状态=${row.status}`) : "";
      return `- ${row.id}: ${row.description}${statusText}${silenceText}`;
    }),
  ].join("\n");
}

function extractActiveSubplotLines(raw: string): string[] {
  const rows = parseMarkdownTableRows(raw);
  if (rows.length === 0) {
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("-"))
      .map((line) => line.replace(/^-\s*/, ""))
      .filter(Boolean)
      .slice(0, 6);
  }
  return rows
    .filter((row) => !/^(id|subplot_id|subplot|status|状态)$/i.test(row[0] ?? ""))
    .filter((row) => {
      const status = (row.find((cell) => /进行|推进|高压|激活|activ|progress|partial/i.test(cell)) ?? "");
      const dormant = row.find((cell) => /暂稳待续|暂挂|dormant|paused/i.test(cell));
      return Boolean(status) && !dormant;
    })
    .map((row) => row.filter(Boolean).join(" | "))
    .slice(0, 6);
}

interface DormantSubplotRow {
  readonly id: string;
  readonly description: string;
  readonly status: string;
  readonly silentChapters: number;
}

function countActiveSubplots(raw: string): number {
  return extractActiveSubplotLines(raw).length;
}

function extractDormantSubplotRows(raw: string, chapterNumber: number): DormantSubplotRow[] {
  const rows = parseMarkdownTableRows(raw);
  if (rows.length === 0) {
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /暂稳待续|暂挂|dormant|paused/i.test(line))
      .map((line, index) => ({
        id: `S${String(index + 1).padStart(3, "0")}`,
        description: line.replace(/^-\s*/, ""),
        status: inferDormantStatus(line),
        silentChapters: 0,
      }))
      .slice(0, 2);
  }

  return rows
    .filter((row) => !/^(id|subplot_id|subplot|status|状态)$/i.test(row[0] ?? ""))
    .filter((row) => row.some((cell) => /暂稳待续|暂挂|dormant|paused/i.test(cell)))
    .map((row, index) => {
      const id = (row[0] ?? "").trim() || `S${String(index + 1).padStart(3, "0")}`;
      const status = inferDormantStatus(row.join(" | "));
      const lastTouched = inferLastTouchedChapter(row, chapterNumber);
      const explicitSilence = inferExplicitSilentChapters(row);
      return {
        id,
        description: row.slice(1).filter(Boolean).join(" | ") || row.filter(Boolean).join(" | "),
        status,
        silentChapters: explicitSilence ?? (lastTouched > 0 ? Math.max(0, chapterNumber - lastTouched) : 0),
      };
    })
    .sort((a, b) => b.silentChapters - a.silentChapters);
}

function inferDormantStatus(text: string): string {
  const match = text.match(/(暂稳待续|暂挂|dormant|paused)/i);
  return match?.[1] ?? "dormant";
}

function inferExplicitSilentChapters(row: ReadonlyArray<string>): number | undefined {
  const numericCells = row
    .map((cell) => cell.trim())
    .filter((cell) => /^\d{1,4}$/.test(cell))
    .map((cell) => parseInt(cell, 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (numericCells.length === 0) return undefined;
  return Math.max(...numericCells);
}

function inferLastTouchedChapter(row: ReadonlyArray<string>, chapterNumber: number): number {
  const candidates = row
    .flatMap((cell) => Array.from(cell.matchAll(/(?:第\s*)?(\d{1,4})\s*章?/g)).map((match) => parseInt(match[1]!, 10)))
    .filter((value) => Number.isFinite(value) && value > 0 && value < chapterNumber);
  if (candidates.length === 0) return 0;
  return Math.max(...candidates);
}

function extractRecentEmotionalArcLines(raw: string, chapterNumber: number, limit: number): string[] {
  const rows = parseMarkdownTableRows(raw);
  if (rows.length === 0) {
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("-"))
      .slice(-limit)
      .map((line) => line.replace(/^-\s*/, ""));
  }
  // emotional_arcs.md column layout: 角色 | 章节 | 情绪状态 | 触发事件 | 强度 | 弧线方向
  // Chapter number lives in column index 1 (row[1]), not column 0.
  return rows
    .filter((row) => /^\d+$/.test(row[1] ?? ""))
    .filter((row) => parseInt(row[1]!, 10) < chapterNumber)
    .slice(-limit)
    .map((row) => row.filter(Boolean).join(" | "));
}

const CHARACTER_MATRIX_HEADER_CELLS = /^(角色|character|name|核心标签|与主角关系|relation)$/i;

function isLikelyHeaderRow(row: ReadonlyArray<string>): boolean {
  return row.some((cell) => CHARACTER_MATRIX_HEADER_CELLS.test(cell.trim()));
}

/**
 * Extract the protagonist row from character_matrix.md. Protagonist is detected
 * by a cell in the 与主角关系 column matching "主角本人" / "主角" / "protagonist"
 * (case-insensitive). Falls back to the first non-header data row if no
 * explicit match is found — that row is almost always the protagonist by
 * convention.
 */
export function extractProtagonistRow(characterMatrixRaw: string): string {
  const rows = parseMarkdownTableRows(characterMatrixRaw);
  const protagonist = rows.find((row) =>
    row.some((cell) => /^(主角本人|主角|protagonist)$/i.test(cell.trim())),
  );
  if (protagonist) {
    return `| ${protagonist.join(" | ")} |`;
  }
  const firstDataRow = rows.find((row) => !isLikelyHeaderRow(row));
  if (firstDataRow) {
    return `| ${firstDataRow.join(" | ")} |`;
  }
  return "（未找到主角行——请检查 character_matrix.md）";
}

const OPPONENT_PATTERNS = /敌对|对手|阻力|opponent|antagonist|foe/i;
const COLLABORATOR_PATTERNS = /协力|盟友|临时助力|ally|collaborator|mentor/i;

export function extractOpponentRows(characterMatrixRaw: string, limit: number): string {
  return extractRowsByRelation(characterMatrixRaw, OPPONENT_PATTERNS, limit, "（暂无明确对手登场）");
}

export function extractCollaboratorRows(characterMatrixRaw: string, limit: number): string {
  return extractRowsByRelation(characterMatrixRaw, COLLABORATOR_PATTERNS, limit, "（暂无明确协作者登场）");
}

function extractRowsByRelation(
  characterMatrixRaw: string,
  pattern: RegExp,
  limit: number,
  emptyText: string,
): string {
  const rows = parseMarkdownTableRows(characterMatrixRaw)
    .filter((row) => row.some((cell) => pattern.test(cell)))
    .filter((row) => !row.some((cell) => /^(主角|protagonist)$/i.test(cell.trim())))
    .slice(0, limit);
  if (rows.length === 0) {
    return emptyText;
  }
  return rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}

const RELEVANT_THREAD_STATUS_PATTERN = /activat|partial_payoff|推进|高压|open|progress/i;
const STALE_STATUS_PATTERN = /resolved|deferred|dormant|暂稳待续|暂挂|已回收/i;

export function extractRelevantThreads(pendingHooksRaw: string, subplotBoardRaw: string): string {
  const hookRows = parseMarkdownTableRows(pendingHooksRaw)
    .filter((row) => !/^(hook_id)$/i.test(row[0] ?? ""))
    .filter((row) => row.some((cell) => RELEVANT_THREAD_STATUS_PATTERN.test(cell)))
    .filter((row) => !row.some((cell) => STALE_STATUS_PATTERN.test(cell)))
    .map((row) => `- ${row[0]}: ${row.slice(1).filter(Boolean).join(" | ")}`);

  const subplotRows = parseMarkdownTableRows(subplotBoardRaw)
    .filter((row) => !/^(id|subplot_id|subplot)$/i.test(row[0] ?? ""))
    .filter((row) => row.some((cell) => RELEVANT_THREAD_STATUS_PATTERN.test(cell)))
    .filter((row) => !row.some((cell) => STALE_STATUS_PATTERN.test(cell)))
    .map((row) => `- ${row[0]}: ${row.slice(1).filter(Boolean).join(" | ")}`);

  const lines = [...hookRows, ...subplotRows];
  if (lines.length === 0) {
    return "（暂无活跃线索）";
  }
  return lines.join("\n");
}

interface LastAuditFeedbackJson {
  readonly schema_version?: number;
  readonly source_chapter?: number;
  readonly issues?: ReadonlyArray<{
    readonly severity?: string;
    readonly category?: string;
    readonly description?: string;
    readonly suggestion?: string;
  }>;
}

interface VolumeKrProgressJson {
  readonly schema_version?: number;
  readonly current_volume?: {
    readonly index?: number;
    readonly name?: string;
    readonly start_chapter?: number;
    readonly end_chapter?: number;
  };
  readonly next_chapter?: number;
  readonly kr_progress?: ReadonlyArray<{
    readonly kr_id?: string;
    readonly description?: string;
    readonly expected_chapters?: number;
    readonly elapsed_chapters?: number;
    readonly content_progress_percent?: number;
    readonly status?: string;
  }>;
}

function formatLastAuditFeedbackJson(raw: string): string {
  if (!raw.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as LastAuditFeedbackJson;
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.filter((issue) => String(issue.description ?? "").trim())
      : [];
    if (issues.length === 0) return "";
    const chapterText = Number.isFinite(parsed.source_chapter)
      ? `第 ${parsed.source_chapter} 章`
      : "上一章";
    return [
      `${chapterText} 审计反馈（planner 必须转成下章修复动作）：`,
      ...issues.slice(0, 6).map((issue) => {
        const severity = String(issue.severity ?? "warning");
        const category = String(issue.category ?? "audit");
        const description = String(issue.description ?? "").trim();
        const suggestion = String(issue.suggestion ?? "").trim();
        return suggestion
          ? `- [${severity}] ${category}: ${description}；修复：${suggestion}`
          : `- [${severity}] ${category}: ${description}`;
      }),
    ].join("\n");
  } catch {
    return "";
  }
}

function formatVolumeCadenceGuidance(
  cadenceRaw: string,
  krRaw: string,
  language: "zh" | "en",
): string {
  const krLines = formatKrProgressGuidance(krRaw, language);
  const cadenceLines = formatCadenceRows(cadenceRaw, language);
  if (krLines.length === 0 && cadenceLines.length === 0) return "";

  const heading = language === "en"
    ? "## Tier-2 volume cadence / KR progress"
    : "## 卷内章级节奏 / KR 进度";
  return [
    heading,
    ...krLines,
    ...cadenceLines,
  ].join("\n");
}

function formatKrProgressGuidance(raw: string, language: "zh" | "en"): string[] {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as VolumeKrProgressJson;
    const krs = Array.isArray(parsed.kr_progress) ? parsed.kr_progress : [];
    const pressure = krs
      .filter((kr) => /^(lagging|not_started)$/i.test(String(kr.status ?? "")))
      .slice(0, 4);
    const selected = pressure.length > 0 ? pressure : krs.slice(0, 3);
    if (selected.length === 0) return [];

    const volume = parsed.current_volume?.name
      ? String(parsed.current_volume.name)
      : (language === "en" ? "current volume" : "当前卷");
    const header = language === "en"
      ? `- KR tracker (${volume}, next ch ${parsed.next_chapter ?? "?"}):`
      : `- KR 跟踪（${volume}，下一章 ${parsed.next_chapter ?? "?"}）：`;
    return [
      header,
      ...selected.map((kr) => {
        const status = String(kr.status ?? "unknown");
        const progress = `${kr.elapsed_chapters ?? "?"}/${kr.expected_chapters ?? "?"}, ${kr.content_progress_percent ?? 0}%`;
        const accel = /^(lagging|not_started)$/i.test(status)
          ? (language === "en" ? " ACCELERATE this chapter." : " 本章要加速。")
          : "";
        return `  - ${kr.kr_id ?? "KR"} [${status}] ${progress}: ${kr.description ?? ""}${accel}`;
      }),
    ];
  } catch {
    return [];
  }
}

function formatCadenceRows(raw: string, language: "zh" | "en"): string[] {
  const rows = parseMarkdownTableRows(raw)
    .filter((row) => /^\d+$/.test(row[0] ?? ""))
    .slice(0, 6);
  if (rows.length === 0) return [];
  return [
    language === "en"
      ? "- Upcoming beat map (compressed):"
      : "- 未来章级节奏细纲（压缩）：",
    ...rows.map((row) => `  - ch${row[0]}: ${row[1] ?? ""}; ${row[2] ?? ""}; ${row[3] ?? ""}`),
  ];
}

function formatLegacyAuditDrift(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return [
    "上一章审计纠偏（legacy audit_drift.md，planner 必须转成下章修复动作）：",
    ...trimmed
      .split("\n")
      .map((line) => line.replace(/^>\s?/, "").trim())
      .filter((line) => line.startsWith("- [") || line.startsWith("["))
      .slice(0, 6),
  ].join("\n");
}

/**
 * Phase 9-2: render stale hooks that the planner MUST dispose of in this
 * chapter's memo ("## 本章 hook 账"). These are already filtered by
 * computeRecyclableHooks; here we just format them for the prompt.
 *
 * Language switch mirrors the rest of the planner prompt: zh by default,
 * en for English books.
 */
export function formatRecyclableHooks(
  hooks: ReadonlyArray<StoredHook>,
  chapterNumber: number,
  language: "zh" | "en" = "zh",
): string {
  if (hooks.length === 0) {
    return language === "en"
      ? "(no stale hooks — the ledger is clean)"
      : "（暂无陈旧 hook——账本干净）";
  }

  const topSlice = hooks.slice(0, 6);
  const lines = topSlice.map((hook) => {
    const lastTouch = Math.max(hook.startChapter, hook.lastAdvancedChapter);
    const silence = lastTouch <= 0 ? chapterNumber : Math.max(0, chapterNumber - lastTouch);
    const payoff = hook.expectedPayoff?.trim() || hook.notes?.trim() || "";
    const core = hook.coreHook === true ? (language === "en" ? " [core]" : " [核心]") : "";
    return language === "en"
      ? `- ${hook.hookId} "${payoff}" — status=${hook.status}, silent ${silence} ch${core}`
      : `- ${hook.hookId} "${payoff}" — 状态=${hook.status}，已沉默 ${silence} 章${core}`;
  });

  const header = language === "en"
    ? "The planner MUST place each of these under advance / resolve / defer in the hook ledger (deferring requires an explicit reason):"
    : "规划时必须把以下每个 hook 放入 advance / resolve / defer（若 defer，必须写出理由）：";
  return [header, ...lines].join("\n");
}
