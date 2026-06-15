export const CADENCE_WINDOW_DEFAULTS = {
  // 4 太窄:写第 N 章只看得到最近 4 章摘要 → 记不住更早用过的开篇/招牌意象 → 续写反复重铺
  // 同一套"时间+天气+便利店"开场、逐字复用"抹布叠成方块"。拉到 10,让写手/规划师看到更长的前文。
  summaryLookback: 10,
  englishVarianceLookback: 24,
  recentBoundaryPatternBodies: 2,
} as const;

export function resolveCadenceSummaryLookback(params: {
  readonly currentChapter?: number;
  readonly krCycleChapters?: number;
} = {}): number {
  const cycleLookback = params.krCycleChapters && params.krCycleChapters > 0
    ? Math.ceil(params.krCycleChapters)
    : 0;
  const longFormLookback = params.currentChapter && params.currentChapter >= 80
    ? 24
    : params.currentChapter && params.currentChapter >= 50
      ? 16
      : CADENCE_WINDOW_DEFAULTS.summaryLookback;
  return Math.max(
    CADENCE_WINDOW_DEFAULTS.summaryLookback,
    Math.min(30, Math.max(longFormLookback, cycleLookback)),
  );
}

export const CADENCE_PRESSURE_THRESHOLDS = {
  scene: {
    highCount: 3,
    mediumCount: 2,
    mediumWindowFloor: 4,
  },
  mood: {
    highCount: 3,
    mediumCount: 2,
    mediumWindowFloor: 4,
  },
  title: {
    minimumRepeatedCount: 2,
    highCount: 3,
    mediumCount: 2,
    mediumWindowFloor: 4,
  },
  textDiversity: {
    lookback: 6,
    endingShapeHighCount: 3,
    registerHighCount: 3,
    tempoHighCount: 3,
    repeatedActionCount: 2,
    repeatedPortraitCount: 2,
  },
} as const;

export const LONG_SPAN_FATIGUE_THRESHOLDS = {
  boundarySimilarityFloor: 0.72,
  boundarySentenceMinLength: 18,
  boundaryPatternMinBodies: 3,
} as const;

export function resolveCadencePressure(params: {
  readonly count: number;
  readonly total: number;
  readonly highThreshold: number;
  readonly mediumThreshold: number;
  readonly mediumWindowFloor: number;
}): "medium" | "high" | undefined {
  if (params.count >= params.highThreshold) {
    return "high";
  }
  if (params.count >= params.mediumThreshold && params.total >= params.mediumWindowFloor) {
    return "medium";
  }
  return undefined;
}
