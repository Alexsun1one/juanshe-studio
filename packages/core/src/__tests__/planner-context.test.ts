import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDormantSubplotRevivalHints,
  composeCurrentArcProse,
  extractCollaboratorRows,
  extractOpponentRows,
  extractProtagonistRow,
  extractRelevantThreads,
  readLastAuditFeedback,
  readVolumeCadenceGuidance,
} from "../agents/planner-context.js";

// Real column layouts match the production truth-file schemas under story/.
// Keeping these literal samples in tests guards against the kind of
// off-by-one column bug that slipped past Phase 3 review.
const EMOTIONAL_ARCS_SAMPLE = `
| 角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向 |
|------|------|----------|----------|-------------|----------|
| 周谨川 | 36 | 紧绷 | 门前对峙 | 8 | 升级 |
| 周谨川 | 37 | 克制发热 | 逼对方亮身份 | 9 | 升级 |
| 周谨川 | 38 | 骤亮后阴冷 | 看见顾明诚收 | 10 | 顶点 |
`;

const CHARACTER_MATRIX_SAMPLE = `
| 角色 | 核心标签 | 反差细节 | 说话风格 | 性格底色 | 与主角关系 | 核心动机 | 当前目标 |
|------|----------|----------|----------|----------|------------|----------|----------|
| 周谨川 | 带伤守证者 | 起不来身却硬顶 | 短、硬 | 克制耐痛 | 主角本人 | 不让资料被收走 | 守现场 |
| 草帽男 | 止损执行节点 | 明对手却急坏 | 装熟翻脸 | 控场欲 | 敌对监视者 | 护住七号门 | 顶住门边 |
| 修锁老师傅 | 一线手艺证人 | 不抢话却硬护场 | 平、稳 | 老练 | 临时协力 | 看锁说锁 | 守住现场事实 |
`;

const SUBPLOT_BOARD_SAMPLE = `
| S001 | 三担保排查 | 主角 | ch1 | ch38 | 0 | 推进 | 核心旧账线 | 1章 |
| S007 | 货款线 | 主角 | ch3 | ch4 | 34 | 暂挂 | 冻结 | 4-6章 |
`;

describe("composeCurrentArcProse reads chapter from emotional_arcs column 1", () => {
  it("filters rows by chapter from column index 1 (章节), not column 0 (角色)", () => {
    // Previously the function filtered where row[0] matched /^\d+$/.
    // Since row[0] is "周谨川" here, the old predicate produced zero matches
    // and "近期情感线" fell out of the composed prose entirely.
    const prose = composeCurrentArcProse(
      SUBPLOT_BOARD_SAMPLE,
      EMOTIONAL_ARCS_SAMPLE,
      39,
    );
    expect(prose).toContain("近期情感线");
    expect(prose).toContain("紧绷");
    expect(prose).toContain("克制发热");
    expect(prose).toContain("骤亮后阴冷");
  });

  it("excludes rows at or beyond the current chapter", () => {
    const prose = composeCurrentArcProse(
      SUBPLOT_BOARD_SAMPLE,
      EMOTIONAL_ARCS_SAMPLE,
      37,
    );
    expect(prose).toContain("紧绷");
    expect(prose).not.toContain("克制发热");
    expect(prose).not.toContain("骤亮后阴冷");
  });

  it("still composes active subplots when emotional arcs are empty", () => {
    const prose = composeCurrentArcProse(SUBPLOT_BOARD_SAMPLE, "", 39);
    expect(prose).toContain("活跃支线");
    expect(prose).toContain("S001");
    expect(prose).not.toContain("S007");
  });

  it("returns the empty-state sentinel only when nothing is extractable", () => {
    const prose = composeCurrentArcProse("", "", 1);
    expect(prose).toContain("暂无 arc 数据");
  });
});

describe("extractProtagonistRow", () => {
  it("matches the real convention '主角本人', not only the exact token '主角'", () => {
    const row = extractProtagonistRow(CHARACTER_MATRIX_SAMPLE);
    expect(row).toContain("周谨川");
    expect(row).toContain("主角本人");
  });

  it("falls back to the first data row when no protagonist marker is found", () => {
    const noMarker = `
| 角色 | 核心标签 | 与主角关系 |
|------|----------|------------|
| 李沉 | 重生者 | — |
| 王一 | 对手 | 敌对 |
`;
    const row = extractProtagonistRow(noMarker);
    expect(row).toContain("李沉");
  });

  it("returns the sentinel only when the matrix has zero data rows", () => {
    const empty = `
| 角色 | 核心标签 |
|------|----------|
`;
    const row = extractProtagonistRow(empty);
    expect(row).toContain("未找到主角行");
  });
});

describe("extractOpponentRows / extractCollaboratorRows", () => {
  it("picks opponents by 与主角关系 semantic keywords", () => {
    const rows = extractOpponentRows(CHARACTER_MATRIX_SAMPLE, 3);
    expect(rows).toContain("草帽男");
    expect(rows).not.toContain("周谨川");
  });

  it("picks collaborators by 与主角关系 semantic keywords", () => {
    const rows = extractCollaboratorRows(CHARACTER_MATRIX_SAMPLE, 3);
    expect(rows).toContain("修锁老师傅");
    expect(rows).not.toContain("草帽男");
  });
});

describe("extractRelevantThreads", () => {
  it("selects active hooks and subplots, filtering dormant/stale", () => {
    const hooks = `
| hook_id | 状态 | 最近推进 |
|---------|------|----------|
| H001 | activating | ch38 |
| H002 | dormant | ch20 |
| H003 | partial_payoff | ch37 |
`;
    const subplots = `
| S001 | 主线追查 | 推进 |
| S007 | 旁线 | 暂挂 |
`;
    const threads = extractRelevantThreads(hooks, subplots);
    expect(threads).toContain("H001");
    expect(threads).toContain("H003");
    expect(threads).not.toContain("H002");
    expect(threads).toContain("S001");
    expect(threads).not.toContain("S007");
  });
});

describe("buildDormantSubplotRevivalHints", () => {
  it("surfaces top dormant subplot candidates only when active subplot count is low", () => {
    const board = `
| id | 支线 | 负责人 | 起始 | 最近推进 | 沉寂 | 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S001 | 主线追查 | 主角 | ch1 | ch20 | 0 | 推进 | 当前压力 |
| S007 | 货款线 | 主角 | ch3 | ch4 | 30 | 暂挂 | 可接回账本 |
| S008 | 师债线 | 主角 | ch8 | ch18 | 16 | dormant | 可接回信物 |
`;
    const hints = buildDormantSubplotRevivalHints(board, 35);

    expect(hints).toContain("当前活跃支线 1 条");
    expect(hints).toContain("S007");
    expect(hints).toContain("沉寂 30 章");
    expect(hints).toContain("S008");
  });

  it("does not prompt revival while active subplot budget is already full", () => {
    const board = `
| id | 支线 | 状态 |
| --- | --- | --- |
| S001 | 主线追查 | 推进 |
| S002 | 对手交易 | 高压 |
| S007 | 货款线 | 暂挂 |
`;
    const hints = buildDormantSubplotRevivalHints(board, 35);

    expect(hints).toContain("暂无需要复活");
  });
});

describe("readLastAuditFeedback", () => {
  it("formats runtime JSON feedback for planner repair constraints", async () => {
    const root = await mkdtemp(join(tmpdir(), "planner-audit-feedback-"));
    try {
      const storyDir = join(root, "story");
      await mkdir(join(storyDir, "runtime"), { recursive: true });
      await writeFile(
        join(storyDir, "runtime", "last_audit_feedback.json"),
        JSON.stringify({
          schema_version: 1,
          source_chapter: 34,
          issues: [{
            severity: "critical",
            category: "节奏单调",
            description: "连续六章只复述调查，没有硬变化。",
            suggestion: "下一章必须让证据易手或关系破裂。",
          }],
        }),
        "utf-8",
      );

      const feedback = await readLastAuditFeedback(storyDir);

      expect(feedback).toContain("第 34 章");
      expect(feedback).toContain("[critical] 节奏单调");
      expect(feedback).toContain("证据易手");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to legacy audit_drift.md when JSON is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "planner-audit-drift-"));
    try {
      const storyDir = join(root, "story");
      await mkdir(storyDir, { recursive: true });
      await writeFile(
        join(storyDir, "audit_drift.md"),
        [
          "# 审计纠偏",
          "",
          "> - [warning] 支线停滞: S007 沉寂太久。",
        ].join("\n"),
        "utf-8",
      );

      const feedback = await readLastAuditFeedback(storyDir);

      expect(feedback).toContain("legacy audit_drift.md");
      expect(feedback).toContain("支线停滞");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("readVolumeCadenceGuidance", () => {
  it("compresses lagging KR progress and upcoming beat rows for planner", async () => {
    const root = await mkdtemp(join(tmpdir(), "planner-volume-cadence-"));
    try {
      const storyDir = join(root, "story");
      await mkdir(storyDir, { recursive: true });
      await Promise.all([
        writeFile(
          join(storyDir, "progress_against_volume_kr.json"),
          JSON.stringify({
            schema_version: 1,
            current_volume: { name: "第一卷：起航" },
            next_chapter: 14,
            kr_progress: [
              {
                kr_id: "KR2",
                description: "与灵安峰结成稳定盟约",
                expected_chapters: 6,
                elapsed_chapters: 9,
                content_progress_percent: 20,
                status: "lagging",
              },
            ],
          }),
          "utf-8",
        ),
        writeFile(
          join(storyDir, "volume_chapter_cadence.md"),
          [
            "| 章节 | 宏观角色 | KR 焦点 | 必须发生的推进 |",
            "| --- | --- | --- | --- |",
            "| 14 | build-up | KR2 | 加速补 KR：耗章超标但内容进度滞后 |",
          ].join("\n"),
          "utf-8",
        ),
      ]);

      const guidance = await readVolumeCadenceGuidance(storyDir, "zh");

      expect(guidance).toContain("卷内章级节奏 / KR 进度");
      expect(guidance).toContain("KR2 [lagging]");
      expect(guidance).toContain("本章要加速");
      expect(guidance).toContain("ch14");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
