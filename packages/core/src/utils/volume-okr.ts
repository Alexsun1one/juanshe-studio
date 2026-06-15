import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface VolumeOkrKr {
  readonly id: string;
  readonly desc: string;
  readonly must_advance_by_chapter: number;
  readonly target_chapters: readonly number[];
}

export interface VolumeOkr {
  readonly volume_index: number;
  readonly title: string;
  readonly start_ch: number;
  readonly end_ch: number;
  readonly objective: string;
  readonly krs: readonly VolumeOkrKr[];
}

export function renderVolumeOkrJson(volumes: ReadonlyArray<VolumeOkr>): string {
  return `${JSON.stringify(volumes.map(normalizeVolumeForWrite), null, 2)}\n`;
}

export async function readVolumeOkrFile(bookDir: string): Promise<ReadonlyArray<VolumeOkr>> {
  const raw = await readFile(join(bookDir, "story", "outline", "volume_okr.json"), "utf-8").catch(() => "");
  return parseVolumeOkrJson(raw);
}

export function findVolumeOkrForChapter(
  volumes: ReadonlyArray<VolumeOkr>,
  chapterNumber: number,
): VolumeOkr | undefined {
  return volumes.find((volume) => chapterNumber >= volume.start_ch && chapterNumber <= volume.end_ch);
}

export function selectVolumeKrForChapter(volume: VolumeOkr, chapterNumber: number): VolumeOkrKr | undefined {
  const sorted = [...volume.krs].sort((left, right) =>
    left.must_advance_by_chapter - right.must_advance_by_chapter,
  );
  return sorted.find((kr) => chapterNumber <= kr.must_advance_by_chapter)
    ?? sorted.find((kr) => kr.target_chapters.some((target) => chapterNumber <= target))
    ?? sorted[sorted.length - 1];
}

export function parseVolumeOkrJson(raw: string): ReadonlyArray<VolumeOkr> {
  if (!raw.trim()) return [];
  try {
    return parseVolumeOkrJsonStrict(raw);
  } catch {
    return [];
  }
}

export function parseVolumeOkrJsonStrict(raw: string): ReadonlyArray<VolumeOkr> {
  if (!raw.trim()) {
    throw new Error("volume_okr.json is empty");
  }
  const parsed = JSON.parse(stripJsonFence(raw)) as unknown;
  const volumes = normalizeVolumeOkrRoot(parsed);
  if (volumes.length === 0) {
    throw new Error("volume_okr.json contains no valid volumes");
  }
  return volumes;
}

export function deriveVolumeOkrFromVolumeMap(params: {
  readonly volumeMap: string;
  readonly targetChapters?: number;
  readonly language?: "zh" | "en";
}): ReadonlyArray<VolumeOkr> {
  const language = params.language ?? (/[一-龥]/.test(params.volumeMap) ? "zh" : "en");
  const sections = extractVolumeSections(params.volumeMap);
  const count = Math.max(1, sections.length || inferVolumeCount(params.volumeMap));
  const ranges = splitChapterRanges(Math.max(1, params.targetChapters ?? 60), count);

  return ranges.map((range, offset) => {
    const section = sections[offset];
    const index = section?.index ?? offset + 1;
    const title = section?.title || defaultVolumeTitle(index, language);
    const objective = extractObjective(section?.body ?? "") || (
      language === "en"
        ? `Advance ${title}'s volume objective.`
        : `推进${title}的卷级目标。`
    );
    const krDescriptions = extractKrDescriptions(section?.body ?? "");
    return {
      volume_index: index,
      title,
      start_ch: range.start,
      end_ch: range.end,
      objective,
      krs: buildKrs({
        volumeIndex: index,
        startCh: range.start,
        endCh: range.end,
        objective,
        descriptions: krDescriptions,
        language,
      }),
    };
  }).sort((a, b) => a.start_ch - b.start_ch);
}

function normalizeVolumeOkrRoot(parsed: unknown): VolumeOkr[] {
  const root = parsed as { volumes?: unknown; volume_okr?: unknown };
  const source = Array.isArray(parsed)
    ? parsed
    : Array.isArray(root.volumes)
      ? root.volumes
      : Array.isArray(root.volume_okr)
        ? root.volume_okr
        : [];

  const volumes: VolumeOkr[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const normalized = normalizeVolumeEntry(source[i], i + 1);
    if (normalized) volumes.push(normalized);
  }
  return volumes.sort((a, b) => a.start_ch - b.start_ch);
}

function normalizeVolumeEntry(value: unknown, fallbackIndex: number): VolumeOkr | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const index = toPositiveInteger(record.volume_index ?? record.index, fallbackIndex);
  const startCh = toPositiveInteger(record.start_ch ?? record.start_chapter ?? record.start, NaN);
  const endCh = toPositiveInteger(record.end_ch ?? record.end_chapter ?? record.end, NaN);
  if (!Number.isFinite(index) || !Number.isFinite(startCh) || !Number.isFinite(endCh)) return null;

  const start = Math.min(startCh, endCh);
  const end = Math.max(startCh, endCh);
  const title = readString(record.title ?? record.name) || `Volume ${index}`;
  const objective = readString(record.objective ?? record.goal) || `Advance ${title}'s volume objective.`;
  const rawKrs = Array.isArray(record.krs) ? record.krs : [];
  const descriptions = rawKrs.map((kr) => {
    if (!kr || typeof kr !== "object") return "";
    const krRecord = kr as Record<string, unknown>;
    return readString(krRecord.desc ?? krRecord.description ?? krRecord.goal);
  }).filter(Boolean);

  const krs = rawKrs.length > 0
    ? rawKrs.map((kr, offset) => normalizeKrEntry(kr, {
        fallbackId: `KR${offset + 1}`,
        fallbackDesc: descriptions[offset] || objective,
        startCh: start,
        endCh: end,
        offset,
        count: rawKrs.length,
      })).filter((kr): kr is VolumeOkrKr => kr !== null)
    : [];

  return {
    volume_index: index,
    title,
    start_ch: start,
    end_ch: end,
    objective,
    krs: krs.length > 0
      ? krs
      : buildKrs({
          volumeIndex: index,
          startCh: start,
          endCh: end,
          objective,
          descriptions,
          language: /[一-龥]/.test(`${title}${objective}`) ? "zh" : "en",
        }),
  };
}

function normalizeKrEntry(value: unknown, params: {
  readonly fallbackId: string;
  readonly fallbackDesc: string;
  readonly startCh: number;
  readonly endCh: number;
  readonly offset: number;
  readonly count: number;
}): VolumeOkrKr | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const segment = segmentForKr(params.startCh, params.endCh, params.offset, params.count);
  const targetChapters = normalizeTargetChapters(record.target_chapters, segment.start, segment.end);
  const mustAdvance = toPositiveInteger(record.must_advance_by_chapter, segment.end);
  return {
    id: normalizeKrId(readString(record.id) || params.fallbackId, params.offset + 1),
    desc: readString(record.desc ?? record.description ?? record.goal) || params.fallbackDesc,
    must_advance_by_chapter: clampChapter(mustAdvance, params.startCh, params.endCh),
    target_chapters: targetChapters,
  };
}

function normalizeVolumeForWrite(volume: VolumeOkr): VolumeOkr {
  const start = Math.min(volume.start_ch, volume.end_ch);
  const end = Math.max(volume.start_ch, volume.end_ch);
  return {
    volume_index: Math.max(1, Math.floor(volume.volume_index)),
    title: volume.title.trim() || `Volume ${volume.volume_index}`,
    start_ch: start,
    end_ch: end,
    objective: volume.objective.trim(),
    krs: volume.krs.map((kr, offset) => ({
      id: normalizeKrId(kr.id, offset + 1),
      desc: kr.desc.trim(),
      must_advance_by_chapter: clampChapter(kr.must_advance_by_chapter, start, end),
      target_chapters: normalizeTargetChapters(kr.target_chapters, start, end),
    })),
  };
}

function buildKrs(params: {
  readonly volumeIndex: number;
  readonly startCh: number;
  readonly endCh: number;
  readonly objective: string;
  readonly descriptions: ReadonlyArray<string>;
  readonly language: "zh" | "en";
}): VolumeOkrKr[] {
  const descriptions = params.descriptions.length > 0
    ? params.descriptions.slice(0, 3)
    : [1, 2, 3].map((index) => params.language === "en"
        ? `Advance volume ${params.volumeIndex} objective checkpoint ${index}: ${params.objective}`
        : `推进第${params.volumeIndex}卷目标检查点${index}：${params.objective}`);

  return descriptions.map((desc, offset) => {
    const segment = segmentForKr(params.startCh, params.endCh, offset, descriptions.length);
    return {
      id: `KR${offset + 1}`,
      desc,
      must_advance_by_chapter: segment.end,
      target_chapters: pickTargetChapters(segment.start, segment.end),
    };
  });
}

function extractVolumeSections(volumeMap: string): Array<{ readonly index: number; readonly title: string; readonly body: string }> {
  const lines = volumeMap.split("\n");
  const sections: Array<{ index: number; title: string; startLine: number; endLine: number }> = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!.replace(/^[#>\-*\s]+/, "").trim();
    const match = line.match(/(?:第\s*([一二三四五六七八九十百千万零〇\d]+)\s*卷|Volume\s+(\d+))/i);
    if (!match) continue;
    const index = parseVolumeIndex(match[1] ?? match[2]) ?? sections.length + 1;
    sections.push({
      index,
      title: extractTitleFromLine(line, index),
      startLine: lineIndex,
      endLine: lines.length,
    });
  }
  for (let i = 0; i < sections.length - 1; i += 1) {
    sections[i]!.endLine = sections[i + 1]!.startLine;
  }
  return sections.map((section) => ({
    index: section.index,
    title: section.title,
    body: lines.slice(section.startLine, section.endLine).join("\n"),
  }));
}

function inferVolumeCount(volumeMap: string): number {
  const matches = [...volumeMap.matchAll(/(?:第\s*([一二三四五六七八九十百千万零〇\d]+)\s*卷|Volume\s+(\d+))/gi)];
  const indexes = matches
    .map((match) => parseVolumeIndex(match[1] ?? match[2]))
    .filter((value): value is number => value !== null);
  return indexes.length > 0 ? Math.max(...indexes) : 1;
}

function splitChapterRanges(targetChapters: number, count: number): Array<{ readonly start: number; readonly end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 1;
  for (let offset = 0; offset < count; offset += 1) {
    const remainingVolumes = count - offset;
    const remainingChapters = targetChapters - start + 1;
    const size = Math.max(1, Math.ceil(remainingChapters / remainingVolumes));
    const end = offset === count - 1 ? targetChapters : Math.min(targetChapters, start + size - 1);
    ranges.push({ start, end });
    start = end + 1;
  }
  return ranges;
}

function segmentForKr(startCh: number, endCh: number, offset: number, count: number): { readonly start: number; readonly end: number } {
  const total = Math.max(1, endCh - startCh + 1);
  const segmentStart = startCh + Math.floor((total * offset) / count);
  const segmentEnd = startCh + Math.floor((total * (offset + 1)) / count) - 1;
  return {
    start: clampChapter(segmentStart, startCh, endCh),
    end: clampChapter(Math.max(segmentStart, segmentEnd), startCh, endCh),
  };
}

function normalizeTargetChapters(value: unknown, startCh: number, endCh: number): number[] {
  if (Array.isArray(value)) {
    const chapters = value
      .map((entry) => toPositiveInteger(entry, NaN))
      .filter((entry) => Number.isFinite(entry))
      .map((entry) => clampChapter(entry, startCh, endCh));
    if (chapters.length > 0) return [...new Set(chapters)].sort((a, b) => a - b);
  }
  return pickTargetChapters(startCh, endCh);
}

function pickTargetChapters(startCh: number, endCh: number): number[] {
  const mid = startCh + Math.floor((endCh - startCh) / 2);
  return [...new Set([startCh, mid, endCh])].sort((a, b) => a - b);
}

function extractObjective(section: string): string | null {
  for (const line of section.split("\n")) {
    const cleaned = line.replace(/^[#>\-*\s]+/, "").trim();
    const match = cleaned.match(/(?:Objective|卷级目标|目标|O)\s*[=:：-]\s*(.+)$/i);
    if (match?.[1]) return trimSentence(match[1]);
  }
  return null;
}

function extractKrDescriptions(section: string): string[] {
  const result: string[] = [];
  for (const line of section.split("\n")) {
    const cleaned = line.replace(/^[#>\-*\s]+/, "").trim();
    const match = cleaned.match(/(?:KR\s*\d+|Key\s*Result\s*\d+|关键结果\s*\d*)\s*[=:：-]?\s*(.+)$/i);
    if (match?.[1]) result.push(trimSentence(match[1]));
  }
  return result.filter(Boolean);
}

function trimSentence(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[。；;]\s*$/, "").trim();
}

function extractTitleFromLine(line: string, index: number): string {
  const zh = line.match(/(第\s*[一二三四五六七八九十百千万零〇\d]+\s*卷)(?:[：:\s-]+([^（(\n]+))?/);
  if (zh) {
    const title = zh[2]?.trim();
    return title ? `${zh[1]!.replace(/\s+/g, "")}：${title}` : zh[1]!.replace(/\s+/g, "");
  }
  const en = line.match(/(Volume\s+\d+)(?:[：:\s-]+([^(\n]+))?/i);
  if (en) {
    const title = en[2]?.trim();
    return title ? `${en[1]}: ${title}` : en[1]!;
  }
  return `Volume ${index}`;
}

function defaultVolumeTitle(index: number, language: "zh" | "en"): string {
  return language === "en" ? `Volume ${index}` : `第${index}卷`;
}

function normalizeKrId(value: string, fallbackIndex: number): string {
  const trimmed = value.trim();
  const number = trimmed.match(/\d+/)?.[0] ?? String(fallbackIndex);
  return `KR${number}`;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.floor(value));
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Math.max(1, Number(value.trim()));
  return fallback;
}

function clampChapter(value: number, startCh: number, endCh: number): number {
  return Math.max(startCh, Math.min(endCh, Math.floor(value)));
}

function stripJsonFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
}

function parseVolumeIndex(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (trimmed === "十") return 10;
  const tens = trimmed.match(/^([二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (tens) {
    return (tens[1] ? digits[tens[1]]! * 10 : 10) + (tens[2] ? digits[tens[2]]! : 0);
  }
  return digits[trimmed] ?? null;
}
