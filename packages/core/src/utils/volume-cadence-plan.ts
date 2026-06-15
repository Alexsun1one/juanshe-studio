import { parseChapterSummariesMarkdown } from "./story-markdown.js";

export interface VolumeCadenceFileSet {
  readonly cadenceMarkdown: string;
  readonly krProgressJson: string;
}

interface VolumeRange {
  readonly index: number;
  readonly name: string;
  readonly startCh: number;
  readonly endCh: number;
}

interface VolumeKr {
  readonly id: string;
  readonly volumeIndex: number;
  readonly volumeName: string;
  readonly description: string;
}

interface KrProgress {
  readonly volume_index: number;
  readonly volume_name: string;
  readonly kr_id: string;
  readonly description: string;
  readonly expected_chapters: number;
  readonly elapsed_chapters: number;
  readonly content_progress_percent: number;
  readonly status: "on_track" | "lagging" | "not_started" | "done";
}

export function buildVolumeCadenceFileSet(params: {
  readonly volumeMap: string;
  readonly chapterSummaries: string;
  readonly language?: "zh" | "en";
  readonly futureWindow?: number;
}): VolumeCadenceFileSet | null {
  const volumes = parseVolumeRanges(params.volumeMap);
  if (volumes.length === 0) return null;

  const summaries = parseChapterSummariesMarkdown(params.chapterSummaries);
  const maxWrittenChapter = summaries.reduce((max, summary) => Math.max(max, summary.chapter), 0);
  const nextChapter = Math.max(1, maxWrittenChapter + 1);
  const currentVolume = volumes.find((volume) => nextChapter >= volume.startCh && nextChapter <= volume.endCh)
    ?? volumes.find((volume) => maxWrittenChapter >= volume.startCh && maxWrittenChapter <= volume.endCh)
    ?? volumes[0]!;
  const window = Math.max(10, Math.min(20, params.futureWindow ?? 16));
  const futureEnd = Math.min(currentVolume.endCh, nextChapter + window - 1);
  const krs = parseVolumeKrs(params.volumeMap, volumes);
  const currentKrs = krs.filter((kr) => kr.volumeIndex === currentVolume.index);
  const progress = buildKrProgress({
    volume: currentVolume,
    krs: currentKrs,
    summaries,
  });
  const language = params.language ?? "zh";

  return {
    cadenceMarkdown: renderCadenceMarkdown({
      volume: currentVolume,
      nextChapter,
      futureEnd,
      progress,
      language,
    }),
    krProgressJson: `${JSON.stringify({
      schema_version: 1,
      generated_from: {
        volume_map: "story/outline/volume_map.md",
        chapter_summaries: "story/chapter_summaries.md",
      },
      current_volume: {
        index: currentVolume.index,
        name: currentVolume.name,
        start_chapter: currentVolume.startCh,
        end_chapter: currentVolume.endCh,
      },
      max_written_chapter: maxWrittenChapter,
      next_chapter: nextChapter,
      kr_progress: progress,
    }, null, 2)}\n`,
  };
}

function buildKrProgress(params: {
  readonly volume: VolumeRange;
  readonly krs: ReadonlyArray<VolumeKr>;
  readonly summaries: ReturnType<typeof parseChapterSummariesMarkdown>;
}): KrProgress[] {
  const volumeSummaries = params.summaries.filter(
    (summary) => summary.chapter >= params.volume.startCh && summary.chapter <= params.volume.endCh,
  );
  const elapsedChapters = volumeSummaries.length;
  const expectedPerKr = Math.max(3, Math.ceil((params.volume.endCh - params.volume.startCh + 1) / Math.max(1, params.krs.length || 3)));
  const krs = params.krs.length > 0
    ? params.krs
    : [1, 2, 3].map((index) => ({
        id: `KR${index}`,
        volumeIndex: params.volume.index,
        volumeName: params.volume.name,
        description: `未结构化 KR${index}`,
      }));

  return krs.map((kr) => {
    const matched = volumeSummaries.filter((summary) =>
      includesKrSignal(summary.events, kr) ||
      includesKrSignal(summary.stateChanges, kr) ||
      includesKrSignal(summary.hookActivity, kr) ||
      includesKrSignal(summary.chapterType, kr),
    ).length;
    const contentProgressPercent = Math.min(100, Math.round((matched / expectedPerKr) * 100));
    const timePercent = Math.min(100, Math.round((elapsedChapters / expectedPerKr) * 100));
    const status = contentProgressPercent >= 100
      ? "done"
      : matched === 0
        ? "not_started"
        : timePercent >= 120 && contentProgressPercent < 50
          ? "lagging"
          : "on_track";
    return {
      volume_index: kr.volumeIndex,
      volume_name: kr.volumeName,
      kr_id: kr.id,
      description: kr.description,
      expected_chapters: expectedPerKr,
      elapsed_chapters: elapsedChapters,
      content_progress_percent: contentProgressPercent,
      status,
    };
  });
}

function includesKrSignal(text: string, kr: VolumeKr): boolean {
  const haystack = text.toLowerCase();
  if (haystack.includes(kr.id.toLowerCase())) return true;
  return tokenizeKr(kr.description).some((token) => haystack.includes(token.toLowerCase()));
}

function tokenizeKr(description: string): string[] {
  const tokens = description
    .split(/[，。；;、,\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !/^(完成|发现|拿到|成为|推进|建立|锁定|first|the|and)$/i.test(token));
  return tokens.slice(0, 4);
}

function renderCadenceMarkdown(input: {
  readonly volume: VolumeRange;
  readonly nextChapter: number;
  readonly futureEnd: number;
  readonly progress: ReadonlyArray<KrProgress>;
  readonly language: "zh" | "en";
}): string {
  const header = input.language === "en"
    ? "# Tier-2 Volume Chapter Cadence"
    : "# 卷内章级节奏细纲";
  const rows: string[] = [
    input.language === "en"
      ? "| chapter | macro_role | KR focus | required movement |"
      : "| 章节 | 宏观角色 | KR 焦点 | 必须发生的推进 |",
    "| --- | --- | --- | --- |",
  ];
  const krs = input.progress.length > 0 ? input.progress : [];
  for (let chapter = input.nextChapter; chapter <= input.futureEnd; chapter += 1) {
    const volumePercent = (chapter - input.volume.startCh + 1) / Math.max(1, input.volume.endCh - input.volume.startCh + 1);
    const role = chapter === input.futureEnd || volumePercent >= 0.85
      ? "climax"
      : volumePercent <= 0.2
        ? "build-up"
        : chapter % 5 === 0
          ? "payoff/checkpoint"
          : "build-up";
    const kr = chooseKrForChapter(krs, chapter - input.volume.startCh);
    const movement = kr?.status === "lagging"
      ? "加速补 KR：耗章超标但内容进度滞后"
      : kr
        ? `推进 ${kr.kr_id}：${kr.description}`
        : "推进当前卷级目标";
    rows.push(`| ${chapter} | ${role} | ${kr?.kr_id ?? "KR"} | ${escapeCell(movement)} |`);
  }

  const progressLines = input.progress.map((kr) =>
    `- ${kr.kr_id}: ${kr.status}, elapsed ${kr.elapsed_chapters}/${kr.expected_chapters}, content ${kr.content_progress_percent}% — ${kr.description}`,
  );
  return [
    header,
    "",
    `> ${input.volume.name} (${input.volume.startCh}-${input.volume.endCh}); next ${input.nextChapter}-${input.futureEnd}.`,
    "",
    ...rows,
    "",
    input.language === "en" ? "## KR Progress Signals" : "## KR 进度信号",
    ...(progressLines.length > 0 ? progressLines : ["- none"]),
    "",
  ].join("\n");
}

function chooseKrForChapter(krs: ReadonlyArray<KrProgress>, offset: number): KrProgress | undefined {
  if (krs.length === 0) return undefined;
  const lagging = krs.find((kr) => kr.status === "lagging" || kr.status === "not_started");
  if (lagging) return lagging;
  return krs[offset % krs.length];
}

function parseVolumeRanges(volumeMap: string): VolumeRange[] {
  const volumes: VolumeRange[] = [];
  const seen = new Set<number>();
  const rangePattern = /(?:第\s*([一二三四五六七八九十百千万零〇\d]+)\s*卷|Volume\s+(\d+))[^()\n（]*(?:[（(]|range[:：]?\s*)?\s*(?:第|Ch\.?|Chapter)?\s*(\d+)\s*[-~–—]\s*(\d+)\s*章?/i;
  const rangeOnlyPattern = /(?:范围|区间|range|chapters?)?\s*[：:]?\s*[（(]?\s*(?:第|Ch\.?|Chapter)?\s*(\d+)\s*[-~–—]\s*(\d+)\s*章?/i;
  let pending: { readonly index: number; readonly name: string } | undefined;
  for (const rawLine of volumeMap.split("\n")) {
    const line = rawLine.replace(/^[#>\-*\s]+/, "").trim();
    const match = line.match(rangePattern);
    if (match) {
      const index = parseVolumeIndex(match[1] ?? match[2]);
      const startCh = Number(match[3]);
      const endCh = Number(match[4]);
      if (!index || seen.has(index) || !Number.isFinite(startCh) || !Number.isFinite(endCh)) continue;
      seen.add(index);
      volumes.push({
        index,
        name: extractVolumeName(line, index),
        startCh: Math.min(startCh, endCh),
        endCh: Math.max(startCh, endCh),
      });
      pending = undefined;
      continue;
    }

    const volumeMatch = line.match(/(?:第\s*([一二三四五六七八九十百千万零〇\d]+)\s*卷|Volume\s+(\d+))/i);
    if (volumeMatch) {
      const index = parseVolumeIndex(volumeMatch[1] ?? volumeMatch[2]);
      pending = index && !seen.has(index)
        ? { index, name: extractVolumeName(line, index) }
        : undefined;
      continue;
    }

    if (pending && /\d+\s*[-~–—]\s*\d+/.test(line)) {
      const range = line.match(rangeOnlyPattern);
      const startCh = Number(range?.[1]);
      const endCh = Number(range?.[2]);
      if (!Number.isFinite(startCh) || !Number.isFinite(endCh)) continue;
      seen.add(pending.index);
      volumes.push({
        index: pending.index,
        name: pending.name,
        startCh: Math.min(startCh, endCh),
        endCh: Math.max(startCh, endCh),
      });
      pending = undefined;
    }
  }
  return volumes.sort((a, b) => a.startCh - b.startCh);
}

function parseVolumeKrs(volumeMap: string, volumes: ReadonlyArray<VolumeRange>): VolumeKr[] {
  const result: VolumeKr[] = [];
  let currentVolume: VolumeRange | undefined;
  for (const rawLine of volumeMap.split("\n")) {
    const line = rawLine.replace(/^[#>\-*\s]+/, "").trim();
    const volumeMatch = line.match(/(?:第\s*([一二三四五六七八九十百千万零〇\d]+)\s*卷|Volume\s+(\d+))/i);
    if (volumeMatch) {
      const index = parseVolumeIndex(volumeMatch[1] ?? volumeMatch[2]);
      currentVolume = volumes.find((volume) => volume.index === index);
    }
    if (!currentVolume) continue;
    const krMatch = line.match(/(KR\s*\d+|Key\s*Result\s*\d+|关键结果\s*\d+)\s*[=:：-]?\s*(.+)$/i);
    if (!krMatch) continue;
    const krNumber = krMatch[1]?.match(/\d+/)?.[0] ?? String(result.length + 1);
    const description = (krMatch[2] ?? "").trim();
    if (!description) continue;
    result.push({
      id: `KR${krNumber}`,
      volumeIndex: currentVolume.index,
      volumeName: currentVolume.name,
      description,
    });
  }
  return result;
}

function extractVolumeName(line: string, index: number): string {
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

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}
