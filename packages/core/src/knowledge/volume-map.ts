/**
 * 卷纲解析(knowledge/)—— volume_map.md 是 `## 段N` 散文(不是表),
 * 这里尽力提取每卷的:序号、标题、主题片段、OKR Objective。
 * 注意:每卷的**章节范围**通常未在散文里结构化存储 → 返回时多为 null(属"该存没存",由调用方标注)。
 */

function buildCnNumMap(): Record<string, number> {
  const ones = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const map: Record<string, number> = {};
  for (let i = 1; i <= 9; i++) map[ones[i]!] = i;
  map["十"] = 10;
  for (let i = 1; i <= 9; i++) map["十" + ones[i]!] = 10 + i;
  for (let t = 2; t <= 9; t++) {
    map[ones[t]! + "十"] = t * 10;
    for (let i = 1; i <= 9; i++) map[ones[t]! + "十" + ones[i]!] = t * 10 + i;
  }
  return map;
}
const CN_NUM = buildCnNumMap();

function cnToNum(s: string): number | null {
  const t = s.trim();
  if (/^\d+$/.test(t)) return Number(t);
  return CN_NUM[t] ?? null;
}

export interface VolumeInfo {
  readonly index: number;
  readonly title: string;
  readonly theme?: string;
  readonly objective?: string;
  readonly chapterStart: number | null;
  readonly chapterEnd: number | null;
}

export function parseVolumeMap(md: string): VolumeInfo[] {
  if (!md || !md.trim()) return [];
  const byIndex = new Map<number, { index: number; title: string; theme?: string; objective?: string }>();

  // 第N卷“标题” —— 取首次出现(段1 主题段)
  const titleRe = /第([一二三四五六七八九十百\d]+)卷[“"「『]([^”"」』\n]+?)[”"」』]/g;
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(md)) !== null) {
    const idx = cnToNum(m[1] ?? "");
    if (idx == null || byIndex.has(idx)) continue;
    byIndex.set(idx, { index: idx, title: (m[2] ?? "").trim() });
  }

  // 第N卷 O：Objective(段3 OKR)
  const objRe = /第([一二三四五六七八九十百\d]+)卷\s*O[：:]\s*([^\n]+)/g;
  while ((m = objRe.exec(md)) !== null) {
    const idx = cnToNum(m[1] ?? "");
    if (idx == null) continue;
    const v = byIndex.get(idx);
    if (v && !v.objective) v.objective = (m[2] ?? "").trim();
  }

  return [...byIndex.values()]
    .sort((a, b) => a.index - b.index)
    .map((v) => ({
      index: v.index,
      title: v.title,
      theme: v.theme,
      objective: v.objective,
      chapterStart: null,
      chapterEnd: null,
    }));
}
