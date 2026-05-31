/**
 * 极简 Markdown 表解析(knowledge/ 共用)—— 真相文件里的表(伏笔/支线/情感弧)统一走它。
 * 自动跳过分隔行(`| --- | --- |`),第一行非分隔行作表头。
 */

export interface ParsedTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

function isSeparator(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, "")));
}

export function parseMarkdownTable(md: string): ParsedTable {
  if (!md || !md.trim()) return { headers: [], rows: [] };
  let headers: string[] = [];
  const rows: string[][] = [];
  for (const line of md.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (isSeparator(cells)) continue;
    if (headers.length === 0) {
      headers = cells;
      continue;
    }
    rows.push(cells);
  }
  return { headers, rows };
}

/** 把一行按表头映射成对象(便于按列名取值,容忍列序变化)。 */
export function rowToRecord(headers: readonly string[], row: readonly string[]): Record<string, string> {
  const rec: Record<string, string> = {};
  headers.forEach((h, i) => {
    rec[h] = row[i] ?? "";
  });
  return rec;
}
