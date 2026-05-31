import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryDB } from "../state/memory-db.js";
import { parseCharacterMatrix } from "../knowledge/character-matrix.js";
import { parseCurrentStateFacts } from "./story-markdown.js";

export interface GraphSyncResult {
  readonly entitiesUpserted: number;
  readonly relationsAdded: number;
  readonly superseded: number;
}

const EMPTY_RESULT: GraphSyncResult = { entitiesUpserted: 0, relationsAdded: 0, superseded: 0 };

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

    // 2) 当前状态事实 → 已知实体的硬状态(单值)。只挂在"已是实体"的主语上,避免造出「主角/当前位置」之类垃圾节点。
    const stateMd = await readFile(join(storyDir, "current_state.md"), "utf-8").catch(() => "");
    for (const fact of parseCurrentStateFacts(stateMd, ch)) {
      const subject = (fact.subject || "").trim();
      const object = String(fact.object || "").trim();
      if (!subject || !object) continue;
      if (!db.getEntity(subject)) continue; // 非已知实体 → 跳过,保持图谱干净
      const r = db.addRelation({
        subjectId: MemoryDB.entityId(subject), predicate: (fact.predicate || "状态").slice(0, 40), object: object.slice(0, 200),
        objectIsEntity: false, validFromChapter: ch, validUntilChapter: null, sourceChapter: ch, singleValued: true,
      });
      if (r.inserted) relationsAdded++;
      superseded += r.superseded;
    }

    return { entitiesUpserted, relationsAdded, superseded };
  } catch {
    return EMPTY_RESULT;
  } finally {
    if (ownDb && db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}
