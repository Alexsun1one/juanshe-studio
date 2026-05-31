/**
 * 卷舍 · 风格指纹 数据模型(StyleProfile = 全项目唯一风格 SSOT)
 *
 * 设计纪律(合成方案):
 *  - 节奏维度复用 quality/text-metrics 的句长 CV/burstiness(同一把尺,不另写)。
 *  - 只存数值 + 可读 descriptor,绝不含样本原文(assertNoVerbatim 代码级守卫,法律红线)。
 *  - 风格契合度(StyleAdherenceReport)是独立信号,不进 QualityScore 五维,作"风格的 L0"喂门禁。
 *  - memory 不再自定义 StyleFingerprint,改引用本模块;learnings 的 RhythmFingerprint 从 SlopSignals 派生。
 */
import { z } from "zod"

// 节奏签名 —— sentenceLenCV 即 detectSlop 的 burstiness(同式同源)
export const RhythmSignature = z.object({
  avgSentenceLen: z.number().nonnegative().default(0),
  sentenceLenCV: z.number().nonnegative().default(0), // = stddev/mean = burstiness
  shortRatio: z.number().min(0).max(1).default(0), // 句长<8字占比
  longRatio: z.number().min(0).max(1).default(0), // 句长>30字占比
  midBandRatio: z.number().min(0).max(1).default(0), // 15–25字占比(对齐 detectSlop.inBand)
  standaloneShortFreq: z.number().min(0).max(1).default(0), // 独立成段短句频率(停顿节奏)
  avgParagraphLen: z.number().nonnegative().default(0),
})
export type RhythmSignature = z.infer<typeof RhythmSignature>

export const LexicalProfile = z.object({
  ttr: z.number().min(0).max(1).default(0), // type-token ratio 词汇多样性
  hapaxRatio: z.number().min(0).max(1).default(0), // 只出现一次的词占比
  functionWordRatio: z.number().min(0).max(1).default(0), // 虚词占比(stylometry 最稳指纹)
  avgWordLen: z.number().nonnegative().default(0),
  signatureNGrams: z.array(z.object({ gram: z.string(), z: z.number() })).max(12).default([]),
})
export type LexicalProfile = z.infer<typeof LexicalProfile>

export const SyntaxProfile = z.object({
  subordinationIndex: z.number().min(0).max(1).default(0), // 逗号/分句密度近似从句嵌套
  clausesPerSentence: z.number().nonnegative().default(0),
  parallelismRate: z.number().min(0).max(1).default(0),
  fragmentRate: z.number().min(0).max(1).default(0),
})
export type SyntaxProfile = z.infer<typeof SyntaxProfile>

export const RhetoricProfile = z.object({
  simileDensity: z.number().min(0).max(1).default(0), // 比喻标记/千字
  metaphorMarkers: z.number().min(0).max(1).default(0),
  sensoryDensity: z.number().min(0).max(1).default(0), // 五感词/千字
  abstractionRatio: z.number().min(0).max(1).default(0), // 抽象 vs 具体(高=报告腔)
})
export type RhetoricProfile = z.infer<typeof RhetoricProfile>

export const DialogueProfile = z.object({
  dialogueRatio: z.number().min(0).max(1).default(0), // 引号内字符占比
  avgDialogueLen: z.number().nonnegative().default(0),
  dialogueTagStyle: z.enum(["bare", "adverbial", "action-beat"]).default("bare"),
})
export type DialogueProfile = z.infer<typeof DialogueProfile>

export const PovTense = z.object({
  person: z.enum(["first", "third-limited", "third-omniscient", "mixed"]).default("third-limited"),
  tense: z.enum(["past", "present", "mixed"]).default("past"),
  interiorityRatio: z.number().min(0).max(1).default(0), // 内心独白占比
})
export type PovTense = z.infer<typeof PovTense>

export const PunctuationHabit = z.object({
  emDashPerKchar: z.number().nonnegative().default(0),
  ellipsisPerKchar: z.number().nonnegative().default(0),
  exclamationRatio: z.number().min(0).max(1).default(0),
  questionRatio: z.number().min(0).max(1).default(0),
})
export type PunctuationHabit = z.infer<typeof PunctuationHabit>

// 顶层风格指纹 —— 数值 + 可读 descriptor,绝不含原文
export const StyleProfile = z.object({
  schemaVersion: z.literal(1).default(1),
  bookId: z.string().optional(),
  lang: z.enum(["zh", "en"]).default("zh"),
  rhythm: RhythmSignature,
  lexical: LexicalProfile,
  syntax: SyntaxProfile,
  rhetoric: RhetoricProfile,
  dialogue: DialogueProfile,
  pov: PovTense,
  punctuation: PunctuationHabit,
  motifs: z.array(z.string()).max(8).default([]), // 母题(模式级短语,过反原文过滤)
  descriptors: z.array(z.string()).max(12).default([]), // 人类可读、可执行的风格戒律(注入提示词主载体)
  sampleStats: z.object({
    chars: z.number().int().nonnegative().default(0),
    sentences: z.number().int().nonnegative().default(0),
    mergedSamples: z.number().int().nonnegative().default(1),
    updatedAt: z.string().default(""),
  }),
  confidence: z.number().min(0).max(1).default(0), // 样本量驱动,mergeStyle 累加
})
export type StyleProfile = z.infer<typeof StyleProfile>

// 风格契合度反馈 —— 不进 QualityScore,作独立信号(风格的 L0)
export const StyleDrift = z.object({
  dimension: z.string(),
  expected: z.number(),
  actual: z.number(),
  severity: z.enum(["minor", "major"]),
})
export type StyleDrift = z.infer<typeof StyleDrift>

export const StyleAdherenceReport = z.object({
  score: z.number().min(0).max(100), // 章节对目标 profile 的契合度
  perDimension: z.record(z.string(), z.number()).default({}),
  drift: z.array(StyleDrift).default([]),
  mustFix: z.array(z.string()).default([]), // 可执行风格修订,合并进 judge 的 mustFix 流
})
export type StyleAdherenceReport = z.infer<typeof StyleAdherenceReport>

// extractStyle 的 LLM 补全产物(只判数值算不出的语义)
export const StyleLlmAddendum = z.object({
  pov: PovTense,
  motifs: z.array(z.string()).max(8).default([]),
  descriptors: z.array(z.string()).max(12).default([]),
})
export type StyleLlmAddendum = z.infer<typeof StyleLlmAddendum>
