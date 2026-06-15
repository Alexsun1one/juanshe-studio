import { describe, expect, it } from "vitest";
import { buildVolumeCadenceFileSet } from "../utils/volume-cadence-plan.js";

describe("buildVolumeCadenceFileSet", () => {
  it("writes a tier-2 cadence plan and KR progress ledger from volume_map + summaries", () => {
    const files = buildVolumeCadenceFileSet({
      volumeMap: [
        "# 卷纲地图",
        "## 第一卷：起航",
        "- 范围：第 1-20 章",
        "- KR1：拿下药园执事位置",
        "- KR2：与灵安峰结成稳定盟约",
        "- KR3：发现父辈案卷的第一半页残片",
      ].join("\n"),
      chapterSummaries: [
        "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| 1 | 入山 | 林辞 | 药园执事线启动 | 仍是杂役 | H1 | 紧绷 | build-up |",
        "| 2 | 试药 | 林辞 | KR1 拿下药园执事位置 | 成为执事候选 | H1 | 爽快 | payoff |",
        "| 3 | 山雨 | 林辞 | 灵安峰来人 | 盟约出现可能 | H2 | 压抑 | build-up |",
      ].join("\n"),
      futureWindow: 10,
    });

    expect(files).not.toBeNull();
    expect(files!.cadenceMarkdown).toContain("# 卷内章级节奏细纲");
    expect(files!.cadenceMarkdown).toContain("| 4 |");
    expect(files!.cadenceMarkdown).toContain("| 13 |");
    expect(files!.cadenceMarkdown).toContain("KR 进度信号");

    const parsed = JSON.parse(files!.krProgressJson) as {
      schema_version: number;
      next_chapter: number;
      kr_progress: Array<{ kr_id: string; elapsed_chapters: number; content_progress_percent: number }>;
    };
    expect(parsed.schema_version).toBe(1);
    expect(parsed.next_chapter).toBe(4);
    expect(parsed.kr_progress.map((kr) => kr.kr_id)).toEqual(["KR1", "KR2", "KR3"]);
    expect(parsed.kr_progress[0]!.elapsed_chapters).toBe(3);
    expect(parsed.kr_progress[0]!.content_progress_percent).toBeGreaterThan(0);
  });
});
