import { describe, expect, it } from "vitest";
import { cosineSimilarity, hybridRank } from "../utils/embedding.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical direction, ~0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });
  it("is safe on dim mismatch / zero vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("hybridRank", () => {
  it("pulls a semantically-close but lexically-weak candidate up when query vec is present", () => {
    // 候选 0:词面分高但语义远;候选 1:词面分低但语义=query。高语义权重下,1 应排到前面。
    // 这正是要解决的「换说法漏召回」:词面对不上,但语义对得上。
    const ranked = hybridRank({
      queryVec: [1, 0, 0],
      semanticWeight: 0.8,
      candidates: [
        { lexicalScore: 100, vec: [0, 1, 0] }, // 词面满分,语义正交
        { lexicalScore: 5, vec: [1, 0, 0] },   // 词面很低,语义满分
      ],
    });
    expect(ranked[0]).toBe(1);
    expect(ranked[1]).toBe(0);
  });

  it("falls back to pure lexical order when no query vec (semantic disabled)", () => {
    const ranked = hybridRank({
      candidates: [
        { lexicalScore: 5, vec: [1, 0] },
        { lexicalScore: 100, vec: [0, 1] },
      ],
    });
    expect(ranked).toEqual([1, 0]); // 纯词面:高分在前
  });

  it("ignores semantics for candidates missing vectors (degrades gracefully)", () => {
    const ranked = hybridRank({
      queryVec: [1, 0],
      semanticWeight: 0.8,
      candidates: [
        { lexicalScore: 100 },            // 无向量 → 语义分 0,但词面满分
        { lexicalScore: 1, vec: [1, 0] }, // 有向量、语义满分,但词面极低
      ],
    });
    // 候选0:0.2*1 + 0.8*0 = 0.2;候选1:0.2*0.01 + 0.8*1 = 0.802 → 候选1 在前
    expect(ranked[0]).toBe(1);
  });
});
