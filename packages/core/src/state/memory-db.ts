/**
 * Temporal memory database for HardWrite truth files.
 *
 * Uses Node.js built-in SQLite (node:sqlite, Node 22+).
 * Stores facts with temporal validity (valid_from/valid_until chapter numbers),
 * enabling precise queries like "what did character X know in chapter 5?"
 *
 * Backward compatible: existing markdown truth files are still the primary
 * persistence layer. MemoryDB is an acceleration index built alongside them.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const FACT_SELECT_COLUMNS = `
  id,
  subject,
  predicate,
  object,
  valid_from_chapter AS validFromChapter,
  valid_until_chapter AS validUntilChapter,
  source_chapter AS sourceChapter
`;

export interface Fact {
  readonly id?: number;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly validFromChapter: number;
  readonly validUntilChapter: number | null;
  readonly sourceChapter: number;
}

export interface StoredSummary {
  readonly chapter: number;
  readonly title: string;
  readonly characters: string;
  readonly events: string;
  readonly stateChanges: string;
  readonly hookActivity: string;
  readonly mood: string;
  readonly chapterType: string;
}

export interface StoredHook {
  readonly hookId: string;
  readonly startChapter: number;
  readonly type: string;
  readonly status: string;
  readonly lastAdvancedChapter: number;
  readonly expectedPayoff: string;
  readonly payoffTiming?: string;
  readonly notes: string;
  // Phase 7 — hook causality / promotion metadata.
  readonly dependsOn?: ReadonlyArray<string>;
  readonly paysOffInArc?: string;
  readonly coreHook?: boolean;
  readonly halfLifeChapters?: number;
  readonly advancedCount?: number;
  // Phase 7 hotfix 2 — whether the seed has been promoted into the live ledger
  // (architect-time structural rules + consolidator-time advanced_count rule).
  // Reviewer uses this to gate critical-severity escalation.
  readonly promoted?: boolean;
}

/**
 * 活的故事知识图谱(GraphRAG 风格,替代向量记忆)。
 * 节点 = 实体(人/物/地/组织/概念),边/属性 = 时序关系(带 valid_from/until,可被后续矛盾"作废")。
 * 与 `facts` 表的区别:facts 是 current_state.md 的可重建缓存(每次检索被 replaceCurrentFacts 全替换);
 * 图谱是**自有真相源**,由章节分析官每章增量写入、矛盾即作废,绝不被 replace 清空。
 */
export interface GraphEntity {
  readonly id: string;            // 规范 id(name 归一化)
  readonly name: string;          // 规范显示名
  readonly type: string;          // person / item / place / org / concept / other
  readonly aliases: string;       // 逗号分隔别名
  readonly summary: string;       // 一句话节点摘要
  readonly firstChapter: number;
  readonly lastChapter: number;
}

export interface GraphRelation {
  readonly id?: number;
  readonly subjectId: string;     // 主语实体 id
  readonly predicate: string;     // 谓词(关系或属性名,如 父子/当前位置/掌握技术)
  readonly object: string;        // 宾语:实体 id(objectIsEntity=true)或字面值
  readonly objectIsEntity: boolean;
  readonly validFromChapter: number;
  readonly validUntilChapter: number | null;
  readonly sourceChapter: number;
  /** 单值谓词(状态/属性,如 年龄/当前位置):写入时作废同主同谓的旧值=矛盾消解。多值(关系,如 盟友)则累积。 */
  readonly singleValued?: boolean;
}

export interface EntityCard {
  readonly entity: GraphEntity;
  readonly state: ReadonlyArray<GraphRelation>;      // 当前属性/状态(objectIsEntity=false)
  readonly relations: ReadonlyArray<GraphRelation>;  // 当前关系(objectIsEntity=true),主或宾命中本实体
  readonly neighbors: ReadonlyArray<GraphEntity>;    // 1 跳邻居实体
}

const RELATION_SELECT = `
  id,
  subject_id AS subjectId,
  predicate,
  object,
  object_is_entity AS objectIsEntity,
  valid_from_chapter AS validFromChapter,
  valid_until_chapter AS validUntilChapter,
  source_chapter AS sourceChapter
`;

export class MemoryDB {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor(bookDir: string) {
    // node:sqlite requires Node 22+; require() via createRequire for ESM compat
    const { DatabaseSync } = require("node:sqlite");
    const dbPath = join(bookDir, "story", "memory.db");
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        valid_from_chapter INTEGER NOT NULL,
        valid_until_chapter INTEGER,
        source_chapter INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS chapter_summaries (
        chapter INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        characters TEXT NOT NULL DEFAULT '',
        events TEXT NOT NULL DEFAULT '',
        state_changes TEXT NOT NULL DEFAULT '',
        hook_activity TEXT NOT NULL DEFAULT '',
        mood TEXT NOT NULL DEFAULT '',
        chapter_type TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS hooks (
        hook_id TEXT PRIMARY KEY,
        start_chapter INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        last_advanced_chapter INTEGER NOT NULL DEFAULT 0,
        expected_payoff TEXT NOT NULL DEFAULT '',
        payoff_timing TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject);
      CREATE INDEX IF NOT EXISTS idx_facts_valid ON facts(valid_from_chapter, valid_until_chapter);
      CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_chapter);
      CREATE INDEX IF NOT EXISTS idx_hooks_status ON hooks(status);
      CREATE INDEX IF NOT EXISTS idx_hooks_last_advanced ON hooks(last_advanced_chapter);

      -- 活的故事知识图谱:节点 + 时序边/属性(自有真相源,增量写入、矛盾作废,不被 replace 清空)
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'other',
        aliases TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        first_chapter INTEGER NOT NULL DEFAULT 0,
        last_chapter INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_id TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        object_is_entity INTEGER NOT NULL DEFAULT 0,
        valid_from_chapter INTEGER NOT NULL,
        valid_until_chapter INTEGER,
        source_chapter INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
      CREATE INDEX IF NOT EXISTS idx_relations_subject ON relations(subject_id, valid_until_chapter);
      CREATE INDEX IF NOT EXISTS idx_relations_object ON relations(object, object_is_entity, valid_until_chapter);

      -- 锁定事实(canon):一旦确立就不可逆的硬事实(死亡/真实身份/血缘/永久)。绝不作废,是全书"什么不能改"的单一权威源。
      CREATE TABLE IF NOT EXISTS canon (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        locked_since_chapter INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(subject, predicate)
      );
      CREATE INDEX IF NOT EXISTS idx_canon_subject ON canon(subject);
    `);

    this.ensureColumn("hooks", "payoff_timing", "TEXT NOT NULL DEFAULT ''");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch {
      // Column already exists on existing databases.
    }
  }

  // ---------------------------------------------------------------------------
  // Facts (temporal)
  // ---------------------------------------------------------------------------

  /** Add a new fact. */
  addFact(fact: Omit<Fact, "id">): number {
    const stmt = this.db.prepare(
      `INSERT INTO facts (subject, predicate, object, valid_from_chapter, valid_until_chapter, source_chapter)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      fact.subject, fact.predicate, fact.object,
      fact.validFromChapter, fact.validUntilChapter ?? null, fact.sourceChapter,
    );
    return Number(result.lastInsertRowid);
  }

  /** Invalidate a fact (set valid_until). */
  invalidateFact(id: number, untilChapter: number): void {
    this.db.prepare(
      "UPDATE facts SET valid_until_chapter = ? WHERE id = ?",
    ).run(untilChapter, id);
  }

  /** Get all currently valid facts (valid_until is null). */
  getCurrentFacts(): ReadonlyArray<Fact> {
    return this.db.prepare(
      `SELECT ${FACT_SELECT_COLUMNS}
       FROM facts
       WHERE valid_until_chapter IS NULL
       ORDER BY subject, predicate`,
    ).all() as unknown as Fact[];
  }

  /** Get facts about a specific subject that are valid at a given chapter. */
  getFactsAt(subject: string, chapter: number): ReadonlyArray<Fact> {
    return this.db.prepare(
      `SELECT ${FACT_SELECT_COLUMNS}
       FROM facts
       WHERE subject = ? AND valid_from_chapter <= ?
       AND (valid_until_chapter IS NULL OR valid_until_chapter > ?)
       ORDER BY predicate`,
    ).all(subject, chapter, chapter) as unknown as Fact[];
  }

  /** Get all facts about a subject (including historical). */
  getFactHistory(subject: string): ReadonlyArray<Fact> {
    return this.db.prepare(
      `SELECT ${FACT_SELECT_COLUMNS}
       FROM facts
       WHERE subject = ?
       ORDER BY valid_from_chapter`,
    ).all(subject) as unknown as Fact[];
  }

  /** Search facts by predicate (e.g., all "location" facts). */
  getFactsByPredicate(predicate: string): ReadonlyArray<Fact> {
    return this.db.prepare(
      `SELECT ${FACT_SELECT_COLUMNS}
       FROM facts
       WHERE predicate = ? AND valid_until_chapter IS NULL
       ORDER BY subject`,
    ).all(predicate) as unknown as Fact[];
  }

  /** Get facts relevant to a set of character names. */
  getFactsForCharacters(names: ReadonlyArray<string>): ReadonlyArray<Fact> {
    if (names.length === 0) return [];
    const placeholders = names.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT ${FACT_SELECT_COLUMNS}
       FROM facts
       WHERE subject IN (${placeholders}) AND valid_until_chapter IS NULL
       ORDER BY subject, predicate`,
    ).all(...names) as unknown as Fact[];
  }

  replaceCurrentFacts(facts: ReadonlyArray<Omit<Fact, "id">>): void {
    this.db.exec("DELETE FROM facts WHERE valid_until_chapter IS NULL");
    for (const fact of facts) {
      this.addFact(fact);
    }
  }

  resetFacts(): void {
    this.db.exec("DELETE FROM facts");
  }

  // ---------------------------------------------------------------------------
  // Chapter summaries
  // ---------------------------------------------------------------------------

  /** Upsert a chapter summary. */
  upsertSummary(summary: StoredSummary): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO chapter_summaries (chapter, title, characters, events, state_changes, hook_activity, mood, chapter_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      summary.chapter, summary.title, summary.characters, summary.events,
      summary.stateChanges, summary.hookActivity, summary.mood, summary.chapterType,
    );
  }

  replaceSummaries(summaries: ReadonlyArray<StoredSummary>): void {
    this.db.exec("DELETE FROM chapter_summaries");
    for (const summary of summaries) {
      this.upsertSummary(summary);
    }
  }

  /** Get summaries for a range of chapters. */
  getSummaries(fromChapter: number, toChapter: number): ReadonlyArray<StoredSummary> {
    return this.db.prepare(
      `SELECT
         chapter,
         title,
         characters,
         events,
         state_changes AS stateChanges,
         hook_activity AS hookActivity,
         mood,
         chapter_type AS chapterType
       FROM chapter_summaries
       WHERE chapter >= ? AND chapter <= ?
       ORDER BY chapter`,
    ).all(fromChapter, toChapter) as unknown as StoredSummary[];
  }

  /** Get summaries matching any of the given character names. */
  getSummariesByCharacters(names: ReadonlyArray<string>): ReadonlyArray<StoredSummary> {
    if (names.length === 0) return [];
    const conditions = names.map(() => "characters LIKE ?").join(" OR ");
    const params = names.map((n) => `%${n}%`);
    return this.db.prepare(
      `SELECT
         chapter,
         title,
         characters,
         events,
         state_changes AS stateChanges,
         hook_activity AS hookActivity,
         mood,
         chapter_type AS chapterType
       FROM chapter_summaries
       WHERE ${conditions}
       ORDER BY chapter`,
    ).all(...params) as unknown as StoredSummary[];
  }

  /** Get total chapter count. */
  getChapterCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM chapter_summaries").get() as unknown as { count: number };
    return row.count;
  }

  /** Get the most recent N summaries. */
  getRecentSummaries(count: number): ReadonlyArray<StoredSummary> {
    return this.db.prepare(
      `SELECT
         chapter,
         title,
         characters,
         events,
         state_changes AS stateChanges,
         hook_activity AS hookActivity,
         mood,
         chapter_type AS chapterType
       FROM chapter_summaries
       ORDER BY chapter DESC
       LIMIT ?`,
    ).all(count) as unknown as ReadonlyArray<StoredSummary>;
  }

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------

  upsertHook(hook: StoredHook): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO hooks (hook_id, start_chapter, type, status, last_advanced_chapter, expected_payoff, payoff_timing, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hook.hookId,
      hook.startChapter,
      hook.type,
      hook.status,
      hook.lastAdvancedChapter,
      hook.expectedPayoff,
      hook.payoffTiming ?? "",
      hook.notes,
    );
  }

  replaceHooks(hooks: ReadonlyArray<StoredHook>): void {
    this.db.exec("DELETE FROM hooks");
    for (const hook of hooks) {
      this.upsertHook(hook);
    }
  }

  getActiveHooks(): ReadonlyArray<StoredHook> {
    return this.db.prepare(
      `SELECT
         hook_id AS hookId,
         start_chapter AS startChapter,
         type,
         status,
         last_advanced_chapter AS lastAdvancedChapter,
         expected_payoff AS expectedPayoff,
         payoff_timing AS payoffTiming,
         notes
       FROM hooks
       WHERE lower(status) NOT IN ('resolved', 'closed', '已回收', '已解决')
       ORDER BY last_advanced_chapter DESC, start_chapter DESC, hook_id ASC`,
    ).all() as unknown as ReadonlyArray<StoredHook>;
  }

  // ---------------------------------------------------------------------------
  // 活的故事知识图谱(实体 + 时序关系/属性,矛盾即作废)
  // ---------------------------------------------------------------------------

  /** 把实体名归一化成稳定 id(去空格/标点、转小写)。 */
  static entityId(name: string): string {
    return String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[\s《》"'“”·,，。.、!！?？:：;；()（）\[\]【】]/g, "")
      || "_";
  }

  /** 新增/合并实体节点(别名并集,刷新首末出场章、摘要)。 */
  upsertEntity(input: { name: string; type?: string; aliases?: ReadonlyArray<string>; summary?: string; chapter?: number }): GraphEntity {
    const id = MemoryDB.entityId(input.name);
    const existing = this.db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    const aliasSet = new Set<string>();
    if (existing?.aliases) String(existing.aliases).split(",").map((a) => a.trim()).filter(Boolean).forEach((a) => aliasSet.add(a));
    (input.aliases ?? []).map((a) => a.trim()).filter(Boolean).forEach((a) => aliasSet.add(a));
    const chapter = input.chapter ?? 0;
    const first = existing ? Math.min(Number(existing.first_chapter) || chapter || 0, chapter || Number(existing.first_chapter) || 0) : chapter;
    const last = Math.max(Number(existing?.last_chapter) || 0, chapter);
    const entity: GraphEntity = {
      id,
      name: String(existing?.name || input.name),
      type: input.type || String(existing?.type || "other"),
      aliases: [...aliasSet].join(","),
      summary: input.summary || String(existing?.summary || ""),
      firstChapter: first || 0,
      lastChapter: last || 0,
    };
    this.db.prepare(
      `INSERT OR REPLACE INTO entities (id, name, type, aliases, summary, first_chapter, last_chapter, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(entity.id, entity.name, entity.type, entity.aliases, entity.summary, entity.firstChapter, entity.lastChapter);
    return entity;
  }

  /** 仅更新实体类型(存量纠偏用,不动出场章/别名/摘要)。type 相同则跳过。 */
  retypeEntity(nameOrId: string, type: string): boolean {
    const id = MemoryDB.entityId(nameOrId);
    const res = this.db.prepare(
      "UPDATE entities SET type = ?, updated_at = datetime('now') WHERE id = ? AND type <> ?",
    ).run(type, id, type);
    return Number(res.changes || 0) > 0;
  }

  /** 按 id / 规范名 / 别名解析实体。 */
  getEntity(nameOrId: string): GraphEntity | null {
    const id = MemoryDB.entityId(nameOrId);
    const row = (this.db.prepare("SELECT id, name, type, aliases, summary, first_chapter AS firstChapter, last_chapter AS lastChapter FROM entities WHERE id = ?").get(id)
      ?? this.db.prepare(`SELECT id, name, type, aliases, summary, first_chapter AS firstChapter, last_chapter AS lastChapter FROM entities WHERE (','||replace(lower(aliases),' ','')||',') LIKE ?`).get(`%,${id},%`)) as GraphEntity | undefined;
    return row ?? null;
  }

  listEntities(type?: string): ReadonlyArray<GraphEntity> {
    const base = "SELECT id, name, type, aliases, summary, first_chapter AS firstChapter, last_chapter AS lastChapter FROM entities";
    return (type
      ? this.db.prepare(`${base} WHERE type = ? ORDER BY last_chapter DESC, name`).all(type)
      : this.db.prepare(`${base} ORDER BY last_chapter DESC, name`).all()) as unknown as GraphEntity[];
  }

  /**
   * 写入一条时序关系/属性,**矛盾即作废**:
   * - singleValued(状态/属性,如 当前位置/年龄):作废同主同谓但宾不同的现行边(valid_until=本章)。
   * - 完全相同(同主同谓同宾)的现行边已存在:幂等不重复插入。
   * 返回 { inserted, superseded } 供观测/校验。
   */
  addRelation(rel: GraphRelation): { inserted: boolean; superseded: number } {
    let superseded = 0;
    if (rel.singleValued) {
      const res = this.db.prepare(
        `UPDATE relations SET valid_until_chapter = ?
         WHERE subject_id = ? AND predicate = ? AND object <> ? AND valid_until_chapter IS NULL`,
      ).run(rel.sourceChapter, rel.subjectId, rel.predicate, rel.object);
      superseded = Number(res.changes || 0);
    }
    const dup = this.db.prepare(
      "SELECT id FROM relations WHERE subject_id = ? AND predicate = ? AND object = ? AND valid_until_chapter IS NULL LIMIT 1",
    ).get(rel.subjectId, rel.predicate, rel.object);
    if (dup) return { inserted: false, superseded };
    this.db.prepare(
      `INSERT INTO relations (subject_id, predicate, object, object_is_entity, valid_from_chapter, valid_until_chapter, source_chapter)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(rel.subjectId, rel.predicate, rel.object, rel.objectIsEntity ? 1 : 0, rel.validFromChapter, rel.validUntilChapter ?? null, rel.sourceChapter);
    return { inserted: true, superseded };
  }

  /**
   * 只读:若写入 rel(singleValued),会作废哪些现行边(同主、同谓、宾不同、未作废)。
   * 供"矛盾守门"在写入前判定——新章是否在推翻一条已确立的事实,而不写库。
   */
  findActiveSupersededBy(rel: { subjectId: string; predicate: string; object: string; singleValued?: boolean }): ReadonlyArray<GraphRelation> {
    if (!rel.singleValued) return [];
    const rows = this.db.prepare(
      `SELECT ${RELATION_SELECT} FROM relations
       WHERE subject_id = ? AND predicate = ? AND object <> ? AND valid_until_chapter IS NULL`,
    ).all(rel.subjectId, rel.predicate, rel.object) as Record<string, unknown>[];
    return rows.map((r) => this.mapRelation(r));
  }

  // ── 锁定事实(canon)·不可变硬事实的单一权威源 ──

  /** 锁定一条不可变 canon 事实。同主同谓只锁第一次确立的值(幂等;后续不同值不覆盖,由 findCanonContradiction 检出冲突)。 */
  lockCanonFact(subject: string, predicate: string, object: string, chapter: number): { locked: boolean } {
    const res = this.db.prepare(
      `INSERT OR IGNORE INTO canon (subject, predicate, object, locked_since_chapter) VALUES (?, ?, ?, ?)`,
    ).run(subject.trim(), predicate.trim(), object.trim(), Math.max(0, Math.floor(chapter) || 0));
    return { locked: Number(res.changes || 0) > 0 };
  }

  /** 全部 canon 事实(给写手注入"不可违反的锁定事实"用,做预防)。 */
  getCanonFacts(): ReadonlyArray<{ subject: string; predicate: string; object: string; lockedSinceChapter: number }> {
    const rows = this.db.prepare(
      `SELECT subject, predicate, object, locked_since_chapter AS lockedSinceChapter FROM canon ORDER BY locked_since_chapter`,
    ).all() as Record<string, unknown>[];
    return rows.map((r) => ({ subject: String(r.subject), predicate: String(r.predicate), object: String(r.object), lockedSinceChapter: Number(r.lockedSinceChapter) }));
  }

  /** 查新事实是否与已锁定 canon 冲突(同主同谓、值不同)。返回被冲突的 canon 事实;无冲突返回 null。 */
  findCanonContradiction(subject: string, predicate: string, object: string): { subject: string; predicate: string; lockedObject: string; lockedSinceChapter: number } | null {
    const row = this.db.prepare(
      `SELECT subject, predicate, object, locked_since_chapter AS lockedSinceChapter FROM canon WHERE subject = ? AND predicate = ? AND object <> ? LIMIT 1`,
    ).get(subject.trim(), predicate.trim(), object.trim()) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { subject: String(row.subject), predicate: String(row.predicate), lockedObject: String(row.object), lockedSinceChapter: Number(row.lockedSinceChapter) };
  }

  private mapRelation(row: Record<string, unknown>): GraphRelation {
    return {
      id: Number(row.id),
      subjectId: String(row.subjectId),
      predicate: String(row.predicate),
      object: String(row.object),
      objectIsEntity: Number(row.objectIsEntity) === 1,
      validFromChapter: Number(row.validFromChapter),
      validUntilChapter: row.validUntilChapter == null ? null : Number(row.validUntilChapter),
      sourceChapter: Number(row.sourceChapter),
    };
  }

  /** 实体在某章时点上"现行"的关系/属性(主语或宾语命中该实体)。chapter 缺省 = 取所有未作废的。 */
  getRelationsTouching(entityId: string, chapter?: number): ReadonlyArray<GraphRelation> {
    const validClause = chapter == null
      ? "valid_until_chapter IS NULL"
      : "valid_from_chapter <= @ch AND (valid_until_chapter IS NULL OR valid_until_chapter > @ch)";
    const rows = this.db.prepare(
      `SELECT ${RELATION_SELECT} FROM relations
       WHERE (subject_id = @id OR (object = @id AND object_is_entity = 1)) AND ${validClause}
       ORDER BY valid_from_chapter DESC`,
    ).all(chapter == null ? { id: entityId } : { id: entityId, ch: chapter }) as Record<string, unknown>[];
    return rows.map((r) => this.mapRelation(r));
  }

  /** 实体卡:节点 + 当前属性/状态 + 当前关系 + 1 跳邻居实体。图遍历注入的核心读路径。 */
  getEntityCard(nameOrId: string, chapter?: number): EntityCard | null {
    const entity = this.getEntity(nameOrId);
    if (!entity) return null;
    const touching = this.getRelationsTouching(entity.id, chapter);
    const state = touching.filter((r) => r.subjectId === entity.id && !r.objectIsEntity);
    const relations = touching.filter((r) => r.objectIsEntity);
    const neighborIds = [...new Set(relations.map((r) => (r.subjectId === entity.id ? r.object : r.subjectId)).filter((nid) => nid && nid !== entity.id))];
    const neighbors = neighborIds.map((nid) => this.getEntity(nid)).filter((e): e is GraphEntity => Boolean(e));
    return { entity, state, relations, neighbors };
  }

  graphStats(): { entities: number; relations: number; activeRelations: number } {
    const e = this.db.prepare("SELECT COUNT(*) AS c FROM entities").get() as { c: number };
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM relations").get() as { c: number };
    const a = this.db.prepare("SELECT COUNT(*) AS c FROM relations WHERE valid_until_chapter IS NULL").get() as { c: number };
    return { entities: Number(e.c), relations: Number(r.c), activeRelations: Number(a.c) };
  }

  resetGraph(): void {
    this.db.exec("DELETE FROM relations; DELETE FROM entities;");
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}
