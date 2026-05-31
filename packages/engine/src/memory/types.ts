/**
 * 卷舍 · 长期记忆 数据模型(三层:working / book / account)
 *
 * 设计依据(合成方案):
 *  - book 层不另起炉灶:BookMemory.graph 直接内嵌 state/knowledge.ts 的 KnowledgeGraph,
 *    overdueForeshadows/danglingEntityRefs/impactedChapters 三纯函数原样可用。
 *  - 风格不归记忆:本模块不定义 StyleProfile(那是 style 模块的唯一 SSOT,落 .style/);
 *    记忆只在 ChapterDigest 里存章级 burstiness(真实复用 quality/text-metrics,不抢风格地盘)。
 *  - account 层只存可解释参数(规则 / 数值 / 原型标签),绝不存外部作者原文(法律红线)。
 *  - AccountRule.kind 去掉 genre-playbook(题材打法归 learnings 模块,职责不重叠)。
 */
import { z } from "zod"
import { KnowledgeGraph, EntityType, RelationType } from "../state/knowledge.js"

// ─────────────────────────────────────────────────────────────
// 章摘要 —— afterChapter 的主产物,buildContextPack 的"上一章/近章摘要"数据源
// ─────────────────────────────────────────────────────────────
export const ChapterDigest = z.object({
  chapter: z.number().int().positive(),
  title: z.string().default(""),
  pov: z.string().optional(),
  oneLine: z.string(), // 一句话主线
  beats: z.array(z.string()).default([]), // 3-6 个场景节拍
  entitiesPresent: z.array(z.string()).default([]), // 本章出场 entity id
  foreshadowPlanted: z.array(z.string()).default([]), // foreshadow id
  foreshadowPaidOff: z.array(z.string()).default([]),
  mood: z.string().optional(),
  hook: z.string().optional(), // 章末钩子,下一章 priorContext 头部
  wordCount: z.number().int().nonnegative().default(0),
  /** 章级句长 burstiness(= text-metrics 的 CV)——风格基线在线校准的真实样本 */
  burstiness: z.number().min(0).default(0),
  /** 章重要度(回收伏笔/高分章加权),检索时按时间衰减 */
  salience: z.number().min(0).max(1).default(0.5),
})
export type ChapterDigest = z.infer<typeof ChapterDigest>

// ─────────────────────────────────────────────────────────────
// 设定条目 —— NovelAI lorebook 同构:按需触发,省 token、防设定漂移
// ─────────────────────────────────────────────────────────────
export const LoreEntry = z.object({
  id: z.string(),
  scope: z.enum(["book", "account"]).default("book"),
  entityId: z.string().optional(), // 挂在某实体上则随其检索
  title: z.string(),
  text: z.string(), // 注入提示词的设定正文
  /** 触发关键词:普通子串 / "A&B"=同窗口 AND / "/regex/flags"=正则 */
  keys: z.array(z.string()).default([]),
  priority: z.number().int().default(0), // 同预算下插入优先级
  tokenBudget: z.number().int().positive().optional(), // 本条最大占用
  alwaysOn: z.boolean().default(false), // 核心设定常驻
  tags: z.array(z.string()).default([]),
})
export type LoreEntry = z.infer<typeof LoreEntry>

// ─────────────────────────────────────────────────────────────
// 账号规则 —— 跨书通用经验(去AI味 / 风格 / 避坑);salience + decay
// 兼容既有 .autow/account-styles/*.json 的 {rule,evidence,hits,updatedAt} 形状
// ─────────────────────────────────────────────────────────────
export const AccountRule = z.object({
  id: z.string(),
  kind: z.enum(["de-ai", "style", "pitfall"]).default("de-ai"),
  rule: z.string(),
  evidence: z.string().optional(),
  genreId: z.string().optional(),
  platformId: z.string().optional(),
  hits: z.number().int().nonnegative().default(1), // 命中累计(salience 基数)
  lastUsedChapterGlobal: z.number().int().nonnegative().default(0), // 最近被采纳的全局章序(decay 用)
  score: z.number().min(0).default(1), // salience = log(1+hits)*decay
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})
export type AccountRule = z.infer<typeof AccountRule>

// ─────────────────────────────────────────────────────────────
// 人物原型 —— 跨书复用的"写人经验"(只存抽象参数)
// ─────────────────────────────────────────────────────────────
export const CharacterArchetype = z.object({
  id: z.string(),
  label: z.string(), // 原型标签:扮猪吃虎少年 / 追妻火葬场总裁…
  traits: z.array(z.string()).default([]),
  voiceNotes: z.array(z.string()).default([]),
  genreId: z.string().optional(),
  reuseCount: z.number().int().nonnegative().default(0),
  score: z.number().min(0).default(1),
})
export type CharacterArchetype = z.infer<typeof CharacterArchetype>

// ─────────────────────────────────────────────────────────────
// book 层聚合容器 —— 内嵌 KnowledgeGraph(不复制不重定义)
// 注意:无 style 字段;风格由 style 模块独立落 .style/(冲突消解③)
// ─────────────────────────────────────────────────────────────
export const BookMemory = z.object({
  graph: KnowledgeGraph,
  digests: z.array(ChapterDigest).default([]),
  lore: z.array(LoreEntry).default([]),
  schemaVersion: z.number().int().default(1),
})
export type BookMemory = z.infer<typeof BookMemory>

// account 层聚合容器
export const AccountMemory = z.object({
  rules: z.array(AccountRule).default([]),
  archetypes: z.array(CharacterArchetype).default([]),
  /** 单调递增的全局写作计数器(跨书可比,salience 衰减用)*/
  globalChapterCounter: z.number().int().nonnegative().default(0),
  schemaVersion: z.number().int().default(1),
})
export type AccountMemory = z.infer<typeof AccountMemory>

// ─────────────────────────────────────────────────────────────
// 写章前检索的产物 —— 唯一出口是 RunInput 的 priorContext / bookBible
// (book 模块的 FrozenChapterInput 是另一个东西,见合成方案冲突①)
// ─────────────────────────────────────────────────────────────
export const ContextPack = z.object({
  priorContext: z.string().default(""), // 动态前情:上一章 hook+近章摘要+未回收伏笔提醒+相关时间线
  bookBible: z.string().default(""), // 静态:出场实体卡+触发 lore+风格基线
  usedEntityIds: z.array(z.string()).default([]),
  usedForeshadowIds: z.array(z.string()).default([]),
  usedLoreIds: z.array(z.string()).default([]),
  tokenEstimate: z.number().int().nonnegative().default(0),
  /** 命中来源,供前端"记忆"页解释为何选了这些 */
  debug: z.record(z.string(), z.unknown()).default({}),
})
export type ContextPack = z.infer<typeof ContextPack>

// ─────────────────────────────────────────────────────────────
// 检索查询 / 命中 / 审计变更
// ─────────────────────────────────────────────────────────────
export const MemoryQuery = z.object({
  text: z.string().optional(),
  entityIds: z.array(z.string()).default([]),
  keys: z.array(z.string()).default([]),
  upToChapter: z.number().int().positive().optional(),
  kinds: z.array(z.enum(["entity", "digest", "lore", "foreshadow", "timeline"])).default([]),
  limit: z.number().int().positive().default(12),
})
export type MemoryQuery = z.infer<typeof MemoryQuery>

export const MemoryHit = z.object({
  kind: z.enum(["entity", "digest", "lore", "foreshadow", "timeline"]),
  id: z.string(),
  text: z.string(),
  score: z.number(),
  source: z.enum(["structured", "vector"]).default("structured"),
})
export type MemoryHit = z.infer<typeof MemoryHit>

export const MemoryMutation = z.object({
  op: z.enum(["add", "update", "noop"]),
  target: z.enum(["entity", "relation", "foreshadow", "timeline", "digest"]),
  id: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  chapter: z.number().int().positive(),
})
export type MemoryMutation = z.infer<typeof MemoryMutation>

// ─────────────────────────────────────────────────────────────
// LLM 抽取产物(afterChapter 的 extract 步骤;字段用"名"不用"id",reconcile 再归一)
// ─────────────────────────────────────────────────────────────
export const ChapterFacts = z.object({
  candidateEntities: z.array(z.object({
    name: z.string(),
    type: EntityType,
    aliases: z.array(z.string()).default([]),
    attributes: z.record(z.string(), z.string()).default({}),
    currentState: z.string().optional(),
  })).default([]),
  candidateRelations: z.array(z.object({
    fromName: z.string(),
    toName: z.string(),
    type: RelationType,
    note: z.string().optional(),
  })).default([]),
  foreshadowPlanted: z.array(z.object({
    description: z.string(),
    seedText: z.string().optional(),
    expectedPayoffBy: z.number().int().positive().optional(),
  })).default([]),
  foreshadowPaidOff: z.array(z.string()).default([]), // 回收了什么(描述,reconcile 按相似匹配既有伏笔)
  stateChanges: z.array(z.object({
    entityName: z.string(),
    change: z.string(),
  })).default([]),
  oneLine: z.string(),
  beats: z.array(z.string()).default([]),
  mood: z.string().optional(),
  hook: z.string().optional(),
})
export type ChapterFacts = z.infer<typeof ChapterFacts>
