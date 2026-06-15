import { describe, expect, it } from "vitest";
import { analyzeChapterCadence } from "../utils/chapter-cadence.js";
import { resolveCadenceSummaryLookback } from "../utils/cadence-policy.js";

describe("resolveCadenceSummaryLookback", () => {
  it("keeps the early-book default but expands for long-form KR cycles", () => {
    expect(resolveCadenceSummaryLookback({ currentChapter: 20 })).toBe(10);
    expect(resolveCadenceSummaryLookback({ currentChapter: 60 })).toBe(16);
    expect(resolveCadenceSummaryLookback({ currentChapter: 90 })).toBe(24);
    expect(resolveCadenceSummaryLookback({ currentChapter: 40, krCycleChapters: 18 })).toBe(18);
    expect(resolveCadenceSummaryLookback({ currentChapter: 120, krCycleChapters: 40 })).toBe(30);
  });
});

describe("analyzeChapterCadence", () => {
  it("uses the expanded long-form window when currentChapter is high", () => {
    const rows = Array.from({ length: 24 }, (_value, index) => ({
      chapter: index + 1,
      title: `Title ${index + 1}`,
      mood: "平稳",
      chapterType: index === 0 ? "铺垫" : "追查",
    }));

    const early = analyzeChapterCadence({ rows, language: "zh", currentChapter: 30 });
    const late = analyzeChapterCadence({ rows, language: "zh", currentChapter: 90 });

    expect(early.scenePressure?.streak).toBe(10);
    expect(late.scenePressure?.streak).toBe(23);
  });
});
