import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlannerAgent } from "../agents/planner.js";
import * as llmProvider from "../llm/provider.js";
import type { LLMClient } from "../llm/provider.js";
import type { BookConfig } from "../models/book.js";

const VALID_BODY = `
## 当前任务
主角进入七号门现场，比对锁芯刮痕与监控时间线，把"被动过手脚"从猜测钉成实证。

## 读者此刻在等什么
1) 读者在等七号门是否有异常实锤
2) 本章完全兑现，钉成现场实证

## 该兑现的 / 暂不掀的
- 该兑现：七号门异常 → 钉成现场实证
- 暂不掀：幕后主使 → 压到第 20 章

## 日常/过渡承担什么任务
不适用 - 本章为高压实证章，无日常过渡段。

## 关键抉择过三连问
- 主角本章最关键的一次选择：
  - 为什么这么做？线索只剩这一条
  - 符合当前利益吗？符合
  - 符合他的人设吗？符合
- 对手/配角本章最关键的一次选择：
  - 为什么这么做？掩盖踪迹
  - 符合当前利益吗？符合
  - 符合他的人设吗？符合

## 章尾必须发生的改变
- 信息改变：主角掌握实证，可以面对幕后主使前先压住对手的退路

## 本章 hook 账
advance:
- H03 "七号门异常" → 从 pressured → near_payoff（本章钉成实证）
resolve:
- S004 "锁芯刮痕" → 核验完毕，本章结清
defer:
- H07 "幕后主使" → 第 20 章再动

## 不要做
- 不要让对手突然降智
- 不要直接点破幕后主使
`.trim();

function validMemoRaw(chapter: number): string {
  return `---\nchapter: ${chapter}\ngoal: 把七号门被动过手脚钉成现场实证\nisGoldenOpening: false\nthreadRefs:\n  - H03\n  - S004\n---\n${VALID_BODY}\n`;
}

function validMemoRawWithKr(chapter: number, krId: string, krLine: string): string {
  const body = VALID_BODY.replace(
    "主角进入七号门现场，比对锁芯刮痕与监控时间线，把\"被动过手脚\"从猜测钉成实证。",
    krLine,
  ).replace(
    "advance:\n- H03",
    `open:\n- [new] ${krId} 的后续可见痕迹 || 理由：围绕本卷 KR 继续加压\nadvance:\n- H03`,
  );
  return `---\nchapter: ${chapter}\ngoal: ${krLine.slice(0, 48)}\nisGoldenOpening: false\nservesKr: ${krId}\nthreadRefs:\n  - H03\n  - S004\n---\n${body}\n`;
}

function volumeOkrJson(): string {
  return JSON.stringify([
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
        {
          id: "KR3",
          desc: "主角公开第5封悼词牵出的旧证据",
          must_advance_by_chapter: 10,
          target_chapters: [8, 9, 10],
        },
      ],
    },
  ]);
}

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

const STUB_CLIENT: LLMClient = {
  provider: "openai",
  apiFormat: "chat",
  stream: false,
  defaults: { temperature: 0.7, maxTokens: 2048, thinkingBudget: 0, maxTokensCap: null, extra: {} },
};

function makeBook(): BookConfig {
  return {
    id: "book-plan-1",
    title: "Test Book",
    genre: "urban",
    platform: "qidian",
    status: "active",
    language: "zh",
    targetChapters: 120,
    chapterWordCount: 3000,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

async function seedStoryFiles(bookDir: string): Promise<void> {
  const storyDir = join(bookDir, "story");
  await mkdir(storyDir, { recursive: true });
  await Promise.all([
    writeFile(join(storyDir, "author_intent.md"), "# Intent\n- Tell a taut mystery.", "utf-8"),
    writeFile(join(storyDir, "current_focus.md"), "# Focus\n- Keep pressure on the seventh gate.", "utf-8"),
    writeFile(join(storyDir, "story_bible.md"), "# Bible\n- Protagonist: 阿泽", "utf-8"),
    writeFile(join(storyDir, "volume_outline.md"), "# Outline\n- 第 1 章：开场", "utf-8"),
    writeFile(join(storyDir, "chapter_summaries.md"), "# Summaries\n", "utf-8"),
    writeFile(join(storyDir, "book_rules.md"), "# Rules\n- 禁止反派降智", "utf-8"),
    writeFile(join(storyDir, "current_state.md"), "# State\n- 主角在七号门附近", "utf-8"),
    writeFile(join(storyDir, "pending_hooks.md"), "# Hooks\n", "utf-8"),
    writeFile(join(storyDir, "subplot_board.md"), "# Subplot\n", "utf-8"),
    writeFile(join(storyDir, "emotional_arcs.md"), "# Arcs\n", "utf-8"),
    writeFile(join(storyDir, "character_matrix.md"), "# Matrix\n", "utf-8"),
  ]);
}

describe("PlannerAgent.planChapter memo generation", () => {
  let root: string;
  let bookDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "planner-memo-"));
    bookDir = join(root, "book");
    await seedStoryFiles(bookDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function makePlanner(): PlannerAgent {
    return new PlannerAgent({
      client: STUB_CLIENT,
      model: "test-model",
      projectRoot: root,
      bookId: "book-plan-1",
    });
  }

  it("produces a valid ChapterMemo when the LLM returns well-formed output", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(1),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 1,
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.memo.chapter).toBe(1);
    expect(result.memo.isGoldenOpening).toBe(true); // ch1 zh → golden opening, authoritative over LLM
    expect(result.memo.goal).toBe("把七号门被动过手脚钉成现场实证");
    expect(result.memo.servesKr).toBeNull();
    expect(result.memo.threadRefs).toEqual(["H03", "S004"]);
    expect(result.memo.register).toBe("tense");
    expect(result.memo.tempo).toBe("fast");
    expect(result.intent.register).toBe("tense");
    expect(result.intent.tempo).toBe("fast");
    expect(result.intentMarkdown).toContain("## Register / Tempo");
    expect(result.intentMarkdown).toContain("- register: tense");
    expect(result.memo.body).toContain("## 全书进度仪表盘");
    expect(result.memo.body).toContain("本章宏观角色");
    expect(result.memo.body).toContain("## 当前任务");

    const messages = chatSpy.mock.calls[0]?.[2] as ReadonlyArray<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("本章 register/tempo 前向目标");
    expect(userMsg?.content).toContain("register: tense");
    expect(userMsg?.content).toContain("tempo: fast");
  });

  it("does not hard-cap memo generation below the configured model output budget", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(1),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 1,
    });

    const callArgs = chatSpy.mock.calls[0]!;
    const options = callArgs[3] as { temperature?: number; maxTokens?: number } | undefined;
    expect(options).toEqual(expect.objectContaining({ temperature: 0.7 }));
    expect(options).not.toHaveProperty("maxTokens");
  });

  it("passes per-chapter user context into the memo prompt as a high-priority instruction", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(1),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 1,
      externalContext: "本章标题：雨夜账本\n必须围绕账本失窃后的当面对质展开。",
    });

    const callArgs = chatSpy.mock.calls[0]!;
    const messages = callArgs[2] as ReadonlyArray<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("本章用户指令");
    expect(userMsg?.content).toContain("本章标题：雨夜账本");
    expect(userMsg?.content).toContain("当面对质");
  });

  it("injects volume_okr.json as the hard volume KR anchor when prose outline has no chapter ranges", async () => {
    const storyDir = join(bookDir, "story");
    await mkdir(join(storyDir, "outline"), { recursive: true });
    await Promise.all([
      writeFile(
        join(storyDir, "outline", "volume_map.md"),
        [
          "# 卷纲地图",
          "第一卷围绕代写信客人与亡母悼词展开，只写卷级方向，不写章号。",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "outline", "volume_okr.json"),
        volumeOkrJson(),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "current_focus.md"),
        [
          "# Focus",
          "## 本章覆盖",
          "- 临时追一条卷纲外的谍战暗线",
        ].join("\n"),
        "utf-8",
      ),
    ]);
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRawWithKr(
        3,
        "KR1",
        "第5位客人把亡母悼词委托交给主角，主角当场接下这封代写信。",
      ),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 3,
    });

    const callArgs = chatSpy.mock.calls[0]!;
    const messages = callArgs[2] as ReadonlyArray<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("卷纲硬锚：第1卷：巷尾灯火");
    expect(userMsg?.content).toContain("本章 must_advance KR：KR1");
    expect(userMsg?.content).toContain("代写信第5位客人登场并提出亡母悼词委托");
    expect(result.plannerInputs).toContain(join(storyDir, "outline", "volume_okr.json"));
  });

  it("retries when a new branch/core hook is not mapped to the current volume KR", async () => {
    const storyDir = join(bookDir, "story");
    await mkdir(join(storyDir, "outline"), { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "outline", "volume_map.md"), "第一卷只写卷级方向。", "utf-8"),
      writeFile(join(storyDir, "outline", "volume_okr.json"), volumeOkrJson(), "utf-8"),
    ]);
    const drifting = validMemoRawWithKr(
      3,
      "KR1",
      "第5位客人把亡母悼词委托交给主角，主角当场接下这封代写信。",
    ).replace(
      "- [new] KR1 的后续可见痕迹 || 理由：围绕本卷 KR 继续加压",
      "- [new] 谍战暗线 core_hook=true || 理由：另开一条跟悼词无关的新主线",
    );
    const repaired = validMemoRawWithKr(
      3,
      "KR1",
      "第5位客人把亡母悼词委托交给主角，主角当场接下这封代写信。",
    );
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion")
      .mockResolvedValueOnce({
        content: drifting,
        usage: ZERO_USAGE,
      } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>)
      .mockResolvedValueOnce({
        content: repaired,
        usage: ZERO_USAGE,
      } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 3,
    });

    expect(chatSpy).toHaveBeenCalledTimes(2);
    expect(result.memo.servesKr).toBe("KR1");
    const secondMessages = chatSpy.mock.calls[1]?.[2] as ReadonlyArray<{ role: string; content: string }>;
    expect(secondMessages.find((m) => m.role === "user")?.content).toContain("new thread/core hook");
  });

  it("falls back without crashing when volume KR validation keeps failing", async () => {
    const storyDir = join(bookDir, "story");
    await mkdir(join(storyDir, "outline"), { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "outline", "volume_map.md"), "第一卷只写卷级方向。", "utf-8"),
      writeFile(join(storyDir, "outline", "volume_okr.json"), volumeOkrJson(), "utf-8"),
    ]);
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(3),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 3,
    });

    expect(chatSpy).toHaveBeenCalledTimes(3);
    expect(result.memo.servesKr).toBe("KR1");
    expect(result.memo.body).toContain("卷纲KR兜底");
    expect(result.memo.body).toContain("代写信第5位客人登场并提出亡母悼词委托");
  });

  it("does not reject a semantically real KR advance phrased differently", async () => {
    const storyDir = join(bookDir, "story");
    await mkdir(join(storyDir, "outline"), { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "outline", "volume_map.md"), "第一卷只写卷级方向。", "utf-8"),
      writeFile(join(storyDir, "outline", "volume_okr.json"), volumeOkrJson(), "utf-8"),
    ]);
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRawWithKr(
        3,
        "KR1",
        "第5位客人带着亡母悼词委托上门，主角没有旁观，而是接下代写信并追问死因。",
      ),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 3,
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.memo.servesKr).toBe("KR1");
  });

  it("falls back when remaining volume chapters cannot cover untouched KRs", async () => {
    const storyDir = join(bookDir, "story");
    await mkdir(join(storyDir, "outline"), { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "outline", "volume_map.md"), "第一卷只写卷级方向。", "utf-8"),
      writeFile(join(storyDir, "outline", "volume_okr.json"), volumeOkrJson(), "utf-8"),
      writeFile(
        join(storyDir, "chapter_summaries.md"),
        [
          "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| 1 | 悼词 | 陆青 | 第5位客人带着亡母悼词委托上门 | 主角接下代写信 | H1 | 温沉 | build-up |",
        ].join("\n"),
        "utf-8",
      ),
    ]);
    const tooLateKr3 = validMemoRawWithKr(
      10,
      "KR3",
      "主角公开第5封悼词牵出的旧证据，让旧证据第一次进入街坊视野。",
    );
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: tooLateKr3,
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 10,
    });

    expect(chatSpy).toHaveBeenCalledTimes(3);
    expect(result.memo.servesKr).toBe("KR3");
    expect(result.memo.body).toContain("卷纲KR兜底");
  });

  it("lets explicit per-chapter user instruction bypass the volume KR gate", async () => {
    const storyDir = join(bookDir, "story");
    await mkdir(join(storyDir, "outline"), { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "outline", "volume_map.md"), "第一卷只写卷级方向。", "utf-8"),
      writeFile(join(storyDir, "outline", "volume_okr.json"), volumeOkrJson(), "utf-8"),
    ]);
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(3),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 3,
      externalContext: "本章必须按用户指定写成雨夜对质，不推进悼词委托。",
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.memo.servesKr).toBeNull();
    const messages = chatSpy.mock.calls[0]?.[2] as ReadonlyArray<{ role: string; content: string }>;
    expect(messages.find((m) => m.role === "user")?.content).toContain("本章用户指令");
  });

  it("keeps volume KR ahead of local override but traces explicit user override", () => {
    const planner = makePlanner() as unknown as {
      deriveGoal: (input: {
        externalContext?: string;
        currentFocus: string;
        authorIntent: string;
        outlineNode?: string;
        chapterNumber: number;
        volumeOkrAnchor?: unknown;
        language: "zh" | "en";
      }) => string;
    };
    const volumeOkrAnchor = {
      volume: {
        volume_index: 1,
        title: "第1卷：巷尾灯火",
        start_ch: 1,
        end_ch: 10,
        objective: "接住亡母悼词线索",
        krs: [],
      },
      kr: {
        id: "KR1",
        desc: "代写信第5位客人提出亡母悼词委托",
        must_advance_by_chapter: 4,
        target_chapters: [1, 3, 4],
      },
    };

    const localGoal = planner.deriveGoal({
      currentFocus: "## 本章覆盖\n- 临时追一条卷纲外的谍战暗线",
      authorIntent: "",
      outlineNode: "",
      chapterNumber: 3,
      volumeOkrAnchor,
      language: "zh",
    });
    expect(localGoal).toContain("必须推进第1卷：巷尾灯火KR1");
    expect(localGoal).toContain("局部覆盖只改执行细节");
    expect(localGoal).toContain("谍战暗线");

    const externalGoal = planner.deriveGoal({
      externalContext: "本章改写成用户指定的雨夜对质。",
      currentFocus: "",
      authorIntent: "",
      outlineNode: "",
      chapterNumber: 3,
      volumeOkrAnchor,
      language: "zh",
    });
    expect(externalGoal).toContain("用户显式指令覆盖卷纲KR");
    expect(externalGoal).toContain("本章改写成用户指定的雨夜对质");
    expect(externalGoal).toContain("留痕锚点");
  });

  it("injects dormant subplot revival hints and previous audit feedback into the memo prompt", async () => {
    const storyDir = join(bookDir, "story");
    await mkdir(join(storyDir, "runtime"), { recursive: true });
    await Promise.all([
      writeFile(
        join(storyDir, "subplot_board.md"),
        [
          "| id | 支线 | 负责人 | 起始 | 最近推进 | 沉寂 | 状态 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| S001 | 主线追查 | 阿泽 | ch1 | ch30 | 0 | 推进 | 当前压力 |",
          "| S007 | 货款旧账 | 阿泽 | ch3 | ch4 | 30 | 暂挂 | 可接回七号门账本 |",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "runtime", "last_audit_feedback.json"),
        JSON.stringify({
          schema_version: 1,
          source_chapter: 34,
          issues: [{
            severity: "critical",
            category: "节奏单调",
            description: "连续六章没有硬变化。",
            suggestion: "下一章让证据易手。",
          }],
        }),
        "utf-8",
      ),
    ]);
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(35),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 35,
    });

    const callArgs = chatSpy.mock.calls[0]!;
    const messages = callArgs[2] as ReadonlyArray<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("dormant 支线复活提示");
    expect(userMsg?.content).toContain("S007");
    expect(userMsg?.content).toContain("上轮审计反馈");
    expect(userMsg?.content).toContain("[critical] 节奏单调");
    expect(userMsg?.content).toContain("证据易手");
    await expect(readFile(join(storyDir, "runtime", "last_audit_feedback.json"), "utf-8"))
      .rejects.toThrow();
  });

  it("retries when a due recyclable hook is missing from the memo hook ledger", async () => {
    const storyDir = join(bookDir, "story");
    await writeFile(
      join(storyDir, "pending_hooks.md"),
      [
        "| hook_id | start_chapter | type | status | last_advanced | expected_payoff | payoff_timing | depends_on | pays_off_in_arc | core_hook | half_life | promoted | notes |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        "| H99 | 1 | core | pressured | 1 | 旧誓约必须在本卷回收 | near-term | none | 第一卷 | true | 5 | true | stale core promise |",
      ].join("\n"),
      "utf-8",
    );
    const repaired = validMemoRaw(20).replace(
      /advance:\n- H03/,
      "advance:\n- H99 \"旧誓约\" → 本章让誓约代价显形\n- H03",
    );
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion")
      .mockResolvedValueOnce({
        content: validMemoRaw(20),
        usage: ZERO_USAGE,
      } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>)
      .mockResolvedValueOnce({
        content: repaired,
        usage: ZERO_USAGE,
      } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 20,
    });

    expect(chatSpy).toHaveBeenCalledTimes(2);
    expect(result.memo.body).toContain("H99");
  });

  it("retries when the first response is malformed and succeeds on retry", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion")
      .mockResolvedValueOnce({
        content: "no frontmatter here",
        usage: ZERO_USAGE,
      } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>)
      .mockResolvedValueOnce({
        content: "still no frontmatter",
        usage: ZERO_USAGE,
      } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>)
      .mockResolvedValueOnce({
        content: validMemoRaw(4),
        usage: ZERO_USAGE,
      } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 4,
    });

    expect(chatSpy).toHaveBeenCalledTimes(3);
    expect(result.memo.chapter).toBe(4);
    expect(result.memo.isGoldenOpening).toBe(false);

    // Retry prompts must include the failure feedback
    const secondCallArgs = chatSpy.mock.calls[1]!;
    const secondMessages = secondCallArgs[2] as ReadonlyArray<{ role: string; content: string }>;
    const userMsg = secondMessages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("上次输出的错误");
  });

  // Phase hotfix 4: English books must receive English system + user prompts
  // and English golden-opening guidance for chapters ≤ 3.
  it("uses English prompts end-to-end when book.language is en", async () => {
    const VALID_EN_BODY = `
## Current task
Pin the Door 7 tampering from suspicion to live evidence.

## What the reader is waiting for right now
1) Reader expects to learn whether Door 7 is really compromised.
2) This chapter pays it off in full — live evidence on stage.

## To pay off / to keep buried
- Pay off: Door 7 anomaly → live evidence
- Keep buried: the mastermind → push to chapter 20

## What the slow / transitional beats carry
n/a — pressure chapter, no transitional beats.

## Three-question check on the key choice
- Protagonist's most important choice this chapter:
  - Why this choice? It is the only remaining lead.
  - Does it match current interest? Yes.
  - Does it match their persona? Yes.
- Antagonist / supporting cast's most important choice this chapter:
  - Why this choice? To cover their tracks.
  - Does it match current interest? Yes.
  - Does it match their persona? Yes.

## Required end-of-chapter change
- Information change: protagonist holds live evidence.

## Hook ledger for this chapter
advance:
- H03 "Door 7 anomaly" → pressured → near_payoff (pinned as live evidence this chapter)
defer:
- H07 "the mastermind" → hold until chapter 20

## Do not
- Do not let the antagonist suddenly turn dumb.
- Do not directly name the mastermind.
`.trim();

    const validEnRaw = `---\nchapter: 1\ngoal: Pin Door 7 tampering as live evidence\nisGoldenOpening: false\nthreadRefs:\n  - H03\n---\n${VALID_EN_BODY}\n`;

    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validEnRaw,
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const enBook = { ...makeBook(), language: "en" as const };
    const result = await makePlanner().planChapter({
      book: enBook,
      bookDir,
      chapterNumber: 1,
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.memo.chapter).toBe(1);
    expect(result.memo.isGoldenOpening).toBe(true); // ch1 en → also golden (≤5)

    // System prompt must be the English variant
    const callArgs = chatSpy.mock.calls[0]!;
    const messages = callArgs[2] as ReadonlyArray<{ role: string; content: string }>;
    const systemMsg = messages.find((m) => m.role === "system");
    const userMsg = messages.find((m) => m.role === "user");

    // English system prompt markers
    expect(systemMsg?.content).toContain("editor-in-chief");
    expect(systemMsg?.content).toContain("Output format (strict)");
    expect(systemMsg?.content).not.toContain("你是这本小说的创作总编");

    // English user template markers
    expect(userMsg?.content).toContain("# Chapter 1 memo request");
    expect(userMsg?.content).toContain("Last screen of previous chapter");
    expect(userMsg?.content).toContain("Golden opening chapter: yes");
    expect(userMsg?.content).not.toContain("# 第 1 章 memo 请求");

    // English golden-opening guidance appended for ch ≤ 3
    expect(userMsg?.content).toContain("Golden Opening Guidance");
    expect(userMsg?.content).toContain("Chapter 1");
    expect(userMsg?.content).not.toContain("黄金三章规划指引");
  });

  it("falls back to a deterministic memo when all 3 attempts fail", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: "permanently broken",
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 2,
    });

    expect(chatSpy).toHaveBeenCalledTimes(3);
    expect(result.memo.chapter).toBe(2);
    expect(result.memo.threadRefs).toEqual(["fallback-mainline"]);
    expect(result.memo.body).toContain("## 本章 hook 账");
    expect(result.memo.body).toContain("## 不要做");
  });

  // Phase hotfix 5: planner.intent.mustAvoid must come from the Phase 5
  // authoritative loader (story_frame frontmatter), not from raw
  // book_rules.md — for new-layout books the legacy file is just a shim.
  it("derives intent.mustAvoid from outline/story_frame.md frontmatter (new layout)", async () => {
    // Replace book_rules.md with a Phase 5 compat shim (no YAML, just pointer)
    // and put the authoritative YAML on outline/story_frame.md.
    const storyDir = join(bookDir, "story");
    await mkdir(join(storyDir, "outline"), { recursive: true });
    await writeFile(
      join(storyDir, "outline/story_frame.md"),
      [
        "---",
        "version: \"1.0\"",
        "protagonist:",
        "  name: 阿泽",
        "  personalityLock: []",
        "  behavioralConstraints: []",
        "prohibitions:",
        "  - 禁止主角降智",
        "  - 禁止神化反派",
        "---",
        "",
        "## 主题与基调",
        "调查与压制。",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(storyDir, "book_rules.md"),
      "# 本书规则（兼容指针——已废弃）\n\n> 本文件仅为外部读取保留。",
      "utf-8",
    );

    vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(2),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 2,
    });

    expect(result.intent.mustAvoid).toContain("禁止主角降智");
    expect(result.intent.mustAvoid).toContain("禁止神化反派");
  });
});
