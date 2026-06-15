import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractChapterSummaryNumbers,
  upsertChapterSummaryFile,
} from "../utils/story-truth-writer.js";
import {
  buildOpeningLedgerBrief,
  extractOpeningSignature,
  upsertOpeningLedgerFile,
} from "../utils/opening-ledger.js";
import { saveRuntimeStateSnapshot } from "../state/runtime-state-store.js";
import type { RuntimeStateSnapshot } from "../state/state-reducer.js";
import { WriterAgent, type WriteChapterOutput } from "../agents/writer.js";

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("story truth writes", () => {
  it("serializes concurrent chapter_summaries upserts and preserves every chapter row", async () => {
    const root = await tempRoot("autow-truth-write-");
    const storyDir = join(root, "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "chapter_summaries.md"), [
      "# 章节摘要",
      "",
      "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
      "|------|------|----------|----------|----------|----------|----------|----------|",
      "| 1 | 第一章 | 沈砚 | 灯火初现 | 留在便利店 | H01 planted | 压抑 | opening |",
      "| 3 | 第三章 | 沈砚 | 找到账本 | 怀疑加深 | H01 pressured | 紧张 | clue |",
      "| 4 | 第四章 | 沈砚 | 追问来客 | 关系摇摆 | H02 planted | 紧张 | confrontation |",
      "| 5 | 第五章 | 沈砚 | 暂避风雨 | 得到线索 | H02 pressured | 阴郁 | transition |",
      "",
    ].join("\n"), "utf-8");

    await Promise.all([
      upsertChapterSummaryFile({
        storyDir,
        chapterNumber: 2,
        summaryMarkdown: "| 2 | 第二章 | 沈砚 | 单独写入的边界章 | 发现旧钥匙 | H01 mentioned | 悬疑 | clue |",
        language: "zh",
      }),
      upsertChapterSummaryFile({
        storyDir,
        chapterNumber: 6,
        summaryMarkdown: "| 6 | 第六章 | 沈砚 | batch 最后一章落地 | 线索指向巷尾 | H03 planted | 紧张 | hook |",
        language: "zh",
      }),
      upsertChapterSummaryFile({
        storyDir,
        chapterNumber: 3,
        summaryMarkdown: "| 3 | 第三章·修订 | 沈砚 | 账本线被修订 | 怀疑升级 | H01 near_payoff | 紧绷 | clue |",
        language: "zh",
      }),
      upsertChapterSummaryFile({
        storyDir,
        chapterNumber: 6,
        summaryMarkdown: "| 6 | 第六章·修订 | 沈砚 | batch 末章幂等修订 | 线索指向巷尾灯火 | H03 planted | 紧张 | hook |",
        language: "zh",
      }),
    ]);

    const content = await readFile(join(storyDir, "chapter_summaries.md"), "utf-8");
    expect(extractChapterSummaryNumbers(content)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(content.match(/\|\s*6\s*\|/g)).toHaveLength(1);
    expect(content).toContain("第六章·修订");
    expect(content).toContain("第三章·修订");
  });

  it("merges structured summary snapshots instead of overwriting older chapter rows", async () => {
    const root = await tempRoot("autow-state-snapshot-");
    const bookDir = join(root, "book");
    const stateDir = join(bookDir, "story", "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "manifest.json"), JSON.stringify({
      schemaVersion: 2,
      language: "zh",
      lastAppliedChapter: 5,
      projectionVersion: 1,
      migrationWarnings: ["legacy import"],
    }), "utf-8");
    await writeFile(join(stateDir, "chapter_summaries.json"), JSON.stringify({
      rows: [
        { chapter: 1, title: "一", characters: "", events: "e1", stateChanges: "", hookActivity: "", mood: "", chapterType: "" },
        { chapter: 3, title: "三", characters: "", events: "e3", stateChanges: "", hookActivity: "", mood: "", chapterType: "" },
        { chapter: 5, title: "五", characters: "", events: "e5", stateChanges: "", hookActivity: "", mood: "", chapterType: "" },
      ],
    }), "utf-8");

    const snapshot: RuntimeStateSnapshot = {
      manifest: {
        schemaVersion: 2,
        language: "zh",
        lastAppliedChapter: 6,
        projectionVersion: 1,
        migrationWarnings: [],
      },
      currentState: { chapter: 6, facts: [] },
      hooks: { hooks: [] },
      chapterSummaries: {
        rows: [
          { chapter: 6, title: "六", characters: "", events: "e6", stateChanges: "", hookActivity: "", mood: "", chapterType: "" },
        ],
      },
    };

    await saveRuntimeStateSnapshot(bookDir, snapshot);

    const summaries = JSON.parse(await readFile(join(stateDir, "chapter_summaries.json"), "utf-8"));
    expect(summaries.rows.map((row: { chapter: number }) => row.chapter)).toEqual([1, 3, 5, 6]);
    const manifest = JSON.parse(await readFile(join(stateDir, "manifest.json"), "utf-8"));
    expect(manifest.lastAppliedChapter).toBe(6);
    expect(manifest.migrationWarnings).toContain("legacy import");
  });
});

describe("opening ledger", () => {
  it("extracts opening type and signature imagery from a chapter opening", async () => {
    const signature = extractOpeningSignature({
      chapterNumber: 5,
      language: "zh",
      content: [
        "# 第5章 雨停以前",
        "",
        "沈砚攥着抹布擦柜台，便利店门口的积水把路灯揉成一团发黄的影子。雨水顺着玻璃门往下爬，像谁没说完的话。",
        "他抬头看了一眼收银台旁的旧账本。",
      ].join("\n"),
    });

    expect(signature.openingType).toBe("动作切入");
    expect(signature.imagery).toEqual(expect.arrayContaining(["抹布", "柜台", "便利店", "积水", "路灯"]));

    const root = await tempRoot("autow-opening-ledger-");
    const storyDir = join(root, "story");
    await upsertOpeningLedgerFile({ storyDir, signature, language: "zh" });
    const brief = await buildOpeningLedgerBrief({
      storyDir,
      currentChapter: 6,
      keepRecent: 10,
      language: "zh",
    });

    expect(brief).toContain("已用开篇/意象账本");
    expect(brief).toContain("动作切入");
    expect(brief).toContain("抹布");
    expect(brief).toContain("积水");
    expect(brief).toContain("本章要求");
  });

  it("persists an opening ledger row when the writer saves a chapter", async () => {
    const root = await tempRoot("autow-writer-opening-ledger-");
    const bookDir = join(root, "book");
    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: root,
    });
    const output: WriteChapterOutput = {
      chapterNumber: 6,
      title: "巷尾灯火",
      content: "沈砚攥着抹布擦柜台，门口积水映着路灯。便利店的玻璃门被雨水敲得发亮。",
      wordCount: 36,
      preWriteCheck: "",
      postSettlement: "",
      updatedState: "# 当前状态\n",
      updatedLedger: "",
      updatedHooks: "# 伏笔池\n",
      chapterSummary: "| 6 | 巷尾灯火 | 沈砚 | 看见巷尾灯火 | 怀疑加深 | H03 planted | 紧张 | hook |",
      updatedSubplots: "",
      updatedEmotionalArcs: "",
      updatedCharacterMatrix: "",
      postWriteErrors: [],
      postWriteWarnings: [],
    };

    await agent.saveChapter(bookDir, output, false, "zh");

    const summaries = await readFile(join(bookDir, "story", "chapter_summaries.md"), "utf-8");
    const ledger = await readFile(join(bookDir, "story", "opening_ledger.md"), "utf-8");
    const endingLedger = await readFile(join(bookDir, "story", "ending_ledger.md"), "utf-8");
    expect(summaries).toContain("| 6 | 巷尾灯火");
    expect(ledger).toContain("| 6 | 动作切入");
    expect(ledger).toContain("抹布、柜台");
    expect(endingLedger).toContain("| 6 |");
    expect(endingLedger).toContain("Register");
  });
});
