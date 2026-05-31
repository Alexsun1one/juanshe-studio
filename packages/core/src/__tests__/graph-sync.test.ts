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
    expect(res).toEqual({ entitiesUpserted: 0, relationsAdded: 0, superseded: 0 });
  });
});
