import { afterEach, describe, expect, it, vi } from "vitest";
import { flat } from "./_flatten.js";
import { PolisherAgent } from "../agents/polisher.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

function makeAgent(): PolisherAgent {
  return new PolisherAgent({
    client: {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      defaults: {
        temperature: 0.7,
        maxTokens: 4096,
        thinkingBudget: 0, maxTokensCap: null,
        extra: {},
      },
    },
    model: "test-model",
    projectRoot: "/tmp/irrelevant",
  });
}

describe("PolisherAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("encodes file-layer scope boundary and six prose 雷点 in the zh system prompt", async () => {
    const agent = makeAgent();
    const chatSpy = vi.spyOn(PolisherAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: "润色后的正文。",
      usage: ZERO_USAGE,
    });

    await agent.polishChapter({
      chapterContent: "原始正文。",
      chapterNumber: 7,
      language: "zh",
    });

    const messages = chatSpy.mock.calls[0]?.[0] as
      | ReadonlyArray<{ content: string }>
      | undefined;
    const systemPrompt = flat(messages?.[0]);

    // Hard scope boundary.
    expect(systemPrompt).toContain("润色边界");
    expect(systemPrompt).toContain("禁止增删情节");
    expect(systemPrompt).toContain("结构的事归 Reviewer");
    // File-layer 雷点 subset.
    expect(systemPrompt).toContain("描写无效");
    expect(systemPrompt).toContain("文笔华丽过度");
    expect(systemPrompt).toContain("排版不规范");
    // Hard text-layer rules.
    expect(systemPrompt).toContain("3-5 行/段");
    expect(systemPrompt).toContain("五感代入");
    expect(systemPrompt).toContain("对话自然度");
  });

  it("routes plot/structure findings to [polisher-note] lines instead of rewriting", async () => {
    const agent = makeAgent();
    const chatSpy = vi.spyOn(PolisherAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: "润色后的正文。",
      usage: ZERO_USAGE,
    });

    await agent.polishChapter({
      chapterContent: "原始正文。",
      chapterNumber: 7,
      language: "zh",
    });

    const messages = chatSpy.mock.calls[0]?.[0] as
      | ReadonlyArray<{ content: string }>
      | undefined;
    const systemPrompt = flat(messages?.[0]);

    expect(systemPrompt).toContain("[polisher-note]");
  });

  it("injects the chapter memo so polish stays anchored to the memo goal", async () => {
    const agent = makeAgent();
    const chatSpy = vi.spyOn(PolisherAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: "润色后的正文。",
      usage: ZERO_USAGE,
    });

    await agent.polishChapter({
      chapterContent: "原始正文。",
      chapterNumber: 7,
      language: "zh",
      chapterMemo: {
        chapter: 7,
        goal: "陆焚拿回残刃",
        isGoldenOpening: false,
        servesKr: null,
        body: "## 当前任务\n陆焚拿回残刃。",
        threadRefs: [],
        register: "warm",
        tempo: "slow",
      },
    });

    const messages = chatSpy.mock.calls[0]?.[0] as
      | ReadonlyArray<{ content: string }>
      | undefined;
    const userPrompt = flat(messages?.[1]);

    expect(userPrompt).toContain("## 章节备忘（润色不得偏离此目标）");
    expect(userPrompt).toContain("goal：陆焚拿回残刃");
    expect(userPrompt).toContain("register：warm");
    expect(userPrompt).toContain("tempo：slow");
    expect(userPrompt).toContain("本章火候保护");
    expect(userPrompt).toContain("不得把本章修回全书统一的克制腔");
    expect(userPrompt).toContain("温暖章");
  });

  it("keeps de-AI cleanup from erasing non-default chapter heat", async () => {
    const agent = makeAgent();
    const chatSpy = vi.spyOn(PolisherAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: "润色后的正文。",
      usage: ZERO_USAGE,
    });

    await agent.polishChapter({
      chapterContent: "原始正文。",
      chapterNumber: 9,
      language: "zh",
      deAiFocus: true,
      chapterMemo: {
        chapter: 9,
        goal: "把公开冲突打出来",
        isGoldenOpening: false,
        servesKr: null,
        body: "## 当前任务\n让冲突落到台面上。",
        threadRefs: [],
        register: "tense",
        tempo: "fast",
      },
    });

    const messages = chatSpy.mock.calls[0]?.[0] as
      | ReadonlyArray<{ content: string }>
      | undefined;
    const userPrompt = flat(messages?.[1]);

    expect(userPrompt).toContain("本轮以去 AI 味为第一优先");
    expect(userPrompt).toContain("不要把本章 register/tempo 火候本身当成 AI 味清掉");
    expect(userPrompt).toContain("去 AI 味清套话、公式化转折和机器解释腔，不清本章火候");
    expect(userPrompt).toContain("register=tense");
    expect(userPrompt).toContain("tempo=fast");
  });

  it("returns polished content and flags 'changed' when output differs", async () => {
    const agent = makeAgent();
    vi.spyOn(PolisherAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: "润色后的正文。",
      usage: ZERO_USAGE,
    });

    const out = await agent.polishChapter({
      chapterContent: "原始正文。",
      chapterNumber: 1,
      language: "zh",
    });

    expect(out.polishedContent).toBe("润色后的正文。");
    expect(out.changed).toBe(true);
  });

  it("preserves the original chapter when the model returns empty content", async () => {
    const agent = makeAgent();
    vi.spyOn(PolisherAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: "",
      usage: ZERO_USAGE,
    });

    const out = await agent.polishChapter({
      chapterContent: "原始正文。",
      chapterNumber: 1,
      language: "zh",
    });

    expect(out.polishedContent).toBe("原始正文。");
    expect(out.changed).toBe(false);
  });

  it("strips a surrounding fenced-code-block wrapper if the model adds one", async () => {
    const agent = makeAgent();
    vi.spyOn(PolisherAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: "```markdown\n润色后的正文。\n```",
      usage: ZERO_USAGE,
    });

    const out = await agent.polishChapter({
      chapterContent: "原始正文。",
      chapterNumber: 1,
      language: "zh",
    });

    expect(out.polishedContent).toBe("润色后的正文。");
    expect(out.changed).toBe(true);
  });

  it("does not accept model reasoning as a rewrite fallback in patch mode", async () => {
    const agent = makeAgent();
    const original = [
      "雨声压在窗纸上，灯芯轻轻爆了一下。",
      "沈砚把手里的旧册合上，没有立刻说话。",
      "院门外有人停住脚步，像是在等一个不会被允许的答案。",
    ].join("\n");

    vi.spyOn(PolisherAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "我们被要求输出 JSON,revised 字段是完整修复后的章节正文。",
        "目标是达到 90 分,当前章节 1497 字,目标 3000 字。",
        "weighted targets: reader (81) and rhythm (87)。",
        "之前 low metrics: length 60, hook 63, reader (81)。",
        "必须扩写但不能灌水。",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    const out = await agent.polishChapter({
      chapterContent: original,
      chapterNumber: 7,
      language: "zh",
      mode: "patch",
    });

    expect(out.polishedContent).toBe(original);
    expect(out.changed).toBe(false);
    expect(out.mode).toBe("patch");
  });

  it("builds the English system prompt when language is en", async () => {
    const agent = makeAgent();
    const chatSpy = vi.spyOn(PolisherAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: "Polished chapter body.",
      usage: ZERO_USAGE,
    });

    await agent.polishChapter({
      chapterContent: "Original chapter body.",
      chapterNumber: 3,
      language: "en",
    });

    const messages = chatSpy.mock.calls[0]?.[0] as
      | ReadonlyArray<{ content: string }>
      | undefined;
    const systemPrompt = flat(messages?.[0]);

    expect(systemPrompt).toContain("Polisher scope");
    expect(systemPrompt).toContain("FORBIDDEN from adding or removing plot beats");
    expect(systemPrompt).toContain("Ineffective description");
    expect(systemPrompt).toContain("dialogue naturalness");
  });
});
