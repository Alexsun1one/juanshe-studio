import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDB } from "../state/memory-db.js";
import { syncStoryGraph } from "../utils/graph-sync.js";

describe("syncStoryGraph(Phase 2 · 真相文件 → 活图谱)", () => {
  let bookDir: string;
  let db: MemoryDB;

  beforeEach(async () => {
    bookDir = await mkdtemp(join(tmpdir(), "gsync-"));
    await mkdir(join(bookDir, "story"), { recursive: true });
    db = new MemoryDB(bookDir);
  });
  afterEach(async () => {
    db.close();
    await rm(bookDir, { recursive: true, force: true });
  });

  const writeMatrix = (content: string) => writeFile(join(bookDir, "story", "character_matrix.md"), content, "utf-8");
  const writeLocked = (content: string) => writeFile(join(bookDir, "story", "locked_facts.md"), content, "utf-8");

  it("从 character_matrix 建实体 + 关系 + 当前目标", async () => {
    await writeMatrix([
      "## 陆星河",
      "- **定位**: 主角",
      "- **标签**: 重生, 工程系统科学家",
      "- **当前**: 退烧后认知校准",
      "- **关系**: 沈清禾(母亲/Ch1) | 周牧(宿敌/Ch1)",
      "",
      "## 沈清禾",
      "- **定位**: 母亲",
      "- **关系**: 陆星河(儿子/Ch1)",
      "",
    ].join("\n"));

    const res = await syncStoryGraph({ bookDir, chapterNumber: 1, db });
    expect(res.entitiesUpserted).toBeGreaterThanOrEqual(2);

    const card = db.getEntityCard("陆星河")!;
    expect(card.entity.type).toBe("person");
    expect(card.state.find((s) => s.predicate === "当前目标")?.object).toBe("退烧后认知校准");
    expect(card.relations.some((r) => r.predicate === "母亲")).toBe(true);
    expect(card.neighbors.map((n) => n.name).sort()).toEqual(["周牧", "沈清禾"].sort());
  });

  it("再次同步、当前目标变化 → 单值状态作废旧值(矛盾消解 + 时序回溯)", async () => {
    await writeMatrix("## 陆星河\n- **定位**: 主角\n- **当前**: 灶台边反杀\n");
    await syncStoryGraph({ bookDir, chapterNumber: 1, db });

    await writeMatrix("## 陆星河\n- **定位**: 主角\n- **当前**: 县城布局\n");
    const res2 = await syncStoryGraph({ bookDir, chapterNumber: 10, db });
    expect(res2.superseded).toBeGreaterThanOrEqual(1);

    const card = db.getEntityCard("陆星河")!;
    expect(card.state.find((s) => s.predicate === "当前目标")?.object).toBe("县城布局");
    // 时序:第 5 章时点仍是旧目标(回溯一致)
    const at5 = db.getRelationsTouching(MemoryDB.entityId("陆星河"), 5).find((r) => r.predicate === "当前目标");
    expect(at5?.object).toBe("灶台边反杀");
  });

  it("无 character_matrix 时安全返回空结果(不抛错)", async () => {
    const res = await syncStoryGraph({ bookDir, chapterNumber: 1, db });
    expect(res).toEqual({ entitiesUpserted: 0, relationsAdded: 0, superseded: 0, contradictions: [] });
  });

  it("locked_facts.md → 把本章不可变硬事实锁进 canon(主语缺失会自动建实体)", async () => {
    await writeLocked([
      "# 锁定事实",
      "",
      "- [ch1] 王老五: 生死=已故",
      "- [ch1] 沈砚: 血缘=沈鹤是沈砚的父亲",
      "- [ch2] 沈砚: 真实身份=听物者", // 不属于第 1 章,本次不应锁
    ].join("\n"));

    await syncStoryGraph({ bookDir, chapterNumber: 1, db });
    const canon = db.getCanonFacts();
    expect(canon.some((f) => f.subject === "王老五" && f.predicate === "生死" && f.object === "已故")).toBe(true);
    expect(canon.some((f) => f.subject === "沈砚" && f.predicate === "血缘" && f.object === "沈鹤是沈砚的父亲")).toBe(true);
    // 第 2 章的真实身份这次不锁(只处理本章)
    expect(canon.some((f) => f.predicate === "真实身份")).toBe(false);
  });

  it("跨章推翻已锁 canon → 报硬矛盾(死人复活拦得住)", async () => {
    await writeLocked("- [ch1] 林冲: 生死=已故\n- [ch7] 林冲: 生死=存活\n");
    const res1 = await syncStoryGraph({ bookDir, chapterNumber: 1, db });
    expect(res1.contradictions).toEqual([]); // 首次锁定,无冲突

    const res7 = await syncStoryGraph({ bookDir, chapterNumber: 7, db });
    expect(res7.contradictions).toHaveLength(1);
    expect(res7.contradictions[0]).toMatchObject({
      subject: "林冲", predicate: "生死", oldObject: "已故", newObject: "存活",
      establishedChapter: 1, chapter: 7,
    });
    // canon 首值不可逆:仍是"已故"(死亡不会被后续章静默改写)
    expect(db.getCanonFacts().find((f) => f.subject === "林冲")?.object).toBe("已故");
  });
});
