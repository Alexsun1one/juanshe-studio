/**
 * 卷舍 · 经验库 数据模型(从质量分进化:写→判分→沉淀→回灌→再写)
 *
 * case-based reasoning 案例库 + multi-armed bandit(UCB1-Tuned)选有效模式 + MMR 多样性 +
 * 半衰 decay + 过拟合隔离,三道闸防同质化/过拟合。只蒸馏可解释参数,excerpt 硬限 120 字(法律红线)。
 * 纪律:节奏指纹复用 quality 的度量(RhythmFingerprint 从 SlopSignals 派生,故意不叫 RhythmSignature——那是 style 的)。
 */
import { z } from "zod"
import { QualityScore } from "../models/index.js"

export const PatternKind = z.enum(["opening", "pacing", "hook", "twist", "emotion-arc", "antipattern"])
export type PatternKind = z.infer<typeof PatternKind>

// 节奏指纹 —— 复用 pregate.SlopSignals 形状(去 redFlags,加 avgSentenceLen)
export const RhythmFingerprint = z.object({
  burstiness: z.number().default(0),
  uniformSentences: z.boolean().default(false),
  slopDensity: z.number().default(0),
  fillerHits: z.number().default(0),
  repetitionRatio: z.number().default(0),
  avgSentenceLen: z.number().default(0),
})
export type RhythmFingerprint = z.infer<typeof RhythmFingerprint>

export const LearningStats = z.object({
  timesApplied: z.number().int().nonnegative().default(0), // 臂被拉取(回灌进 planning)次数
  timesObservedHigh: z.number().int().nonnegative().default(1), // 被沉淀(成功)次数
  scoreSamples: z.array(z.number()).max(50).default([]), // 环形窗口,只留最近 50 个 overall
  meanScore: z.number().min(0).max(100).default(0),
  lastSeenAt: z.string().default(""),
  lastAppliedAt: z.string().optional(),
  createdAt: z.string().default(""),
})
export type LearningStats = z.infer<typeof LearningStats>

export const LearningEvidence = z.object({
  bookId: z.string(),
  chapterNumber: z.number().int().positive(),
  excerpt: z.string().max(120).optional(), // 硬限 120 字,守红线
  dims: QualityScore.shape.dimensions, // 五维快照(诊断用)
})
export type LearningEvidence = z.infer<typeof LearningEvidence>

export const Learning = z.object({
  id: z.string(),
  genreId: z.string(),
  platformId: z.string(),
  kind: PatternKind,
  title: z.string().max(40),
  instruction: z.string().max(280), // 可执行的一句话手法(回灌用,蒸馏成可解释参数)
  signature: RhythmFingerprint.optional(),
  evidence: z.array(LearningEvidence).max(5).default([]),
  stats: LearningStats,
  embedding: z.array(z.number()).optional(),
  status: z.enum(["active", "quarantined", "retired"]).default("active"),
  schemaVersion: z.literal(1).default(1),
})
export type Learning = z.infer<typeof Learning>

export const PatternLibrary = z.object({
  version: z.literal(1).default(1),
  updatedAt: z.string().default(""),
  learnings: z.array(Learning).default([]),
  index: z.record(z.string(), z.array(z.string())).default({}), // 'genreId::platformId' -> learningId[]
})
export type PatternLibrary = z.infer<typeof PatternLibrary>

export const RecordInput = z.object({
  genreId: z.string(),
  platformId: z.string(),
  bookId: z.string(),
  chapterNumber: z.number().int().positive(),
  chapterText: z.string(),
  score: QualityScore,
  plan: z.object({
    openingHook: z.string().optional(),
    beats: z.array(z.string()).optional(),
    emotionArc: z.string().optional(),
    hookKind: z.string().optional(),
  }).optional(),
  appliedLearningIds: z.array(z.string()).default([]), // 本章 planning 实际回灌了哪些(bandit 奖励回填)
})
export type RecordInput = z.infer<typeof RecordInput>

export const RetrieveQuery = z.object({
  genreId: z.string(),
  platformId: z.string(),
  k: z.number().int().positive().default(4), // 回灌条数(克制,防 prompt 膨胀)
  explore: z.number().min(0).max(1).default(0.15), // ε 探索比例
  diversityLambda: z.number().min(0).max(1).default(0.7), // MMR 相关 vs 多样
  includeAntipatterns: z.boolean().default(true),
  now: z.string(),
})
export type RetrieveQuery = z.infer<typeof RetrieveQuery>

export const RetrievedPattern = z.object({
  learning: Learning,
  reason: z.string(),
  selectedBy: z.enum(["exploit", "explore"]),
})
export type RetrievedPattern = z.infer<typeof RetrievedPattern>
