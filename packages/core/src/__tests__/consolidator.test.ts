import { describe, expect, it } from "vitest";
import { ConsolidatorAgent } from "../agents/consolidator.js";

describe("ConsolidatorAgent", () => {
  it("parses Chinese volume boundaries with full-width parentheses and chapter ranges", () => {
    const agent = new ConsolidatorAgent({
      client: {} as ConstructorParameters<typeof ConsolidatorAgent>[0]["client"],
      model: "test-model",
      projectRoot: "/tmp",
    });

    const outline = [
      "# Volume Outline",
      "",
      "### 第一卷：死而复生的实习期（1-20章）",
      "- 主角重返公司，卷入第一起异常事故",
      "",
      "### 第二卷：时间线上的猎手（21-60章）",
      "- 追查时间裂隙背后的操控者",
      "",
    ].join("\n");

    const boundaries = (agent as unknown as {
      parseVolumeBoundaries: (input: string) => Array<{ name: string; startCh: number; endCh: number }>;
    }).parseVolumeBoundaries(outline);

    expect(boundaries).toEqual([
      { name: "第一卷：死而复生的实习期", startCh: 1, endCh: 20 },
      { name: "第二卷：时间线上的猎手", startCh: 21, endCh: 60 },
    ]);
  });

  it("parses multi-line volume_map where the range is on a separate 范围 line", () => {
    const agent = new ConsolidatorAgent({
      client: {} as ConstructorParameters<typeof ConsolidatorAgent>[0]["client"],
      model: "test-model",
      projectRoot: "/tmp",
    });

    // 这正是 books/*/story/volume_map.md 的真实写法:卷名一行、范围在下面的「- 范围：第 X-Y 章」
    const outline = [
      "# 卷纲地图",
      "",
      "## 第一卷：退烧之始",
      "",
      "- 范围：第 1-30 章",
      "- 核心承诺：把开书设定落成可见压力。",
      "- 起始章节名候选：",
      "- 第 1 章：退烧", // 单个数字,不能被误判成范围
      "- 第 2 章：不得不做的选择",
      "",
      "## 第二卷：更大的风暴",
      "",
      "- 范围：第 31-60 章",
      "- 核心承诺：扩大外部压力。",
      "",
    ].join("\n");

    const boundaries = (agent as unknown as {
      parseVolumeBoundaries: (input: string) => Array<{ name: string; startCh: number; endCh: number }>;
    }).parseVolumeBoundaries(outline);

    expect(boundaries).toEqual([
      { name: "第一卷：退烧之始", startCh: 1, endCh: 30 },
      { name: "第二卷：更大的风暴", startCh: 31, endCh: 60 },
    ]);
  });
});
