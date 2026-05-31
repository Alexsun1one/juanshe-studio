/**
 * 卷舍 · 写章前上下文检索与组装(memory 读路径)
 *
 * 唯一出口 = RunInput 的 priorContext(动态前情)+ bookBible(静态设定)。零侵入对接现有 handlers。
 * 结构化检索为主路(出场人物 + 1 跳邻居 + 未回收伏笔 + 近章摘要 + 触发 lore),向量仅可选补漏。
 * 纯函数核心(selectContext/rankEntitiesForChapter/triggerLore)可单测;buildContextPack 是薄异步壳。
 */
import type { Entity } from "../state/knowledge.js"
import { overdueForeshadows } from "../state/knowledge.js"
import type { BookMemory, ContextPack, LoreEntry } from "./types.js"
import type { MemoryStore } from "./store.js"

// 粗略 token 估算(CJK 约 1.5 字/token);只用于预算裁剪,不需精确
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 1.5)
}

/** 出场集合:plannedEntities + 1 跳邻居(按关系强度),封顶 cap;无种子时回落到度数最高的实体 */
export function rankEntitiesForChapter(graph: BookMemory["graph"], plannedEntities: string[], cap = 8): Entity[] {
  const byId = new Map(graph.entities.map((e) => [e.id, e]))
  const seed = new Set(plannedEntities.filter((id) => byId.has(id)))

  if (seed.size === 0) {
    // 回落:按度数(关系数)排序取前 cap
    const degree = new Map<string, number>()
    for (const r of graph.relations) {
      degree.set(r.from, (degree.get(r.from) ?? 0) + 1)
      degree.set(r.to, (degree.get(r.to) ?? 0) + 1)
    }
    return graph.entities
      .slice()
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      .slice(0, cap)
  }

  const weight = new Map<string, number>()
  for (const id of seed) weight.set(id, 10)
  for (const r of graph.relations) {
    if (seed.has(r.from) && !seed.has(r.to)) weight.set(r.to, Math.max(weight.get(r.to) ?? 0, r.strength))
    if (seed.has(r.to) && !seed.has(r.from)) weight.set(r.from, Math.max(weight.get(r.from) ?? 0, r.strength))
  }
  return [...weight.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId.get(id))
    .filter((e): e is Entity => !!e)
    .slice(0, cap)
}

/** NovelAI lorebook 式触发:普通子串 / "A&B" 同窗口 AND / "/re/flags" 正则 / alwaysOn 常驻 */
export function loreMatches(entry: LoreEntry, scene: string): boolean {
  if (entry.alwaysOn) return true
  const s = scene.toLowerCase()
  for (const raw of entry.keys) {
    const key = raw?.trim()
    if (!key) continue
    if (key.length > 2 && key.startsWith("/") && key.lastIndexOf("/") > 0) {
      const last = key.lastIndexOf("/")
      try {
        if (new RegExp(key.slice(1, last), key.slice(last + 1)).test(scene)) return true
      } catch {
        /* 非法正则忽略 */
      }
    } else if (key.includes("&")) {
      const parts = key.split("&").map((p) => p.trim().toLowerCase()).filter(Boolean)
      if (parts.length && parts.every((p) => s.includes(p))) return true
    } else if (s.includes(key.toLowerCase())) {
      return true
    }
  }
  return false
}

export function triggerLore(lore: LoreEntry[], scene: string, presentIds: Set<string>): LoreEntry[] {
  return lore
    .filter((l) => loreMatches(l, scene))
    .sort((a, b) => {
      const aIn = a.entityId && presentIds.has(a.entityId) ? 1 : 0
      const bIn = b.entityId && presentIds.has(b.entityId) ? 1 : 0
      if (bIn !== aIn) return bIn - aIn // 在场优先
      return b.priority - a.priority
    })
}

export interface SelectOptions {
  chapter: number
  plannedEntities?: string[]
  chapterGoal?: string
  maxTokens?: number
  entityCap?: number
}

/** 纯函数核心:从 BookMemory 选出并渲染 priorContext / bookBible(含预算裁剪)*/
export function selectContext(mem: BookMemory, opts: SelectOptions): ContextPack {
  const chapter = opts.chapter
  const maxTokens = opts.maxTokens ?? 2200
  const present = rankEntitiesForChapter(mem.graph, opts.plannedEntities ?? [], opts.entityCap ?? 8)
  const presentIds = new Set(present.map((e) => e.id))

  // ── priorContext(动态前情,带时序)──
  const priorLines: string[] = []
  const usedForeshadowIds: string[] = []
  const past = mem.digests.filter((d) => d.chapter < chapter).sort((a, b) => b.chapter - a.chapter)
  const last = past[0]
  if (last?.hook) priorLines.push(`【上一章钩子】${last.hook}`)
  if (last) priorLines.push(`【上一章】第${last.chapter}章:${last.oneLine}`)
  const recent = past.slice(1, 4)
  if (recent.length) priorLines.push(`【近况】${recent.map((d) => `第${d.chapter}章:${d.oneLine}`).join(" / ")}`)

  // 伏笔提醒(复用 knowledge.ts;超期 + 临近回收)
  // 注意:overdueForeshadows 按 expectedPayoffBy 判超期但不改 .state(仍是 planted),
  // 故"已超期 / 临近回收"按来源列表判定,不看 f.state。
  const overdue = overdueForeshadows(mem.graph, chapter)
  const overdueIds = new Set(overdue.map((f) => f.id))
  const nearDue = mem.graph.foreshadows.filter(
    (f) => f.state === "planted" && f.expectedPayoffBy !== undefined && f.expectedPayoffBy <= chapter + 1 && !overdueIds.has(f.id),
  )
  const remind = [...overdue, ...nearDue]
  if (remind.length) {
    priorLines.push(`【伏笔待处理】${remind.map((f) => `「${f.description}」(第${f.plantedChapter}章埋·${overdueIds.has(f.id) ? "已超期" : "临近回收"})`).join(";")}`)
    usedForeshadowIds.push(...remind.map((f) => f.id))
  }

  // 相关时间线(出场实体相关,近优先)
  const tl = mem.graph.timeline
    .filter((t) => t.chapter < chapter && t.entityIds.some((id) => presentIds.has(id)))
    .sort((a, b) => b.chapter - a.chapter)
    .slice(0, 3)
  if (tl.length) priorLines.push(`【相关事件】${tl.map((t) => `第${t.chapter}章·${t.summary}`).join(";")}`)

  // ── bookBible(静态设定:实体卡 + 触发 lore)──
  const bibleLines: string[] = []
  const usedEntityIds: string[] = []
  if (present.length) {
    bibleLines.push("【出场人物/设定】")
    for (const e of present) {
      const card = [`· ${e.name}${e.aliases.length ? `(${e.aliases.join("/")})` : ""}`, e.attributes && Object.keys(e.attributes).length ? Object.entries(e.attributes).map(([k, v]) => `${k}:${v}`).join("、") : "", e.currentState ? `现状:${e.currentState}` : ""].filter(Boolean).join(" — ")
      bibleLines.push(card)
      usedEntityIds.push(e.id)
    }
  }
  const scene = `${opts.chapterGoal ?? ""} ${present.map((e) => `${e.name} ${e.aliases.join(" ")}`).join(" ")} ${last?.hook ?? ""}`
  const triggered = triggerLore(mem.lore, scene, presentIds)
  const usedLoreIds: string[] = []

  // ── 预算裁剪:bible 桶按 priority 加 lore,超预算停;prior 的钩子/伏笔提醒永不丢 ──
  const bibleBudget = Math.floor(maxTokens * 0.55)
  let bibleTokens = estimateTokens(bibleLines.join("\n"))
  if (triggered.length) bibleLines.push("【相关设定】")
  for (const l of triggered) {
    const line = `· ${l.title}:${l.text}`
    const t = estimateTokens(line)
    if (bibleTokens + t > bibleBudget) continue
    bibleLines.push(line)
    bibleTokens += t
    usedLoreIds.push(l.id)
  }

  const priorBudget = Math.floor(maxTokens * 0.45)
  // 钩子(idx0)与伏笔提醒必留;其余从尾部按需裁
  let priorText = priorLines.join("\n")
  if (estimateTokens(priorText) > priorBudget) {
    const keep = priorLines.filter((l) => l.startsWith("【上一章钩子】") || l.startsWith("【伏笔待处理】"))
    const optional = priorLines.filter((l) => !keep.includes(l))
    const acc: string[] = [...keep]
    let pt = estimateTokens(acc.join("\n"))
    for (const l of optional) {
      const t = estimateTokens(l)
      if (pt + t > priorBudget) continue
      acc.push(l)
      pt += t
    }
    // 还原大致顺序
    priorText = priorLines.filter((l) => acc.includes(l)).join("\n")
  }

  const bibleText = bibleLines.join("\n")
  return {
    priorContext: priorText,
    bookBible: bibleText,
    usedEntityIds,
    usedForeshadowIds,
    usedLoreIds,
    tokenEstimate: estimateTokens(priorText) + estimateTokens(bibleText),
    debug: { presentEntities: present.map((e) => e.name), triggeredLore: usedLoreIds.length, reminders: usedForeshadowIds.length },
  }
}

export interface BuildContextPackArgs {
  store: MemoryStore
  bookId: string
  chapter: number
  chapterGoal?: string
  plannedEntities?: string[]
  maxTokens?: number
}

/** 异步壳:loadBook → selectContext(向量补漏留口,本期默认纯结构化)*/
export async function buildContextPack(args: BuildContextPackArgs): Promise<ContextPack> {
  const mem = await args.store.loadBook(args.bookId)
  return selectContext(mem, {
    chapter: args.chapter,
    plannedEntities: args.plannedEntities,
    chapterGoal: args.chapterGoal,
    maxTokens: args.maxTokens,
  })
}
