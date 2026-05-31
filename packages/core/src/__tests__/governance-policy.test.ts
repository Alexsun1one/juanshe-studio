import { describe, expect, it } from "vitest";
import { buildGovernanceRecommendation, shouldTriggerGovernance } from "../pipeline/governance-policy.js";

describe("governance policy", () => {
  it("no recommendation when score passes the gate", () => {
    const r = buildGovernanceRecommendation({ score: 92 });
    expect(r.recommended).toBe(false);
    expect(r.severity).toBe("none");
  });

  it("watch on a single low chapter", () => {
    const r = buildGovernanceRecommendation({ score: 84 });
    expect(r.recommended).toBe(true);
    expect(r.severity).toBe("watch");
    expect(r.reason).toContain("84");
  });

  it("escalates to act on consecutive low chapters", () => {
    const r = buildGovernanceRecommendation({ score: 80, recentLowCount: 3 });
    expect(r.severity).toBe("act");
    expect(r.reason).toContain("连续 3");
  });

  it("no data → no recommendation", () => {
    expect(buildGovernanceRecommendation({ score: null }).recommended).toBe(false);
  });

  it("respects custom threshold", () => {
    expect(buildGovernanceRecommendation({ score: 86, passThreshold: 85 }).recommended).toBe(false);
    expect(buildGovernanceRecommendation({ score: 84, passThreshold: 85 }).recommended).toBe(true);
  });

  it("shouldTriggerGovernance mirrors recommended", () => {
    expect(shouldTriggerGovernance({ score: 70 })).toBe(true);
    expect(shouldTriggerGovernance({ score: 95 })).toBe(false);
  });
});
