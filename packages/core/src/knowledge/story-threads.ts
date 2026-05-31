/**
 * 主线 / 副线 / 伏笔解析(knowledge/)——
 *   - pending_hooks.md:伏笔池(hook_id|起始章节|类型|状态|最近推进|预期回收|回收节奏|备注)
 *   - subplot_board.md:支线看板(支线ID|名称|起始章节|状态|最近推进|角色|备注)
 * 供"大纲与规划"页的主线/副线追踪、以及按章节统计伏笔数。
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

export interface HookEntry {
  readonly id: string;
  readonly startChapter: number | null;
  readonly type: string;
  readonly status: string;
  readonly lastProgress: string;
  readonly expectedPayoff: string;
  readonly pace: string;
  readonly note: string;
}

export function parsePendingHooks(md: string): HookEntry[] {
  const { headers, rows } = parseMarkdownTable(md);
  return rows
    .map((row) => {
      const r = rowToRecord(headers, row);
      return {
        id: pick(r, "hook_id", "ID", "id", "编号"),
        startChapter: firstNumber(pick(r, "起始章节", "起始", "章节")),
        type: pick(r, "类型"),
        status: pick(r, "状态"),
        lastProgress: pick(r, "最近推进", "推进"),
        expectedPayoff: pick(r, "预期回收", "回收"),
        pace: pick(r, "回收节奏", "节奏"),
        note: pick(r, "备注"),
      };
    })
    .filter((h) => h.id);
}

export interface SubplotThread {
  readonly id: string;
  readonly name: string;
  readonly startChapter: number | null;
  readonly status: string;
  readonly lastProgress: string;
  readonly characters: readonly string[];
  readonly note: string;
}

export function parseSubplotBoard(md: string): SubplotThread[] {
  const { headers, rows } = parseMarkdownTable(md);
  return rows
    .map((row) => {
      const r = rowToRecord(headers, row);
      const chars = pick(r, "角色", "人物")
        .split(/[、,，/／|]/)
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        id: pick(r, "支线ID", "ID", "id", "编号"),
        name: pick(r, "名称", "支线", "线"),
        startChapter: firstNumber(pick(r, "起始章节", "起始", "章节")),
        status: pick(r, "状态"),
        lastProgress: pick(r, "最近推进", "推进"),
        characters: chars,
        note: pick(r, "备注"),
      };
    })
    .filter((t) => t.id || t.name);
}

/** 把每个伏笔的起始章节统计成"每章新增伏笔数",供大纲章节卡显示"伏笔 ×N"。 */
export function hooksByStartChapter(hooks: readonly HookEntry[]): Record<number, number> {
  const map: Record<number, number> = {};
  for (const h of hooks) {
    if (h.startChapter != null) map[h.startChapter] = (map[h.startChapter] ?? 0) + 1;
  }
  return map;
}
