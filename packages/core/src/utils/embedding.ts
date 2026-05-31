/**
 * 语义检索基元(纯函数,无 IO)——把"词面 n-gram 命中"升级成"语义相似度"召回,
 * 堵住"换个说法就漏召回"的窟窿(例:第 30 章写"旧信物发烫",第 800 章写"暖玉异动",
 * 词面对不上,但语义相近)。
 *
 * 设计为**混合检索**:词面分(广、召回)+ 语义分(准、排序),而非纯向量——
 * 词面兜底保证 embedding 不可用/出错时仍退化成现有行为(见 memory-retrieval 的 fallback)。
 */

/** 余弦相似度。维度不匹配或零向量 → 0(安全)。 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface HybridCandidate {
  /** 该候选的词面分(任意非负量纲;函数内部会按池内最大值归一化)。 */
  readonly lexicalScore: number;
  /** 该候选的向量(与 query 同维)。缺省/空 → 语义分记 0,退化为纯词面。 */
  readonly vec?: readonly number[];
}

/**
 * 混合重排:返回候选**索引**按"混合分降序"排列。
 * 混合分 = (1-w)·词面归一化 + w·余弦相似度。w=语义权重(默认 0.6)。
 * - query 向量缺省/为空 → 退化为纯词面排序(语义分恒 0,稳定)。
 * - 词面分全 0 → 归一化分母取 1,纯靠语义。
 * 纯函数、确定性、可单测。
 */
export function hybridRank(params: {
  readonly queryVec?: readonly number[];
  readonly candidates: ReadonlyArray<HybridCandidate>;
  readonly semanticWeight?: number;
}): number[] {
  const { candidates } = params;
  const w = clamp01(params.semanticWeight ?? 0.6);
  const haveQuery = Array.isArray(params.queryVec) && params.queryVec.length > 0;
  const maxLex = Math.max(1, ...candidates.map((c) => (Number.isFinite(c.lexicalScore) ? c.lexicalScore : 0)));
  return candidates
    .map((c, index) => {
      const lexNorm = (Number.isFinite(c.lexicalScore) ? c.lexicalScore : 0) / maxLex;
      const semantic = haveQuery && c.vec && c.vec.length > 0
        ? cosineSimilarity(params.queryVec!, c.vec)
        : 0;
      const score = haveQuery ? (1 - w) * lexNorm + w * semantic : lexNorm;
      return { index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.index);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
