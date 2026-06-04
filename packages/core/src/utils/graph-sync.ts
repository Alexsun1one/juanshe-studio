import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryDB } from "../state/memory-db.js";
import { parseCharacterMatrix } from "../knowledge/character-matrix.js";
import { parseCurrentStateFacts } from "./story-markdown.js";

/** 一条结构化矛盾:新章在推翻一条已确立的"不可变事实"(死亡/血缘/身份/永久),不是合法状态更新。 */
export interface GraphContradiction {
  readonly subject: string;
  readonly predicate: string;
  readonly oldObject: string;
  readonly newObject: string;
  readonly establishedChapter: number;
  readonly chapter: number;
  readonly description: string;
}

export interface GraphSyncResult {
  readonly entitiesUpserted: number;
  readonly relationsAdded: number;
  readonly superseded: number;
  /** 落章前用图谱查出的"不可变事实被推翻"硬矛盾(continuity 错误,应拦截/复修)。 */
  readonly contradictions: ReadonlyArray<GraphContradiction>;
}

const EMPTY_RESULT: GraphSyncResult = { entitiesUpserted: 0, relationsAdded: 0, superseded: 0, contradictions: [] };

// 不可变事实:一旦确立,后续被推翻 = continuity 错误,而非合法状态更新。保守取高置信度类(死亡/血缘/身份/永久不可逆)。
const IMMUTABLE_PREDICATE = /生死|存活|死活|真实身份|本名|真名|血缘|身世|出身|亲生|父亲|母亲/;
const IMMUTABLE_OBJECT = /死了?|身亡|去世|逝世|牺牲|遇害|丧生|罹难|已故|永久|截肢|残废|彻底失明|彻底失忆/;
/** 旧值被新值推翻时,是否属于"不可变矛盾"(而非合法状态更新)。 */
function isImmutableConflict(predicate: string, oldObject: string): boolean {
  return IMMUTABLE_PREDICATE.test(predicate) || IMMUTABLE_OBJECT.test(oldObject);
}

/**
 * 把已落盘的真相文件增量同步进**活的故事知识图谱**(Phase 2 写路径):
 *   - character_matrix.md → 角色实体 + 角色间关系(多值累积) + 每角色「当前目标」(单值)
 *   - current_state.md   → 已知实体的硬状态(单值,后值作废前值=矛盾消解)
 *
 * 确定性、无 LLM、幂等;每章写完后调用,图谱随之自我生长、自我纠错。
 * 章节分析官已把这些真相文件写成结构化 Markdown,这里只做"解析→入图",不改写作主链的 LLM 契约。
 * db 可注入(测试用);否则自开自关。任何异常由调用方吞掉(best-effort,绝不阻断写作)。
 */
export async function syncStoryGraph(params: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly db?: MemoryDB;
}): Promise<GraphSyncResult> {
  const ownDb = !params.db;
  const ch = Math.max(0, Math.floor(Number(params.chapterNumber)) || 0);
  let entitiesUpserted = 0;
  let relationsAdded = 0;
  let superseded = 0;
  const contradictions: GraphContradiction[] = [];
  let db: MemoryDB | null = params.db ?? null;
  try {
    // 在 try 内构造:SQLite 不可用(老 Node)时静默返回空,不抛错、不污染告警(写作主链不受影响)。
    if (!db) db = new MemoryDB(params.bookDir);
    const storyDir = join(params.bookDir, "story");

    // 1) 角色矩阵 → 实体 + 关系 + 当前目标
    const matrixMd = await readFile(join(storyDir, "character_matrix.md"), "utf-8").catch(() => "");
    for (const entry of parseCharacterMatrix(matrixMd)) {
      const name = entry.name.trim();
      if (!name) continue;
      const summary = [entry.role, ...(entry.tags ?? [])].filter(Boolean).join(" · ").slice(0, 200);
      db.upsertEntity({ name, type: "person", summary, chapter: ch });
      entitiesUpserted++;

      if (entry.current && entry.current.trim()) {
        const r = db.addRelation({
          subjectId: MemoryDB.entityId(name), predicate: "当前目标", object: entry.current.trim().slice(0, 160),
          objectIsEntity: false, validFromChapter: ch, validUntilChapter: null, sourceChapter: ch, singleValued: true,
        });
        if (r.inserted) relationsAdded++;
        superseded += r.superseded;
      }

      for (const rel of entry.relations ?? []) {
        const target = (rel.target || "").trim();
        if (!target) continue;
        db.upsertEntity({ name: target, type: "person", chapter: ch });
        const r = db.addRelation({
          subjectId: MemoryDB.entityId(name), predicate: (rel.type || "关系").slice(0, 40), object: MemoryDB.entityId(target),
          objectIsEntity: true, validFromChapter: ch, validUntilChapter: null, sourceChapter: ch, singleValued: false,
        });
        if (r.inserted) relationsAdded++;
      }
    }

    // 2) 当前状态事实 → 硬状态。主角的状态 fact 主语常是字面 "protagonist"——
    // 原逻辑因它不是已知实体而整条跳过,导致主角的伤/债/约束/位置永远进不了"自有真相源"图谱(连续性丢分的根因之一)。
    // 这里把 protagonist/主角 这类别名规范到一个"主角"实体上(没有就建),让主角硬状态至少可查、可回灌给写手。
    const PROTAGONIST_STATE_ALIASES = new Set(["protagonist", "主角", "主人公", "主角色", "the protagonist"]);
    const stateMd = await readFile(join(storyDir, "current_state.md"), "utf-8").catch(() => "");
    for (const fact of parseCurrentStateFacts(stateMd, ch)) {
      let subject = (fact.subject || "").trim();
      const object = String(fact.object || "").trim();
      if (!subject || !object) continue;
      if (PROTAGONIST_STATE_ALIASES.has(subject.toLowerCase())) {
        subject = "主角";
        if (!db.getEntity(subject)) db.upsertEntity({ name: subject, type: "person", chapter: ch });
      }
      if (!db.getEntity(subject)) continue; // 其它非已知实体仍跳过,保持图谱干净
      const relToWrite = {
        subjectId: MemoryDB.entityId(subject), predicate: (fact.predicate || "状态").slice(0, 40), object: object.slice(0, 200),
        objectIsEntity: false, validFromChapter: ch, validUntilChapter: null, sourceChapter: ch, singleValued: true,
      };
      // 矛盾守门:写入前先查这条会作废哪些现行事实;被推翻的若是"不可变事实"(死亡/血缘/身份/永久),记为硬矛盾(而非合法更新)。
      for (const old of db.findActiveSupersededBy(relToWrite)) {
        if (isImmutableConflict(old.predicate, old.object)) {
          contradictions.push({
            subject, predicate: old.predicate, oldObject: old.object, newObject: relToWrite.object,
            establishedChapter: old.validFromChapter, chapter: ch,
            description: `第${ch}章把「${subject}·${old.predicate}」从第${old.validFromChapter}章确立的「${old.object}」改成「${relToWrite.object}」——不可逆事实疑似硬矛盾,请人工/复修确认。`,
          });
        }
      }
      // ② canon 权威源:不可变事实 → 锁进 canon(永不作废,跨任意章数都查得到);再查新事实是否违反已锁 canon。
      if (isImmutableConflict(relToWrite.predicate, relToWrite.object)) {
        db.lockCanonFact(subject, relToWrite.predicate, relToWrite.object, ch);
      }
      const canonConflict = db.findCanonContradiction(subject, relToWrite.predicate, relToWrite.object);
      if (canonConflict) {
        contradictions.push({
          subject, predicate: relToWrite.predicate, oldObject: canonConflict.lockedObject, newObject: relToWrite.object,
          establishedChapter: canonConflict.lockedSinceChapter, chapter: ch,
          description: `第${ch}章「${subject}·${relToWrite.predicate}=${relToWrite.object}」违反第${canonConflict.lockedSinceChapter}章锁定的 canon「${canonConflict.lockedObject}」——硬矛盾,请确认。`,
        });
      }
      const r = db.addRelation(relToWrite);
      if (r.inserted) relationsAdded++;
      superseded += r.superseded;
    }

    return { entitiesUpserted, relationsAdded, superseded, contradictions };
  } catch {
    return EMPTY_RESULT;
  } finally {
    if (ownDb && db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}
