/**
 * 情感弧解析器(knowledge/)—— 把 story/emotional_arcs.md 的 markdown 表解析成结构化弧点。
 * 表头:角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向。
 * 强度是**真数据**,用于角色弧光曲线与大纲张力曲线(不再用 index 编)。
 */

export interface EmotionalArcPoint {
  readonly character: string;
  readonly chapter: number | null;
  readonly chapterRaw: string;
  readonly emotion: string;
  readonly trigger: string;
  /** 1-10,解析失败为 null。 */
  readonly intensity: number | null;
  readonly direction: string;
}

function firstNumber(s: string): number | null {
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, "")));
}

/** 解析 emotional_arcs.md 表为弧点数组(自动跳过表头与分隔行)。 */
export function parseEmotionalArcs(md: string): EmotionalArcPoint[] {
  if (!md || !md.trim()) return [];
  const out: EmotionalArcPoint[] = [];
  for (const line of md.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 6) continue;
    if (isSeparatorRow(cells)) continue;
    const character = cells[0] ?? "";
    if (!character || character === "角色") continue;
    out.push({
      character,
      chapter: firstNumber(cells[1] ?? ""),
      chapterRaw: cells[1] ?? "",
      emotion: cells[2] ?? "",
      trigger: cells[3] ?? "",
      intensity: firstNumber(cells[4] ?? ""),
      direction: cells[5] ?? "",
    });
  }
  return out;
}

/** 按角色聚合弧点(按章节升序),供"角色弧光"曲线直接使用。 */
export function groupArcsByCharacter(points: readonly EmotionalArcPoint[]): Record<string, EmotionalArcPoint[]> {
  const map: Record<string, EmotionalArcPoint[]> = {};
  for (const p of points) {
    (map[p.character] ??= []).push(p);
  }
  for (const list of Object.values(map)) {
    list.sort((a, b) => (a.chapter ?? 0) - (b.chapter ?? 0));
  }
  return map;
}

export interface ChapterTension {
  readonly chapter: number;
  /** 该章张力 = 各角色情绪强度峰值(1-10)。 */
  readonly tension: number;
  readonly samples: number;
}

/** 把弧点聚合成"每章张力曲线"(取该章各角色强度峰值)。仅覆盖有弧点的章节(已写章)。 */
export function tensionByChapter(points: readonly EmotionalArcPoint[]): ChapterTension[] {
  const map = new Map<number, number[]>();
  for (const p of points) {
    if (p.chapter == null || p.intensity == null) continue;
    const arr = map.get(p.chapter) ?? [];
    arr.push(p.intensity);
    map.set(p.chapter, arr);
  }
  return [...map.entries()]
    .map(([chapter, vals]) => ({ chapter, tension: Math.max(...vals), samples: vals.length }))
    .sort((a, b) => a.chapter - b.chapter);
}
