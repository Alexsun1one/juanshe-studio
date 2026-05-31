/**
 * 卷舍 · SSOT 状态层 / 知识图谱(第三层)
 *
 * 长篇写作"前后一致、伏笔有收、改纲不漏"的单一事实源(Single Source of Truth)。
 * 研究综合:上游普遍把设定散在提示词里,容易漂移;我们用**强类型知识图谱 + 伏笔三态机
 * + 改纲级联依赖图**,让"一致性/伏笔/改纲"从"靠模型记得住"变成"代码可校验"。
 *
 * 服务硬指标:质量(一致性门禁)、稳定(改纲不漏改、可审计)。
 * 纯类型 + 纯函数,零运行依赖(除 zod)。
 */
import { z } from "zod"

// ── 实体(图的节点)────────────────────────────────────────
export const EntityType = z.enum([
  "character", // 角色
  "faction", // 势力/组织
  "place", // 地点
  "item", // 道具/物件
  "concept", // 设定概念(金手指/世界规则)
  "event", // 关键事件
])
export type EntityType = z.infer<typeof EntityType>

export const Entity = z.object({
  id: z.string(),
  type: EntityType,
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  /** 自由属性(身份/定位/能力/外貌…),保持开放但可校验存在 */
  attributes: z.record(z.string(), z.string()).default({}),
  /** 首次出现章节(用于一致性与时间线)*/
  firstSeenChapter: z.number().int().positive().optional(),
  /** 当前状态(随剧情演进,可被章节更新)*/
  currentState: z.string().optional(),
})
export type Entity = z.infer<typeof Entity>

// ── 关系(图的有向边)──────────────────────────────────────
export const RelationType = z.enum([
  "ally", "enemy", "rival", "mentor", "student",
  "family", "lover", "colleague", "superior", "subordinate",
  "member-of", "located-in", "owns", "knows",
])
export type RelationType = z.infer<typeof RelationType>

export const Relation = z.object({
  from: z.string(), // entity id
  to: z.string(), // entity id
  type: RelationType,
  /** 关系强度 0-1(用于关系矩阵可视化与"关系突变需事件驱动"的校验)*/
  strength: z.number().min(0).max(1).default(0.5),
  sinceChapter: z.number().int().positive().optional(),
  note: z.string().optional(),
})
export type Relation = z.infer<typeof Relation>

// ── 伏笔三态机(埋下 → 已回收 → 超期)──────────────────────
// 这是"伏笔有收"的核心:复核 agent 在签发前强制检查"无超期未回收伏笔"。
export const ForeshadowState = z.enum(["planted", "paid-off", "overdue"])
export type ForeshadowState = z.infer<typeof ForeshadowState>

export const Foreshadow = z.object({
  id: z.string(),
  description: z.string(),
  /** 种下伏笔的章节 + 当时的原文片段(用于回收时"接得上")*/
  plantedChapter: z.number().int().positive(),
  seedText: z.string().optional(),
  /** 期望在第几章前回收(超过即 overdue)*/
  expectedPayoffBy: z.number().int().positive().optional(),
  state: ForeshadowState.default("planted"),
  paidOffChapter: z.number().int().positive().optional(),
  /** 关联实体(让伏笔挂在人物/事件上,改纲级联用)*/
  entityIds: z.array(z.string()).default([]),
})
export type Foreshadow = z.infer<typeof Foreshadow>

// ── 时间线 ────────────────────────────────────────────────
export const TimelineEvent = z.object({
  id: z.string(),
  chapter: z.number().int().positive(),
  when: z.string().optional(), // 故事内时间("第二天早上"/"三年后")
  summary: z.string(),
  entityIds: z.array(z.string()).default([]),
})
export type TimelineEvent = z.infer<typeof TimelineEvent>

// ── 知识图谱(SSOT 容器)──────────────────────────────────
export const KnowledgeGraph = z.object({
  bookId: z.string(),
  entities: z.array(Entity).default([]),
  relations: z.array(Relation).default([]),
  foreshadows: z.array(Foreshadow).default([]),
  timeline: z.array(TimelineEvent).default([]),
  /** 大纲依赖:章节 → 它依赖/引用的实体与伏笔(改纲级联用)*/
  chapterDeps: z.record(z.string(), z.object({
    entityIds: z.array(z.string()).default([]),
    foreshadowIds: z.array(z.string()).default([]),
  })).default({}),
})
export type KnowledgeGraph = z.infer<typeof KnowledgeGraph>

// ── 纯函数:一致性 / 伏笔 / 改纲级联(可单测,代码可校验)──────

/** 复核门禁:返回在 `uptoChapter` 时点"超期未回收"的伏笔(非空 = 签发前必须处理)*/
export function overdueForeshadows(g: KnowledgeGraph, uptoChapter: number): Foreshadow[] {
  return g.foreshadows.filter(
    (f) => f.state !== "paid-off" && f.expectedPayoffBy !== undefined && f.expectedPayoffBy < uptoChapter,
  )
}

/** 一致性检查:引用了图中不存在的实体 id(写作/审稿时抓"凭空冒出的人物")*/
export function danglingEntityRefs(g: KnowledgeGraph): { chapter: string; missing: string[] }[] {
  const known = new Set(g.entities.map((e) => e.id))
  const out: { chapter: string; missing: string[] }[] = []
  for (const [ch, dep] of Object.entries(g.chapterDeps)) {
    const missing = dep.entityIds.filter((id) => !known.has(id))
    if (missing.length) out.push({ chapter: ch, missing })
  }
  return out
}

/** 改纲级联:某实体/伏笔变更后,找出所有引用它、因而可能需要重写的下游章节 */
export function impactedChapters(g: KnowledgeGraph, changed: { entityIds?: string[]; foreshadowIds?: string[] }): number[] {
  const es = new Set(changed.entityIds ?? [])
  const fs = new Set(changed.foreshadowIds ?? [])
  const hit = new Set<number>()
  for (const [ch, dep] of Object.entries(g.chapterDeps)) {
    const touchesEntity = dep.entityIds.some((id) => es.has(id))
    const touchesForeshadow = dep.foreshadowIds.some((id) => fs.has(id))
    if (touchesEntity || touchesForeshadow) hit.add(Number(ch))
  }
  return [...hit].sort((a, b) => a - b)
}
