/**
 * 章节摘要解析(knowledge/)—— chapter_summaries.md 富表:
 *   章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型
 * 提供大纲章节卡的真摘要,以及每章真·登场角色(用于角色出场统计)。
 */

import { parseMarkdownTable, rowToRecord } from "./markdown-table.js";

function firstNumber(s: string): number | null {
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function pick(rec: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    if (rec[k] != null && rec[k] !== "") return rec[k]!;
  }
  return "";
}

/** 从"出场人物"列抽出干净角色名(去括注、按分隔符拆)。 */
function extractCharacters(cell: string): string[] {
  return cell
    .replace(/[（(][^）)]*[）)]/g, "")
    .split(/[、,，/／]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ChapterSummary {
  readonly chapter: number | null;
  readonly chapterRaw: string;
  readonly title: string;
  readonly characters: readonly string[];
  readonly keyEvents: string;
  readonly stateChanges: string;
  readonly hookDynamics: string;
  readonly mood: string;
  readonly type: string;
}

export function parseChapterSummaries(md: string): ChapterSummary[] {
  const { headers, rows } = parseMarkdownTable(md);
  return rows
    .map((row) => {
      const r = rowToRecord(headers, row);
      const chapterRaw = pick(r, "章节", "章");
      return {
        chapter: firstNumber(chapterRaw),
        chapterRaw,
        title: pick(r, "标题", "章节标题"),
        characters: extractCharacters(pick(r, "出场人物", "人物", "出场")),
        keyEvents: pick(r, "关键事件", "核心事件", "事件"),
        stateChanges: pick(r, "状态变化", "状态"),
        hookDynamics: pick(r, "伏笔动态", "伏笔"),
        mood: pick(r, "情绪基调", "基调", "情绪"),
        type: pick(r, "章节类型", "类型"),
      };
    })
    .filter((c) => c.chapter != null || c.title);
}

/** 统计每个角色的真·出场章数(基于"出场人物"列)。 */
export function appearanceCounts(summaries: readonly ChapterSummary[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const s of summaries) {
    for (const name of s.characters) {
      map[name] = (map[name] ?? 0) + 1;
    }
  }
  return map;
}
