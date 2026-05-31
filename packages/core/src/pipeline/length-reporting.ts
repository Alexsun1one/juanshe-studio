/**
 * 章节字数报告：硬区间越界告警 + 字数遥测装配。
 *
 * 这两个都是与 pipeline 实例状态无关的纯函数：给定字数与 LengthSpec，产出可读告警 /
 * 结构化遥测。从巨型的 runner.ts 抽出独立成模块，便于单测与复用（runner 仍在三处调用点直接调用）。
 */
import { isOutsideHardRange, type LengthLanguage } from "../utils/length-metrics.js";
import type { LengthSpec, LengthTelemetry } from "../models/length-governance.js";

function languageFromLengthSpec(lengthSpec: Pick<LengthSpec, "countingMode">): LengthLanguage {
  return lengthSpec.countingMode === "en_words" ? "en" : "zh";
}

/**
 * 一次字数归一化后仍越出硬区间时，产出一条可读告警；在区间内则返回空数组。
 * 语言依据 LengthSpec 的计数模式自动选择（en_words → 英文，其余 → 中文）。
 */
export function buildLengthWarnings(
  chapterNumber: number,
  finalCount: number,
  lengthSpec: LengthSpec,
): string[] {
  if (!isOutsideHardRange(finalCount, lengthSpec)) {
    return [];
  }
  const language = languageFromLengthSpec(lengthSpec);
  return [
    language === "en"
      ? `Chapter ${chapterNumber} remains outside hard range (${lengthSpec.hardMin}-${lengthSpec.hardMax}, actual ${finalCount}) after a single normalization pass.`
      : `第${chapterNumber}章经过一次字数归一化后仍超出硬区间（${lengthSpec.hardMin}-${lengthSpec.hardMax}，实际 ${finalCount}）。`,
  ];
}

/** 把各阶段字数 + 区间装配成结构化遥测，供前端字数仪表 / 复盘使用。 */
export function buildLengthTelemetry(params: {
  readonly lengthSpec: LengthSpec;
  readonly writerCount: number;
  readonly postWriterNormalizeCount: number;
  readonly postReviseCount: number;
  readonly finalCount: number;
  readonly normalizeApplied: boolean;
  readonly lengthWarning: boolean;
}): LengthTelemetry {
  return {
    target: params.lengthSpec.target,
    softMin: params.lengthSpec.softMin,
    softMax: params.lengthSpec.softMax,
    hardMin: params.lengthSpec.hardMin,
    hardMax: params.lengthSpec.hardMax,
    countingMode: params.lengthSpec.countingMode,
    writerCount: params.writerCount,
    postWriterNormalizeCount: params.postWriterNormalizeCount,
    postReviseCount: params.postReviseCount,
    finalCount: params.finalCount,
    normalizeApplied: params.normalizeApplied,
    lengthWarning: params.lengthWarning,
  };
}
