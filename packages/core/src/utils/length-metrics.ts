import type { LengthCountingMode, LengthNormalizeMode, LengthSpec } from "../models/length-governance.js";

export type LengthLanguage = "zh" | "en";

const REFERENCE_TARGET = 2200;
// 收紧到"真按 target":上下都贴近目标字数,超过软上限就压缩,别让章节越写越长。
const SOFT_RANGE_DELTA = 300;        // 下软边(约 0.86× target)
const HARD_RANGE_DELTA = 600;        // 下硬边(约 0.73× target)
const SOFT_UPPER_DELTA = 440;        // 上软边:约 1.2× target,超过就触发压缩
const HARD_UPPER_DELTA = 1100;       // 上硬边:约 1.5× target,超过算"离谱超长"并告警

export function countChapterLength(
  content: string,
  countingMode: LengthCountingMode,
): number {
  const normalized = stripMarkdownMetadata(content);

  if (countingMode === "en_words") {
    const words = normalized.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g);
    return words?.length ?? 0;
  }

  return normalized.replace(/\s+/g, "").length;
}

export function resolveLengthCountingMode(
  language: LengthLanguage = "zh",
): LengthCountingMode {
  return language === "en" ? "en_words" : "zh_chars";
}

export function formatLengthCount(
  count: number,
  countingMode: LengthCountingMode,
): string {
  return countingMode === "en_words" ? `${count} words` : `${count}字`;
}

export function buildLengthSpec(
  target: number,
  language: LengthLanguage = "zh",
): LengthSpec {
  const softDeltaLow = scaleRangeDelta(target, SOFT_RANGE_DELTA);
  const hardDeltaLow = Math.max(softDeltaLow, scaleRangeDelta(target, HARD_RANGE_DELTA));
  const softDeltaHigh = scaleRangeDelta(target, SOFT_UPPER_DELTA);
  const hardDeltaHigh = Math.max(softDeltaHigh, scaleRangeDelta(target, HARD_UPPER_DELTA));
  const softMin = Math.max(1, target - softDeltaLow);
  const softMax = target + softDeltaHigh;
  const hardMin = Math.max(1, target - hardDeltaLow);
  const hardMax = target + hardDeltaHigh;

  return {
    target,
    softMin,
    softMax,
    hardMin,
    hardMax,
    countingMode: resolveLengthCountingMode(language),
    normalizeMode: "none",
  };
}

function scaleRangeDelta(target: number, referenceDelta: number): number {
  return Math.max(1, Math.floor((target * referenceDelta) / REFERENCE_TARGET));
}

export function isOutsideSoftRange(
  count: number,
  spec: Pick<LengthSpec, "softMin" | "softMax">,
): boolean {
  return count < spec.softMin || count > spec.softMax;
}

export function isOutsideHardRange(
  count: number,
  spec: Pick<LengthSpec, "hardMin" | "hardMax">,
): boolean {
  return count < spec.hardMin || count > spec.hardMax;
}

export function chooseNormalizeMode(
  count: number,
  spec: Pick<LengthSpec, "softMin" | "softMax">,
): LengthNormalizeMode {
  if (count < spec.softMin) return "expand";
  if (count > spec.softMax) return "compress";
  return "none";
}

function stripMarkdownMetadata(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "").split("\n");
  const proseLines: string[] = [];
  let index = 0;

  if (lines[index]?.trim() === "---") {
    index += 1;
    while (index < lines.length && lines[index]?.trim() !== "---") {
      index += 1;
    }
    if (index < lines.length) {
      index += 1;
    }
  }

  let inFence = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      continue;
    }
    if (trimmed === "---" || trimmed === "...") {
      continue;
    }

    proseLines.push(line);
  }

  return proseLines.join("\n");
}
