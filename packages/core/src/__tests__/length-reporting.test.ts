import { describe, expect, it } from "vitest";
import { buildLengthWarnings, buildLengthTelemetry } from "../pipeline/length-reporting.js";
import type { LengthSpec } from "../models/length-governance.js";

const zhSpec: LengthSpec = {
  target: 3000,
  softMin: 2400,
  softMax: 3600,
  hardMin: 2000,
  hardMax: 4500,
  countingMode: "zh_chars",
  normalizeMode: "none",
};

describe("buildLengthWarnings", () => {
  it("returns no warning when inside the hard range", () => {
    expect(buildLengthWarnings(3, 3000, zhSpec)).toEqual([]);
  });

  it("warns (zh) when below hard min after one normalization pass", () => {
    const out = buildLengthWarnings(3, 100, zhSpec);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("第3章");
    expect(out[0]).toContain("2000-4500");
    expect(out[0]).toContain("100");
  });

  it("warns (en) when the counting mode is en_words", () => {
    const enSpec: LengthSpec = { ...zhSpec, countingMode: "en_words" };
    const out = buildLengthWarnings(7, 99999, enSpec);
    expect(out[0]).toContain("Chapter 7");
    expect(out[0]).toContain("outside hard range");
  });
});

describe("buildLengthTelemetry", () => {
  it("assembles the spec + per-stage counts into a telemetry record", () => {
    const t = buildLengthTelemetry({
      lengthSpec: zhSpec,
      writerCount: 2800,
      postWriterNormalizeCount: 2950,
      postReviseCount: 3010,
      finalCount: 3010,
      normalizeApplied: true,
      lengthWarning: false,
    });
    expect(t).toEqual({
      target: 3000,
      softMin: 2400,
      softMax: 3600,
      hardMin: 2000,
      hardMax: 4500,
      countingMode: "zh_chars",
      writerCount: 2800,
      postWriterNormalizeCount: 2950,
      postReviseCount: 3010,
      finalCount: 3010,
      normalizeApplied: true,
      lengthWarning: false,
    });
  });
});
