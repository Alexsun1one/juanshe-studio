import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDB } from "../state/memory-db.js";

describe("MemoryDB 活的故事知识图谱", () => {
  let bookDir: string;
  let db: MemoryDB;

  beforeEach(async () => {
    bookDir = await mkdtemp(join(tmpdir(), "graph-"));
    await mkdir(join(bookDir, "story"), { recursive: true });
    db = new MemoryDB(bookDir);
  });
  afterEach(async () => {
    db.close();
    await rm(bookDir, { recursive: true, force: true });
  });

  it("合并实体:别名并集、首末出场章、可按别名解析", () => {
    db.upsertEntity({ name: "陆星河", type: "person", aliases: ["凡凡"], chapter: 1 });
    db.upsertEntity({ name: "陆星河", aliases: ["小凡"], chapter: 5 });
    const e = db.getEntity("小凡"); // 按别名解析
    expect(e?.name).toBe("陆星河");
    expect(e?.type).toBe("person");
    expect(e?.aliases.split(",").sort()).toEqual(["凡凡", "小凡"].sort());
    expect(e?.firstChapter).toBe(1);
    expect(e?.lastChapter).toBe(5);
  });

  it("矛盾消解:单值属性新值作废旧值;多值关系累积", () => {
    db.upsertEntity({ name: "陆星河", chapter: 1 });
    db.upsertEntity({ name: "苏晚", chapter: 2 });
    db.upsertEntity({ name: "赵铁柱", chapter: 3 });
    const lin = MemoryDB.entityId("陆星河");

    // 单值状态:当前位置(后值作废前值)
    db.addRelation({ subjectId: lin, predicate: "当前位置", object: "灶台边", objectIsEntity: false, validFromChapter: 1, validUntilChapter: null, sourceChapter: 1, singleValued: true });
    const moved = db.addRelation({ subjectId: lin, predicate: "当前位置", object: "县城", objectIsEntity: false, validFromChapter: 10, validUntilChapter: null, sourceChapter: 10, singleValued: true });
    expect(moved.superseded).toBe(1);

    // 多值关系:盟友(累积,不作废)
    db.addRelation({ subjectId: lin, predicate: "盟友", object: MemoryDB.entityId("苏晚"), objectIsEntity: true, validFromChapter: 2, validUntilChapter: null, sourceChapter: 2 });
    const ally2 = db.addRelation({ subjectId: lin, predicate: "盟友", object: MemoryDB.entityId("赵铁柱"), objectIsEntity: true, validFromChapter: 3, validUntilChapter: null, sourceChapter: 3 });
    expect(ally2.superseded).toBe(0);

    // 幂等:重复同一条边不再插入
    const dup = db.addRelation({ subjectId: lin, predicate: "盟友", object: MemoryDB.entityId("苏晚"), objectIsEntity: true, validFromChapter: 2, validUntilChapter: null, sourceChapter: 4 });
    expect(dup.inserted).toBe(false);

    const card = db.getEntityCard("陆星河")!;
    expect(card.state.find((s) => s.predicate === "当前位置")?.object).toBe("县城");
    expect(card.state.some((s) => s.object === "灶台边")).toBe(false); // 旧值已作废
    expect(card.relations.filter((r) => r.predicate === "盟友").length).toBe(2);
    expect(card.neighbors.map((n) => n.name).sort()).toEqual(["苏晚", "赵铁柱"].sort());
  });

  it("时序:在过去章节看到的是当时的值(回溯一致)", () => {
    db.upsertEntity({ name: "陆星河", chapter: 1 });
    const lin = MemoryDB.entityId("陆星河");
    db.addRelation({ subjectId: lin, predicate: "当前位置", object: "灶台边", objectIsEntity: false, validFromChapter: 1, validUntilChapter: null, sourceChapter: 1, singleValued: true });
    db.addRelation({ subjectId: lin, predicate: "当前位置", object: "县城", objectIsEntity: false, validFromChapter: 10, validUntilChapter: null, sourceChapter: 10, singleValued: true });

    expect(db.getRelationsTouching(lin, 5).filter((r) => r.predicate === "当前位置").map((r) => r.object)).toEqual(["灶台边"]);
    expect(db.getRelationsTouching(lin, 12).filter((r) => r.predicate === "当前位置").map((r) => r.object)).toEqual(["县城"]);
  });

  it("图谱不被 facts 的 replaceCurrentFacts 清空(自有真相源)", () => {
    db.upsertEntity({ name: "陆星河", chapter: 1 });
    db.addRelation({ subjectId: MemoryDB.entityId("陆星河"), predicate: "掌握", object: "核心能力模块", objectIsEntity: false, validFromChapter: 1, validUntilChapter: null, sourceChapter: 1 });
    // 模拟检索期把 current_state.md 同步进 facts(会清空 facts 当前行),不应动到图谱
    db.replaceCurrentFacts([{ subject: "陆星河", predicate: "年龄", object: "3", validFromChapter: 1, validUntilChapter: null, sourceChapter: 1 }]);
    const stats = db.graphStats();
    expect(stats.entities).toBe(1);
    expect(stats.activeRelations).toBe(1);
    expect(db.getEntityCard("陆星河")!.state.length).toBe(1);
  });
});
