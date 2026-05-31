import { describe, expect, it } from "vitest";
import { buildResearchQueries, buildResearchContext } from "../editorial/research.js";

describe("research (editorial)", () => {
  it("extracts focused queries, stripping 选题/要求 shell", () => {
    const q = buildResearchQueries("选题:35 岁职场人如何对抗本领恐慌。要求:有真实案例,公众号深度长文。");
    expect(q.length).toBeGreaterThanOrEqual(1);
    expect(q[0]).toBe("35 岁职场人如何对抗本领恐慌");
    expect(q[0]).not.toContain("要求");
    expect(q[1]).toContain("案例");
  });

  it("respects max and handles blank", () => {
    expect(buildResearchQueries("远程办公专注", 1)).toHaveLength(1);
    expect(buildResearchQueries("")).toEqual([]);
  });

  it("builds a grounding block with sources and guardrails", () => {
    const ctx = buildResearchContext([
      { title: "卡特尔智力理论", snippet: "流体智力 vs 晶体智力…", url: "https://example.com/a" },
      { title: "", snippet: "no title but has url", url: "https://example.com/b" },
      { title: "skip me", snippet: "no url", url: "" },
    ]);
    expect(ctx).toContain("检索到的参考资料");
    expect(ctx).toContain("严禁编造");
    expect(ctx).toContain("https://example.com/a");
    expect(ctx).toContain("https://example.com/b");
    expect(ctx).not.toContain("skip me"); // 无 url 的丢弃
  });

  it("returns empty string when no usable findings", () => {
    expect(buildResearchContext([])).toBe("");
    expect(buildResearchContext([{ title: "x", snippet: "y", url: "" }])).toBe("");
  });
});
