import { describe, expect, it } from "vitest";
import { renderMemoAsNarrativeBlock } from "../utils/narrative-control.js";

describe("renderMemoAsNarrativeBlock", () => {
  it("expands non-default chapter heat into scene-level craft directives", () => {
    const block = renderMemoAsNarrativeBlock(
      {
        chapter: 7,
        goal: "把当面对质推到台面上",
        isGoldenOpening: false,
        servesKr: null,
        threadRefs: [],
        register: "dialogue",
        tempo: "fast",
        body: "## 当前任务\n让对话承载冲突。",
      },
      {
        chapter: 7,
        goal: "把当面对质推到台面上",
        outlineNode: "雨夜对质",
        mustKeep: [],
        mustAvoid: [],
        styleEmphasis: ["减少铺陈，让台词推进误会"],
        register: "dialogue",
        tempo: "fast",
      },
      "zh",
    );

    expect(block).toContain("## 风格强调");
    expect(block).toContain("减少铺陈，让台词推进误会");
    expect(block).toContain("## 本章火候 / 场景级 craft");
    expect(block).toContain("register: dialogue");
    expect(block).toContain("tempo: fast");
    expect(block).toContain("对话承载冲突");
    expect(block).toContain("短句、强动词、高行动密度");
  });

  it("keeps default neutral medium heat as a prompt no-op for old books", () => {
    const block = renderMemoAsNarrativeBlock(
      {
        chapter: 8,
        goal: "推进主线",
        isGoldenOpening: false,
        servesKr: null,
        threadRefs: [],
        register: "neutral",
        tempo: "medium",
        body: "## 当前任务\n按 memo 推进。",
      },
      undefined,
      "zh",
    );

    expect(block).toContain("## 当前任务");
    expect(block).not.toContain("## 本章火候 / 场景级 craft");
    expect(block).not.toContain("style_guide / style fingerprint");
  });
});
