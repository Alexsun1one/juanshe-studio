import { describe, expect, it } from "vitest";
import { buildNarrativeProgressDashboard } from "../utils/narrative-progress-dashboard.js";

describe("buildNarrativeProgressDashboard", () => {
  it("renders whole-book and current-volume progress with a macro chapter role", () => {
    const dashboard = buildNarrativeProgressDashboard({
      chapterNumber: 86,
      targetChapters: 120,
      volumeMap: [
        "# 分卷",
        "## 第一卷：起航 (1-40章)",
        "## 第二卷：破局 (41-80章)",
        "## 第三卷：终局 (81-120章)",
      ].join("\n"),
      language: "zh",
    });

    expect(dashboard.completedChapters).toBe(85);
    expect(dashboard.wholeBookPercent).toBe(71);
    expect(dashboard.volumeName).toContain("第三卷");
    expect(dashboard.volumePercent).toBe(15);
    expect(dashboard.macroRole).toBe("build-up");
    expect(dashboard.promptBlock).toContain("全书进度：已完成 85/120 章");
    expect(dashboard.promptBlock).toContain("本章宏观角色");
  });

  it("promotes overdue hook clusters above local pacing phase", () => {
    const dashboard = buildNarrativeProgressDashboard({
      chapterNumber: 42,
      targetChapters: 100,
      volumeMap: "第一卷 1-50章\n第二卷 51-100章",
      overdueHookCount: 3,
      language: "zh",
    });

    expect(dashboard.macroRole).toBe("hook-payoff-cluster");
    expect(dashboard.memoSection).toContain("回收伏笔群");
  });
});
