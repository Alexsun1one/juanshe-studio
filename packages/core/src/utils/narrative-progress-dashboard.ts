import { parseVolumeMap } from "../knowledge/volume-map.js";

export type MacroChapterRole =
  | "hook-payoff-cluster"
  | "mainline-acceleration"
  | "build-up"
  | "climax"
  | "aftermath";

interface VolumeRange {
  readonly index: number;
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

export interface NarrativeProgressDashboard {
  readonly completedChapters: number;
  readonly targetChapters: number;
  readonly wholeBookPercent: number;
  readonly currentChapter: number;
  readonly volumeName: string;
  readonly volumeStart: number;
  readonly volumeEnd: number;
  readonly volumePercent: number;
  readonly macroRole: MacroChapterRole;
  readonly memoSection: string;
  readonly promptBlock: string;
}

export function buildNarrativeProgressDashboard(params: {
  readonly chapterNumber: number;
  readonly targetChapters: number;
  readonly volumeMap: string;
  readonly overdueHookCount?: number;
  readonly language?: "zh" | "en";
}): NarrativeProgressDashboard {
  const targetChapters = Math.max(1, Math.trunc(params.targetChapters || params.chapterNumber));
  const currentChapter = Math.max(1, Math.trunc(params.chapterNumber));
  const completedChapters = Math.max(0, Math.min(currentChapter - 1, targetChapters));
  const wholeBookPercent = percent(completedChapters, targetChapters);
  const volume = resolveCurrentVolume(params.volumeMap, currentChapter, targetChapters);
  const volumePercent = percent(currentChapter - volume.start + 1, volume.end - volume.start + 1);
  const macroRole = chooseMacroRole({
    wholeBookPercent,
    volumePercent,
    overdueHookCount: params.overdueHookCount ?? 0,
  });
  const rendered = renderDashboard({
    completedChapters,
    targetChapters,
    wholeBookPercent,
    currentChapter,
    volumeName: volume.name,
    volumeStart: volume.start,
    volumeEnd: volume.end,
    volumePercent,
    macroRole,
    language: params.language ?? "zh",
  });

  return {
    completedChapters,
    targetChapters,
    wholeBookPercent,
    currentChapter,
    volumeName: volume.name,
    volumeStart: volume.start,
    volumeEnd: volume.end,
    volumePercent,
    macroRole,
    memoSection: rendered.memoSection,
    promptBlock: rendered.promptBlock,
  };
}

function chooseMacroRole(params: {
  readonly wholeBookPercent: number;
  readonly volumePercent: number;
  readonly overdueHookCount: number;
}): MacroChapterRole {
  if (params.overdueHookCount >= 2) return "hook-payoff-cluster";
  if (params.wholeBookPercent >= 85) return "mainline-acceleration";
  if (params.volumePercent >= 82) return "climax";
  if (params.volumePercent <= 12 && params.wholeBookPercent > 8) return "aftermath";
  return "build-up";
}

function renderDashboard(input: {
  readonly completedChapters: number;
  readonly targetChapters: number;
  readonly wholeBookPercent: number;
  readonly currentChapter: number;
  readonly volumeName: string;
  readonly volumeStart: number;
  readonly volumeEnd: number;
  readonly volumePercent: number;
  readonly macroRole: MacroChapterRole;
  readonly language: "zh" | "en";
}): { readonly memoSection: string; readonly promptBlock: string } {
  if (input.language === "en") {
    const role = roleLabel(input.macroRole, "en");
    const memoSection = [
      "## Whole-book progress dashboard",
      `- Whole book: ${input.completedChapters}/${input.targetChapters} chapters completed (${input.wholeBookPercent}%). Current chapter: ${input.currentChapter}.`,
      `- Current volume: ${input.volumeName} (${input.volumeStart}-${input.volumeEnd}); volume progress ${input.volumePercent}%.`,
      `- Macro role for this chapter: ${role}.`,
      "- Hard instruction: the memo goal, hook ledger, ending change, writer draft, and revision pass must serve this macro role. Do not turn this chapter into an isolated polished fragment.",
    ].join("\n");
    return {
      memoSection,
      promptBlock: `${memoSection}\n\nTreat the macro role as a higher-level constraint than local scene convenience.`,
    };
  }

  const role = roleLabel(input.macroRole, "zh");
  const memoSection = [
    "## 全书进度仪表盘",
    `- 全书进度：已完成 ${input.completedChapters}/${input.targetChapters} 章（${input.wholeBookPercent}%），本章是第 ${input.currentChapter} 章。`,
    `- 当前卷：${input.volumeName}（${input.volumeStart}-${input.volumeEnd} 章），卷内推进 ${input.volumePercent}%。`,
    `- 本章宏观角色：${role}。`,
    "- 硬指令：memo goal、hook 账、章尾变化、写手正文和修稿方向都必须服务这个宏观角色，不得把本章写成孤立的高质量片段。",
  ].join("\n");
  return {
    memoSection,
    promptBlock: `${memoSection}\n\n请把“本章宏观角色”当作高于局部场景便利的结构约束。`,
  };
}

function roleLabel(role: MacroChapterRole, language: "zh" | "en"): string {
  const labels: Record<MacroChapterRole, { zh: string; en: string }> = {
    "hook-payoff-cluster": { zh: "回收伏笔群 / hook-payoff cluster", en: "hook payoff cluster" },
    "mainline-acceleration": { zh: "冲刺主线 / mainline acceleration", en: "mainline acceleration" },
    "build-up": { zh: "build-up / 蓄压推进", en: "build-up" },
    "climax": { zh: "climax / 卷内爆发", en: "climax" },
    "aftermath": { zh: "aftermath / 后效沉积", en: "aftermath" },
  };
  return labels[role][language];
}

function percent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function resolveCurrentVolume(volumeMap: string, chapterNumber: number, targetChapters: number): VolumeRange {
  const explicit = parseExplicitVolumeRanges(volumeMap);
  const hit = explicit.find((volume) => chapterNumber >= volume.start && chapterNumber <= volume.end);
  if (hit) return hit;
  if (explicit.length > 0) {
    const nearest = explicit
      .slice()
      .sort((a, b) => Math.abs(chapterNumber - clamp(chapterNumber, a.start, a.end)) - Math.abs(chapterNumber - clamp(chapterNumber, b.start, b.end)))[0];
    if (nearest) return nearest;
  }

  const proseVolumes = parseVolumeMap(volumeMap);
  const volumeCount = Math.max(1, proseVolumes.length || inferVolumeCount(targetChapters));
  const span = Math.max(1, Math.ceil(targetChapters / volumeCount));
  const index = Math.min(volumeCount, Math.max(1, Math.ceil(chapterNumber / span)));
  const start = (index - 1) * span + 1;
  const end = Math.min(targetChapters, index * span);
  const title = proseVolumes.find((volume) => volume.index === index)?.title;
  return {
    index,
    name: title ? `第${index}卷「${title}」` : `第${index}卷`,
    start,
    end,
  };
}

function parseExplicitVolumeRanges(volumeMap: string): VolumeRange[] {
  const ranges: VolumeRange[] = [];
  const seen = new Set<number>();
  for (const rawLine of volumeMap.split("\n")) {
    const line = rawLine.trim();
    const range = line.match(/(?:第\s*([一二三四五六七八九十百千万零〇\d]+)\s*卷|Volume\s+(\d+))[^()\n（]*(?:[（(]|chapter\s*range[:：]?\s*)?\s*(?:Ch\.?|Chapter)?\s*(\d+)\s*[-~–—]\s*(\d+)\s*章?/i);
    if (!range) continue;
    const index = parseVolumeIndex(range[1] ?? range[2]);
    if (!index || seen.has(index)) continue;
    const start = Number(range[3]);
    const end = Number(range[4]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    seen.add(index);
    ranges.push({
      index,
      name: extractVolumeName(line, index),
      start: Math.min(start, end),
      end: Math.max(start, end),
    });
  }
  return ranges.sort((a, b) => a.index - b.index);
}

function extractVolumeName(line: string, index: number): string {
  const zh = line.match(/(第\s*[一二三四五六七八九十百千万零〇\d]+\s*卷)(?:[：:\s-]+([^（(\n]+))?/);
  if (zh) {
    const title = zh[2]?.trim();
    return title ? `${zh[1]!.replace(/\s+/g, "")}「${title}」` : zh[1]!.replace(/\s+/g, "");
  }
  const en = line.match(/(Volume\s+\d+)(?:[：:\s-]+([^(\n]+))?/i);
  if (en) {
    const title = en[2]?.trim();
    return title ? `${en[1]} "${title}"` : en[1]!;
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

function inferVolumeCount(targetChapters: number): number {
  if (targetChapters >= 160) return 6;
  if (targetChapters >= 100) return 4;
  if (targetChapters >= 60) return 3;
  return 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
