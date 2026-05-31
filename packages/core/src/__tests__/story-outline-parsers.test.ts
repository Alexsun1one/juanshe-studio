import { describe, expect, it } from "vitest";
import { parsePendingHooks, parseSubplotBoard, hooksByStartChapter } from "../knowledge/story-threads.js";
import { parseChapterSummaries, appearanceCounts } from "../knowledge/chapter-summaries.js";
import { parseVolumeMap } from "../knowledge/volume-map.js";
import { tensionByChapter } from "../knowledge/emotional-arcs.js";
import { parseEmotionalArcs } from "../knowledge/emotional-arcs.js";

const HOOKS = `| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 回收节奏 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H006 | 14 | 信息谜团 | pressured | 第15章：确认病孩林小雨 | 第16-18章 | immediate→mid-arc | 关系成谜 |
| H001 | 0 | 主线谜团 | open | 第15章：旧信物发热 | 长期 | mid-arc | 与H002联动 |
| H003 | 14 | 主线推进 | payoff | 第15章：确认目击者 | 已回收 | done | 物证完成 |`;

describe("parsePendingHooks", () => {
  it("parses hook rows with id/start/type/status", () => {
    const hooks = parsePendingHooks(HOOKS);
    expect(hooks).toHaveLength(3);
    expect(hooks[0]!.id).toBe("H006");
    expect(hooks[0]!.startChapter).toBe(14);
    expect(hooks[0]!.status).toBe("pressured");
    expect(hooks[1]!.type).toBe("主线谜团");
  });

  it("counts hooks per start chapter", () => {
    const map = hooksByStartChapter(parsePendingHooks(HOOKS));
    expect(map[14]).toBe(2);
    expect(map[0]).toBe(1);
  });
});

const SUBPLOT = `| 支线ID | 名称 | 起始章节 | 状态 | 最近推进 | 角色 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| S002 | 母子默契线 | 第1章 | deepened | 第15章：母亲未阻拦 | 沈清禾、陆星河 | 默契加深 |
| S006 | 谢沉舟父亲往事线 | 第15章 | open | 第15章：按旧疤 | 谢沉舟、谢长河 | 时间锚点 |`;

describe("parseSubplotBoard", () => {
  it("parses threads with characters split", () => {
    const t = parseSubplotBoard(SUBPLOT);
    expect(t).toHaveLength(2);
    expect(t[0]!.id).toBe("S002");
    expect(t[0]!.name).toBe("母子默契线");
    expect(t[0]!.startChapter).toBe(1);
    expect(t[0]!.characters).toEqual(["沈清禾", "陆星河"]);
    expect(t[1]!.status).toBe("open");
  });
});

const VOLMAP = `## 段 1：各卷主题与情绪曲线
全书八卷。第一卷"乡土觉醒"是泥味和血腥味——三岁的陆星河。第二卷"县城试刃"是铁锈味。第三卷"省城破圈"是墨粉味。

## 段 3：各卷 OKR
第一卷 O：从被压制的少年主角变成家里不敢再被欺负的人。
第二卷 O：完成家境翻身，成为县城内被认可的存在。`;

describe("parseVolumeMap", () => {
  it("extracts volume index + title from prose", () => {
    const vols = parseVolumeMap(VOLMAP);
    expect(vols.length).toBeGreaterThanOrEqual(3);
    expect(vols[0]!.index).toBe(1);
    expect(vols[0]!.title).toBe("乡土觉醒");
    expect(vols[1]!.title).toBe("县城试刃");
  });

  it("attaches OKR objective when present", () => {
    const vols = parseVolumeMap(VOLMAP);
    expect(vols[0]!.objective).toContain("不敢再被欺负");
    expect(vols[0]!.chapterStart).toBeNull(); // 散文未结构化章节范围
  });
});

const ARCS = `| 角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向 |
| --- | --- | --- | --- | --- | --- |
| 陆星河 | 第15章 | 平静→警觉 | 旧信物 | 8 | 理解并行动 |
| 谢沉舟 | 第15章 | 克制→信任 | 父亲 | 7 | 共担 |
| 陆星河 | 第14章 | 专注 | 勘察 | 6 | 推演 |`;

describe("tensionByChapter", () => {
  it("aggregates per-chapter peak tension", () => {
    const curve = tensionByChapter(parseEmotionalArcs(ARCS));
    expect(curve).toHaveLength(2);
    expect(curve[0]!.chapter).toBe(14);
    expect(curve[1]!.chapter).toBe(15);
    expect(curve[1]!.tension).toBe(8); // max(8,7)
    expect(curve[1]!.samples).toBe(2);
  });
});

const SUMMARIES = `# 章节摘要

| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |
|------|------|----------|----------|----------|----------|----------|----------|
| 第1章 | 第一封迟到的信 | 陆星河（少年主角）、沈清禾（母亲）、刘婶/张婶（邻居） | 王德彪上门收粮欺辱沈清禾 | 粮食被拉走 | H001首次推进 | 压抑中带冷芒 | 开篇章 |
| 第4章 | 粮袋里的账本 | 陆星河、沈清禾、何婶 | 陆星河完成首次商业闭环 | 粮缸暂安 | 新开S004 | 微小希望 | 过渡+事件章 |`;

describe("parseChapterSummaries", () => {
  it("parses rich summary table with cast and key events", () => {
    const cs = parseChapterSummaries(SUMMARIES);
    expect(cs).toHaveLength(2);
    expect(cs[0]!.chapter).toBe(1);
    expect(cs[0]!.title).toBe("第一封迟到的信");
    expect(cs[0]!.keyEvents).toContain("王德彪");
    expect(cs[0]!.mood).toContain("冷芒");
    expect(cs[0]!.type).toBe("开篇章");
    // 括注剥离 + 斜杠拆名
    expect(cs[0]!.characters).toContain("陆星河");
    expect(cs[0]!.characters).toContain("刘婶");
    expect(cs[0]!.characters).toContain("张婶");
    expect(cs[0]!.characters.every((n) => !n.includes("（"))).toBe(true);
  });

  it("computes real appearance counts across chapters", () => {
    const counts = appearanceCounts(parseChapterSummaries(SUMMARIES));
    expect(counts["陆星河"]).toBe(2);
    expect(counts["沈清禾"]).toBe(2);
    expect(counts["何婶"]).toBe(1);
  });
});
