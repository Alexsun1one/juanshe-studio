import { describe, expect, it } from "vitest";
import { StageTracker } from "../pipeline/stage-tracker.js";

function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("StageTracker", () => {
  it("records stages and settles elapsed per stage", () => {
    const c = fakeClock();
    const tr = new StageTracker(60000, c.now);
    tr.mark("prepare"); c.advance(2000);
    tr.mark("write"); c.advance(5000);
    tr.mark("review"); c.advance(3000);
    const tl = tr.timeline();
    expect(tl.map((r) => r.stage)).toEqual(["prepare", "write", "review"]);
    expect(tl[0]!.elapsedMs).toBe(2000);
    expect(tl[1]!.elapsedMs).toBe(5000);
    expect(tl[2]!.elapsedMs).toBe(3000); // 最后一段用当前时间结算
    expect(tr.current).toBe("review");
    expect(tr.elapsedMs).toBe(10000);
  });

  it("flags overBudget once past the deadline", () => {
    const c = fakeClock();
    const tr = new StageTracker(5000, c.now);
    expect(tr.overBudget).toBe(false);
    expect(tr.remainingMs()).toBe(5000);
    c.advance(4999);
    expect(tr.overBudget).toBe(false);
    c.advance(2);
    expect(tr.overBudget).toBe(true);
    expect(tr.remainingMs()).toBeLessThan(0);
  });

  it("summary is a readable one-liner", () => {
    const c = fakeClock();
    const tr = new StageTracker(60000, c.now);
    tr.mark("撰写"); c.advance(42000);
    tr.mark("审计"); c.advance(18000);
    expect(tr.summary()).toBe("撰写:42s → 审计:18s");
  });
});
