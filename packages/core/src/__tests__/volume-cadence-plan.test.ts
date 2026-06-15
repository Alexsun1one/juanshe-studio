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
    expect(parsed.kr_progress[1]!.content_progress_percent).toBe(0);
  });

  it("uses volume_okr.json when prose volume_map intentionally has no chapter ranges", () => {
    const files = buildVolumeCadenceFileSet({
      volumeMap: [
        "# 卷纲地图",
        "第一卷写代写信客人与亡母悼词的线索推进，只给卷级方向，不写章号。",
      ].join("\n"),
      volumeOkrJson: JSON.stringify([
        {
          volume_index: 1,
          title: "第1卷：巷尾灯火",
          start_ch: 1,
          end_ch: 10,
          objective: "第5封亡母悼词线索被正式接住",
          krs: [
            {
              id: "KR1",
              desc: "代写信第5位客人登场并提出亡母悼词委托",
              must_advance_by_chapter: 4,
              target_chapters: [1, 3, 4],
            },
            {
              id: "KR2",
              desc: "主角确认悼词背后隐藏的母女关系真相",
              must_advance_by_chapter: 7,
              target_chapters: [5, 6, 7],
            },
          ],
        },
      ]),
      chapterSummaries: [
        "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| 1 | 灯下信 | 陆青 | 代写信第5位客人登场并提出亡母悼词委托 | 接下委托 | H1 | 温沉 | build-up |",
      ].join("\n"),
      futureWindow: 10,
    });

    expect(files).not.toBeNull();
    expect(files!.cadenceMarkdown).toContain("第1卷：巷尾灯火");
    expect(files!.cadenceMarkdown).toContain("| 2 |");
    const parsed = JSON.parse(files!.krProgressJson) as {
      generated_from: { volume_contract: string };
      current_volume: { start_chapter: number; end_chapter: number };
      kr_progress: Array<{ kr_id: string; description: string; content_progress_percent: number }>;
    };
    expect(parsed.generated_from.volume_contract).toBe("story/outline/volume_okr.json");
    expect(parsed.current_volume).toEqual({
      index: 1,
      name: "第1卷：巷尾灯火",
      start_chapter: 1,
      end_chapter: 10,
    });
    expect(parsed.kr_progress.map((kr) => kr.kr_id)).toEqual(["KR1", "KR2"]);
    expect(parsed.kr_progress[0]?.content_progress_percent).toBeGreaterThan(0);
  });

  it("allows an injected semantic matcher without adding a required runtime dependency", () => {
    const files = buildVolumeCadenceFileSet({
      volumeMap: "# 卷纲地图\n第一卷只写卷级方向。",
      volumeOkrJson: JSON.stringify([
        {
          volume_index: 1,
          title: "第1卷：巷尾灯火",
          start_ch: 1,
          end_ch: 10,
          objective: "第5封亡母悼词线索被正式接住",
          krs: [
            {
              id: "KR1",
              desc: "代写信第5位客人登场并提出亡母悼词委托",
              must_advance_by_chapter: 4,
              target_chapters: [1, 3, 4],
            },
            {
              id: "KR2",
              desc: "主角确认悼词背后隐藏的母女关系真相",
              must_advance_by_chapter: 7,
              target_chapters: [5, 6, 7],
            },
          ],
        },
      ]),
      chapterSummaries: [
        "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| 1 | 灯下信 | 陆青 | 语义模型判定这章推进了第二条 KR | 无 | H1 | 温沉 | build-up |",
      ].join("\n"),
      krSignalMatcher: (_text, kr) => kr.id === "KR2",
    });

    const parsed = JSON.parse(files!.krProgressJson) as {
      kr_progress: Array<{ kr_id: string; content_progress_percent: number }>;
    };
    expect(parsed.kr_progress[0]?.content_progress_percent).toBe(0);
    expect(parsed.kr_progress[1]?.content_progress_percent).toBeGreaterThan(0);
  });
});
