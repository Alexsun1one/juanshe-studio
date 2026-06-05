import { describe, it, expect } from "vitest";
import { filterActiveHooks, isFuturePlannedHook } from "../utils/hook-lifecycle.js";
import type { StoredHook } from "../state/memory-db.js";

const hook = (status: string, over: Partial<StoredHook> = {}): StoredHook => ({
  hookId: "H1",
  startChapter: 1,
  type: "relationship",
  status,
  lastAdvancedChapter: 1,
  expectedPayoff: "10",
  notes: "",
  ...over,
});

describe("filterActiveHooks · 只滤掉已回收钩子,其余(含延后/未知)保留为活跃", () => {
  it("resolved 族(含中英别名、大小写)全部被滤掉", () => {
    const resolved = ["resolved", "RESOLVED", "closed", "done", "已回收", "已解决"].map((s) =>
      hook(s, { hookId: `R-${s}` }),
    );
    expect(filterActiveHooks(resolved)).toEqual([]);
  });

  it("活跃态(open/progressing/deferred/空/未知措辞如 pressured)全部保留", () => {
    const active = ["open", "progressing", "advanced", "deferred", "延后", "搁置", "", "pressured", "near_payoff"].map(
      (s, i) => hook(s, { hookId: `A-${i}` }),
    );
    expect(filterActiveHooks(active).map((h) => h.hookId)).toEqual(active.map((h) => h.hookId));
  });

  it("混合:只把 resolved 的剔除,保留顺序", () => {
    const hooks = [
      hook("open", { hookId: "a" }),
      hook("已回收", { hookId: "b" }),
      hook("deferred", { hookId: "c" }),
      hook("done", { hookId: "d" }),
      hook("progressing", { hookId: "e" }),
    ];
    expect(filterActiveHooks(hooks).map((h) => h.hookId)).toEqual(["a", "c", "e"]);
  });
});

describe("isFuturePlannedHook · 尚未出场且远在前方的预埋钩子", () => {
  it("未推进(lastAdvancedChapter<=0)且 startChapter 远超当前+lookahead → 是未来预埋", () => {
    expect(isFuturePlannedHook(hook("open", { lastAdvancedChapter: 0, startChapter: 50 }), 10)).toBe(true);
  });
  it("已推进过的钩子不算未来预埋", () => {
    expect(isFuturePlannedHook(hook("open", { lastAdvancedChapter: 5, startChapter: 50 }), 10)).toBe(false);
  });
  it("起点就在近处的钩子不算未来预埋", () => {
    expect(isFuturePlannedHook(hook("open", { lastAdvancedChapter: 0, startChapter: 11 }), 10)).toBe(false);
  });
});
