import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseAgent } from "../agents/base.js";
import {
  RadarAgent,
  buildRadarModelGuidance,
  formatRankingsForPrompt,
  summarizeSourceHealth,
} from "../agents/radar.js";
import type { PlatformRankings, RadarSource } from "../agents/radar-source.js";

const ENV_KEYS = [
  "JUANSHE_SEARCH_API_KEY",
  "JUANSHE_SEARCH_PROVIDER",
  "HARDWRITE_SEARCH_API_KEY",
  "HARDWRITE_SEARCH_PROVIDER",
  "TAVILY_API_KEY",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function clearSearchEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("radar prompt support", () => {
  it("explains that DeepSeek still needs external search for live retrieval", () => {
    clearSearchEnv();

    const guidance = buildRadarModelGuidance(
      { provider: "openai", service: "deepseek" },
      "deepseek-chat",
      [],
    );

    expect(guidance.searchMode).toBe("built-in-rank-sources");
    expect(guidance.notes.join("\n")).toContain("DeepSeek");
    expect(guidance.notes.join("\n")).toContain("外部搜索 Key");
    expect(guidance.recommendedSetup.join("\n")).toContain("JUANSHE_SEARCH_API_KEY");
  });

  it("summarizes source health and includes URLs in prompt context", () => {
    const rankings: PlatformRankings[] = [
      {
        platform: "起点中文网",
        sourceType: "rank-page",
        sourceUrl: "https://www.qidian.com/rank/",
        fetchedAt: "2026-05-31T00:00:00.000Z",
        entries: [
          {
            title: "长夜余火",
            author: "爱潜水的乌贼",
            category: "科幻",
            extra: "[起点热榜]",
            url: "https://book.qidian.com/info/1",
          },
        ],
      },
      {
        platform: "搜索增强信源",
        sourceType: "web-search",
        sourceUrl: "JUANSHE_SEARCH_API_KEY/TAVILY_API_KEY",
        fetchedAt: "2026-05-31T00:00:00.000Z",
        entries: [],
        warning: "Search is not configured",
      },
    ];

    const health = summarizeSourceHealth(rankings);
    const prompt = formatRankingsForPrompt(rankings);

    expect(health).toEqual([
      expect.objectContaining({ platform: "起点中文网", ok: true, count: 1 }),
      expect.objectContaining({ platform: "搜索增强信源", ok: false, count: 0, warning: "Search is not configured" }),
    ]);
    expect(prompt).toContain("长夜余火");
    expect(prompt).toContain("https://book.qidian.com/info/1");
  });

  it("returns source health and model guidance with scan results", async () => {
    clearSearchEnv();
    const source: RadarSource = {
      name: "fixture",
      async fetch() {
        return {
          platform: "人工研判",
          sourceType: "manual",
          fetchedAt: "2026-05-31T00:00:00.000Z",
          entries: [
            {
              title: "复仇灵植师",
              author: "",
              category: "仙侠",
              extra: "[测试]",
            },
          ],
        };
      },
    };
    vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: JSON.stringify({
        recommendations: [
          {
            platform: "other",
            genre: "仙侠",
            concept: "灵植经营和复仇线并进",
            confidence: 0.8,
            reasoning: "来自复仇灵植师",
            benchmarkTitles: ["复仇灵植师"],
            readerPromise: "稳定升级和情绪回收",
          },
        ],
        marketSummary: "信源明确。",
      }),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    const agent = new RadarAgent({
      client: {
        provider: "openai",
        service: "deepseek",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "deepseek-chat",
      projectRoot: "/tmp/juanshe-radar-test",
    } as never, [source]);

    const result = await agent.scan();

    expect(result.recommendations[0]?.concept).toBe("灵植经营和复仇线并进");
    expect(result.sourceHealth[0]).toEqual(expect.objectContaining({ platform: "人工研判", ok: true, count: 1 }));
    expect(result.modelGuidance.notes.join("\n")).toContain("DeepSeek");
    expect(result.warnings).toEqual([]);
  });
});
