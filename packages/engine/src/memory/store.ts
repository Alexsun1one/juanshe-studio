/**
 * 卷舍 · 记忆持久化抽象(核心纯 + IO 注入,复刻 driver 的 PipelineDeps 范式)
 *
 * 引擎只放:MemoryStore 接口 + 可选 Embedder 口 + 零依赖的内存实现 + 结构化检索纯函数。
 * 真正落盘的 FileMemoryStore(node:fs,books/<id>/memory/*、.autow/account-memory.json)
 * 放 studio/host 侧——保引擎 fs/provider 无关、可单测、可跑在任意宿主。
 */
import type { BookMemory, AccountMemory, ChapterDigest, MemoryQuery, MemoryHit, LoreEntry } from "./types.js"
import type { Entity, Foreshadow, TimelineEvent } from "../state/knowledge.js"

/** 可选向量增强口:实现可挂 llm/vercel.ts 的 createOpenAICompatible(baseUrl 指自部署 embedding 端) */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>
}

export interface MemoryStore {
  loadBook(bookId: string): Promise<BookMemory>
  saveBook(bookId: string, mem: BookMemory): Promise<void>
  getDigest(bookId: string, chapter: number): Promise<ChapterDigest | undefined>
  putDigest(bookId: string, digest: ChapterDigest): Promise<void>
  loadAccount(): Promise<AccountMemory>
  saveAccount(account: AccountMemory): Promise<void>
  /** book 域结构化检索(buildContextPack 的二路召回 / 通用查询);向量增强可选叠加 */
  search(bookId: string, q: MemoryQuery): Promise<MemoryHit[]>
  readonly embedder?: Embedder
}

// ── 空壳工厂 ──────────────────────────────────────────────
export function emptyBookMemory(bookId: string): BookMemory {
  return {
    graph: { bookId, entities: [], relations: [], foreshadows: [], timeline: [], chapterDeps: {} },
    digests: [],
    lore: [],
    schemaVersion: 1,
  }
}
export function emptyAccountMemory(): AccountMemory {
  return { rules: [], archetypes: [], globalChapterCounter: 0, schemaVersion: 1 }
}

// ── 向量工具(纯) ─────────────────────────────────────────
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : 0
}

// ── 结构化检索(纯函数;buildContextPack 的叙事化组装在 context-pack.ts,这里是通用召回)──
function lc(s: string): string {
  return s.toLowerCase()
}
function textHits(haystack: string, needles: readonly string[]): number {
  if (!needles.length) return 0
  const h = lc(haystack)
  let n = 0
  for (const t of needles) if (t && h.includes(lc(t))) n++
  return n
}

export function structuredSearch(mem: BookMemory, q: MemoryQuery): MemoryHit[] {
  const wantedKinds = new Set(q.kinds.length ? q.kinds : ["entity", "digest", "lore", "foreshadow", "timeline"])
  const needles = [q.text ?? "", ...q.keys].filter(Boolean)
  const idSet = new Set(q.entityIds)
  const upto = q.upToChapter ?? Number.MAX_SAFE_INTEGER
  const hits: MemoryHit[] = []

  if (wantedKinds.has("entity")) {
    for (const e of mem.graph.entities as Entity[]) {
      let score = idSet.has(e.id) ? 1 : 0
      score += textHits(`${e.name} ${e.aliases.join(" ")} ${e.currentState ?? ""}`, needles) * 0.5
      if (score > 0) hits.push({ kind: "entity", id: e.id, text: `${e.name}${e.currentState ? ` — ${e.currentState}` : ""}`, score, source: "structured" })
    }
  }
  if (wantedKinds.has("digest")) {
    for (const d of mem.digests) {
      if (d.chapter > upto) continue
      let score = d.entitiesPresent.some((id) => idSet.has(id)) ? 0.8 : 0
      score += textHits(`${d.oneLine} ${d.beats.join(" ")} ${d.hook ?? ""}`, needles) * 0.5
      // 近章轻微加权(越近越相关)
      score += Math.max(0, 1 - (upto - d.chapter) / 50) * 0.2
      if (score > 0) hits.push({ kind: "digest", id: `ch${d.chapter}`, text: `第${d.chapter}章:${d.oneLine}`, score, source: "structured" })
    }
  }
  if (wantedKinds.has("lore")) {
    for (const l of mem.lore as LoreEntry[]) {
      let score = l.alwaysOn ? 0.6 : 0
      score += textHits(`${l.title} ${l.keys.join(" ")}`, needles) * 0.6
      if (l.entityId && idSet.has(l.entityId)) score += 0.5
      if (score > 0) hits.push({ kind: "lore", id: l.id, text: `${l.title}:${l.text}`, score, source: "structured" })
    }
  }
  if (wantedKinds.has("foreshadow")) {
    for (const f of mem.graph.foreshadows as Foreshadow[]) {
      if (f.plantedChapter > upto) continue
      let score = f.entityIds.some((id) => idSet.has(id)) ? 0.7 : 0
      score += textHits(`${f.description} ${f.seedText ?? ""}`, needles) * 0.5
      if (f.state !== "paid-off") score += 0.3 // 未回收的更值得提醒
      if (score > 0) hits.push({ kind: "foreshadow", id: f.id, text: `伏笔(${f.state}):${f.description}`, score, source: "structured" })
    }
  }
  if (wantedKinds.has("timeline")) {
    for (const t of mem.graph.timeline as TimelineEvent[]) {
      if (t.chapter > upto) continue
      let score = t.entityIds.some((id) => idSet.has(id)) ? 0.6 : 0
      score += textHits(t.summary, needles) * 0.5
      if (score > 0) hits.push({ kind: "timeline", id: t.id, text: `第${t.chapter}章·${t.summary}`, score, source: "structured" })
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, q.limit)
}

// ── 零依赖内存实现(默认实现 + 单测用)──────────────────────
export class InMemoryStore implements MemoryStore {
  private books = new Map<string, BookMemory>()
  private account: AccountMemory = emptyAccountMemory()
  readonly embedder?: Embedder

  constructor(opts: { embedder?: Embedder; seedBooks?: Record<string, BookMemory>; seedAccount?: AccountMemory } = {}) {
    this.embedder = opts.embedder
    if (opts.seedBooks) for (const [k, v] of Object.entries(opts.seedBooks)) this.books.set(k, v)
    if (opts.seedAccount) this.account = opts.seedAccount
  }

  async loadBook(bookId: string): Promise<BookMemory> {
    return this.books.get(bookId) ?? emptyBookMemory(bookId)
  }
  async saveBook(bookId: string, mem: BookMemory): Promise<void> {
    this.books.set(bookId, mem)
  }
  async getDigest(bookId: string, chapter: number): Promise<ChapterDigest | undefined> {
    return (this.books.get(bookId)?.digests ?? []).find((d) => d.chapter === chapter)
  }
  async putDigest(bookId: string, digest: ChapterDigest): Promise<void> {
    const mem = await this.loadBook(bookId)
    const i = mem.digests.findIndex((d) => d.chapter === digest.chapter)
    if (i >= 0) mem.digests[i] = digest
    else mem.digests.push(digest)
    mem.digests.sort((a, b) => a.chapter - b.chapter)
    this.books.set(bookId, mem)
  }
  async loadAccount(): Promise<AccountMemory> {
    return this.account
  }
  async saveAccount(account: AccountMemory): Promise<void> {
    this.account = account
  }
  async search(bookId: string, q: MemoryQuery): Promise<MemoryHit[]> {
    return structuredSearch(await this.loadBook(bookId), q)
  }
}
