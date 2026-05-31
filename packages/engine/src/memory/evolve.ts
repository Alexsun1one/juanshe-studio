/**
 * 卷舍 · 记忆进化(memory 写路径,Mem0 extract→consolidate→persist)
 *
 * 章签发后调用 afterChapter:用 chapter-analyzer 抽取结构化事实 → reconcile 三态合并进 KnowledgeGraph
 * → 推进伏笔状态机 → 写 chapterDeps(改纲级联即可用)→ 组装 ChapterDigest(含章级 burstiness,
 * 复用 text-metrics)→ 落库。account 层另走 salience+decay,把跨书反复出现的经验沉淀成长期规则。
 *
 * reconcile / 账号打分是纯函数(可单测);afterChapter / extract 是注入 LlmClient 的异步壳。
 * 调用位置(合成方案):放 book.ts 章循环的 publishing 后 hook,driver 保持单章纯。
 */
import { buildSystemPrompt } from "../agents/assemble.js"
import { burstiness } from "../quality/text-metrics.js"
import type { LlmClient } from "../llm/client.js"
import type { KnowledgeGraph, Entity } from "../state/knowledge.js"
import type { MemoryStore } from "./store.js"
import { ChapterFacts, type BookMemory, type ChapterDigest, type AccountMemory, type AccountRule, type MemoryMutation } from "./types.js"

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase()
const charCount = (s: string) => s.replace(/\s+/g, "").length

// ── 抽取(LLM,复用既有 chapter-analyzer 角色)──────────────
export async function extractChapterFacts(
  llm: LlmClient,
  args: { chapter: number; title: string; finalText: string; lang?: "zh" | "en" },
): Promise<ChapterFacts | null> {
  const system = buildSystemPrompt("chapter-analyzer", { lang: args.lang })
  const user =
    `第 ${args.chapter} 章《${args.title}》正文如下。请抽取结构化事实:出场实体(人物/势力/地点/道具/概念)、` +
    `实体间关系、本章【埋下】与【回收】的伏笔、角色/设定的状态变更、一句话主线、3-6 个场景节拍、情绪基调、章末钩子。\n\n` +
    `===正文===\n${args.finalText}`
  try {
    const { data } = await llm.generateStructured({
      system,
      messages: [{ role: "user", content: user }],
      temperature: 0.2,
      modelTier: "fast", // 摘要不需强模型,服务"快"
      schema: ChapterFacts,
    })
    return data
  } catch {
    return null // zod 校验/调用失败 → 降级,不污染图谱
  }
}

// ── reconcile:Mem0 三态合并(纯函数,genId 注入保可测)──────
export interface ReconcileResult {
  graph: KnowledgeGraph
  mutations: MemoryMutation[]
  entityIds: string[]
  plantedIds: string[]
  paidOffIds: string[]
}

export function reconcile(
  graph: KnowledgeGraph,
  facts: ChapterFacts,
  chapter: number,
  genId: (prefix: string) => string,
): ReconcileResult {
  const g: KnowledgeGraph = structuredClone(graph)
  const mutations: MemoryMutation[] = []
  const index = new Map<string, Entity>() // 归一名/别名 → 实体
  for (const e of g.entities) {
    index.set(norm(e.name), e)
    for (const a of e.aliases) index.set(norm(a), e)
  }
  const present = new Set<string>()

  const findEntity = (name: string, aliases: string[] = []): Entity | undefined =>
    index.get(norm(name)) ?? aliases.map((a) => index.get(norm(a))).find(Boolean)

  // 实体:ADD / UPDATE / NOOP
  for (const c of facts.candidateEntities) {
    let ent = findEntity(c.name, c.aliases)
    if (ent) {
      let changed = false
      for (const [k, v] of Object.entries(c.attributes)) if (ent.attributes[k] !== v) { ent.attributes[k] = v; changed = true }
      if (c.currentState && c.currentState !== ent.currentState) { ent.currentState = c.currentState; changed = true }
      for (const a of c.aliases) if (!ent.aliases.includes(a)) { ent.aliases.push(a); index.set(norm(a), ent); changed = true }
      mutations.push({ op: changed ? "update" : "noop", target: "entity", id: ent.id, after: ent.name, chapter })
    } else {
      ent = { id: genId("e"), type: c.type, name: c.name, aliases: [...c.aliases], attributes: { ...c.attributes }, firstSeenChapter: chapter, currentState: c.currentState }
      g.entities.push(ent)
      index.set(norm(c.name), ent)
      for (const a of c.aliases) index.set(norm(a), ent)
      mutations.push({ op: "add", target: "entity", id: ent.id, after: ent.name, chapter })
    }
    present.add(ent.id)
  }

  // 状态变更(单值覆盖=矛盾消解)
  for (const sc of facts.stateChanges) {
    const ent = findEntity(sc.entityName)
    if (ent && ent.currentState !== sc.change) {
      ent.currentState = sc.change
      present.add(ent.id)
      mutations.push({ op: "update", target: "entity", id: ent.id, after: sc.change, chapter })
    }
  }

  // 关系(去重 ADD)
  for (const r of facts.candidateRelations) {
    const from = findEntity(r.fromName)
    const to = findEntity(r.toName)
    if (!from || !to) continue
    if (!g.relations.some((x) => x.from === from.id && x.to === to.id && x.type === r.type)) {
      g.relations.push({ from: from.id, to: to.id, type: r.type, strength: 0.5, sinceChapter: chapter, note: r.note })
      mutations.push({ op: "add", target: "relation", chapter, after: `${from.name}-${r.type}-${to.name}` })
    }
  }

  // 伏笔:埋下
  const plantedIds: string[] = []
  for (const fp of facts.foreshadowPlanted) {
    const dup = g.foreshadows.find((f) => norm(f.description) === norm(fp.description))
    if (dup) { plantedIds.push(dup.id); continue }
    const id = genId("f")
    g.foreshadows.push({ id, description: fp.description, plantedChapter: chapter, seedText: fp.seedText, expectedPayoffBy: fp.expectedPayoffBy, state: "planted", entityIds: [...present].slice(0, 5) })
    plantedIds.push(id)
    mutations.push({ op: "add", target: "foreshadow", id, after: fp.description, chapter })
  }
  // 伏笔:回收(按描述相似匹配)
  const paidOffIds: string[] = []
  for (const desc of facts.foreshadowPaidOff) {
    const f = g.foreshadows.find((x) => x.state !== "paid-off" && (norm(x.description).includes(norm(desc)) || norm(desc).includes(norm(x.description))))
    if (f) {
      f.state = "paid-off"
      f.paidOffChapter = chapter
      paidOffIds.push(f.id)
      mutations.push({ op: "update", target: "foreshadow", id: f.id, after: "paid-off", chapter })
    }
  }

  // 时间线 + chapterDeps(改纲级联即可用)
  if (facts.oneLine) g.timeline.push({ id: genId("t"), chapter, summary: facts.oneLine, entityIds: [...present] })
  g.chapterDeps[String(chapter)] = { entityIds: [...present], foreshadowIds: [...plantedIds, ...paidOffIds] }

  return { graph: g, mutations, entityIds: [...present], plantedIds, paidOffIds }
}

// ── afterChapter:抽取 + reconcile + 组装 digest + 落库 ──────
export interface AfterChapterArgs {
  store: MemoryStore
  llm: LlmClient
  bookId: string
  chapter: number
  title: string
  finalText: string
  lang?: "zh" | "en"
  /** 注入 id 生成(默认运行时生成;测试可注入确定性序列)*/
  genId?: (prefix: string) => string
}

let _idCounter = 0
const defaultGenId = (prefix: string): string => `${prefix}_${(_idCounter++).toString(36)}${Math.round(performance.now()).toString(36)}`

export async function afterChapter(args: AfterChapterArgs): Promise<{ digest: ChapterDigest; memory: BookMemory; mutations: MemoryMutation[] }> {
  const mem = await args.store.loadBook(args.bookId)
  const genId = args.genId ?? defaultGenId
  const facts = await extractChapterFacts(args.llm, { chapter: args.chapter, title: args.title, finalText: args.finalText, lang: args.lang })

  let graph = mem.graph
  let mutations: MemoryMutation[] = []
  let entityIds: string[] = []
  let plantedIds: string[] = []
  let paidOffIds: string[] = []
  if (facts) {
    const r = reconcile(mem.graph, facts, args.chapter, genId)
    graph = r.graph
    mutations = r.mutations
    entityIds = r.entityIds
    plantedIds = r.plantedIds
    paidOffIds = r.paidOffIds
  }

  const digest: ChapterDigest = {
    chapter: args.chapter,
    title: args.title,
    pov: undefined,
    oneLine: facts?.oneLine ?? "",
    beats: facts?.beats ?? [],
    entitiesPresent: entityIds,
    foreshadowPlanted: plantedIds,
    foreshadowPaidOff: paidOffIds,
    mood: facts?.mood,
    hook: facts?.hook,
    wordCount: charCount(args.finalText),
    burstiness: burstiness(args.finalText), // 复用 text-metrics,本书风格基线的真实样本
    salience: Math.min(1, 0.5 + (paidOffIds.length ? 0.2 : 0) + (plantedIds.length ? 0.1 : 0)),
  }

  const digests = mem.digests.filter((d) => d.chapter !== args.chapter)
  digests.push(digest)
  digests.sort((a, b) => a.chapter - b.chapter)
  const memory: BookMemory = { ...mem, graph, digests }
  await args.store.saveBook(args.bookId, memory)
  return { digest, memory, mutations }
}

// ── account 层:salience + decay(纯函数)────────────────────
const HALF_LIFE = 50 // 章
function scoreOf(rule: AccountRule, globalNow: number): number {
  const age = Math.max(0, globalNow - rule.lastUsedChapterGlobal)
  const decay = Math.pow(0.5, age / HALF_LIFE)
  return Math.log1p(rule.hits) * decay
}

/** 沉淀/强化一条账号规则:等价规则 hits++,否则新建。返回新 AccountMemory(不可变)。*/
export function promoteAccountRule(
  account: AccountMemory,
  input: { rule: string; kind?: AccountRule["kind"]; evidence?: string; genreId?: string; platformId?: string },
  nowIso: string,
  cap = 200,
): AccountMemory {
  const rules = account.rules.map((r) => ({ ...r }))
  const existing = rules.find((r) => norm(r.rule) === norm(input.rule))
  const globalNow = account.globalChapterCounter
  if (existing) {
    existing.hits += 1
    existing.lastUsedChapterGlobal = globalNow
    existing.updatedAt = nowIso
    if (input.evidence) existing.evidence = input.evidence
  } else {
    rules.push({
      id: `r_${rules.length}_${norm(input.rule).slice(0, 8)}`,
      kind: input.kind ?? "de-ai",
      rule: input.rule,
      evidence: input.evidence,
      genreId: input.genreId,
      platformId: input.platformId,
      hits: 1,
      lastUsedChapterGlobal: globalNow,
      score: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
  }
  for (const r of rules) r.score = scoreOf(r, globalNow)
  // 防爆:超上限按 score 升序 LRU 淘汰
  rules.sort((a, b) => b.score - a.score)
  return { ...account, rules: rules.slice(0, cap) }
}

/** 检索注入用:按题材/平台过滤 + score 降序 top-N。 */
export function retrieveAccountRules(
  account: AccountMemory,
  opts: { genreId?: string; platformId?: string; limit?: number } = {},
): AccountRule[] {
  const globalNow = account.globalChapterCounter
  return account.rules
    .filter((r) => (!opts.genreId || !r.genreId || r.genreId === opts.genreId) && (!opts.platformId || !r.platformId || r.platformId === opts.platformId))
    .map((r) => ({ ...r, score: scoreOf(r, globalNow) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 5)
}
