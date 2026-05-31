import { BaseAgent } from "./base.js";
import type { Platform, Genre } from "../models/book.js";
import type { RadarSource, PlatformRankings } from "./radar-source.js";
import {
  FanqieRadarSource,
  JinjiangRadarSource,
  QidianRadarSource,
  QimaoRadarSource,
  RoyalRoadRadarSource,
  SearchTrendRadarSource,
  SeventeenKSource,
  WebNovelRadarSource,
  ZonghengRadarSource,
} from "./radar-source.js";
import { getConfiguredSearchApiKey } from "../utils/web-search.js";
import type { LLMClient } from "../llm/provider.js";

export interface RadarResult {
  readonly recommendations: ReadonlyArray<RadarRecommendation>;
  readonly marketSummary: string;
  readonly sourceHealth: ReadonlyArray<RadarSourceHealth>;
  readonly modelGuidance: RadarModelGuidance;
  readonly warnings: ReadonlyArray<string>;
  readonly timestamp: string;
}

export interface RadarRecommendation {
  readonly platform: Platform;
  readonly genre: Genre;
  readonly concept: string;
  readonly confidence: number;
  readonly reasoning: string;
  readonly benchmarkTitles: ReadonlyArray<string>;
  readonly readerPromise?: string;
  readonly openingHook?: string;
  readonly firstVolumeLoop?: string;
  readonly differentiation?: string;
  readonly risks?: ReadonlyArray<string>;
}

export interface RadarSourceHealth {
  readonly name: string;
  readonly platform: string;
  readonly sourceType: PlatformRankings["sourceType"];
  readonly sourceUrl?: string;
  readonly ok: boolean;
  readonly count: number;
  readonly warning?: string;
}

export interface RadarModelGuidance {
  readonly currentService?: string;
  readonly currentProvider?: string;
  readonly currentModel?: string;
  readonly searchMode: "built-in-rank-sources" | "rank-sources-plus-search";
  readonly notes: ReadonlyArray<string>;
  readonly recommendedSetup: ReadonlyArray<string>;
}

const DEFAULT_SOURCES: ReadonlyArray<RadarSource> = [
  new FanqieRadarSource(),
  new QidianRadarSource(),
  new QimaoRadarSource(),
  new ZonghengRadarSource(),
  new SeventeenKSource(),
  new JinjiangRadarSource(),
  new WebNovelRadarSource(),
  new RoyalRoadRadarSource(),
  new SearchTrendRadarSource(),
];

export function summarizeSourceHealth(rankings: ReadonlyArray<PlatformRankings>): ReadonlyArray<RadarSourceHealth> {
  return rankings.map((ranking) => ({
    name: ranking.platform,
    platform: ranking.platform,
    sourceType: ranking.sourceType,
    sourceUrl: ranking.sourceUrl,
    ok: ranking.entries.length > 0 && !ranking.warning,
    count: ranking.entries.length,
    warning: ranking.warning,
  }));
}

export function buildRadarModelGuidance(
  client: Pick<LLMClient, "provider" | "service">,
  model: string,
  rankings: ReadonlyArray<PlatformRankings>,
): RadarModelGuidance {
  const searchHasEntries = rankings.some((ranking) => ranking.sourceType === "web-search" && ranking.entries.length > 0);
  const searchConfigured = Boolean(getConfiguredSearchApiKey());
  const service = client.service ?? client.provider;
  const modelText = `${service ?? ""} ${model}`.toLowerCase();
  const notes: string[] = [];
  const recommendedSetup: string[] = [
    "雷达/选题参谋：优先使用擅长综合判断的强推理或长上下文聊天模型。",
    "实时性：配置 JUANSHE_SEARCH_PROVIDER=tavily 与 JUANSHE_SEARCH_API_KEY，搜索增强信源才会提供最新网页结果。",
  ];

  if (modelText.includes("deepseek")) {
    notes.push("DeepSeek 可以分析卷舍提供的榜单与搜索上下文，但本雷达不会依赖 DeepSeek 自动联网；实时检索需要外部搜索 Key。");
  }
  if (!searchConfigured) {
    notes.push("当前未配置搜索 Key，雷达只使用内置榜单/排行页信源；这些页面可能因站点改版或反爬返回空。");
  } else if (searchHasEntries) {
    notes.push("搜索增强信源已拿到网页结果，可与榜单信号合并判断。");
  } else {
    notes.push("已配置搜索 Key，但本次搜索增强没有返回可用结果；请检查 provider、Key 或网络。");
  }
  notes.push("不要把没有信源支持的方向写成实时结论；信源为空时只能作为低置信度假设。");

  return {
    currentService: service,
    currentProvider: client.provider,
    currentModel: model,
    searchMode: searchHasEntries ? "rank-sources-plus-search" : "built-in-rank-sources",
    notes,
    recommendedSetup,
  };
}

export function formatRankingsForPrompt(rankings: ReadonlyArray<PlatformRankings>): string {
  const sections = rankings
    .filter((ranking) => ranking.entries.length > 0)
    .map((ranking) => {
      const lines = ranking.entries.map(
        (entry) => `- ${entry.title}${entry.author ? ` (${entry.author})` : ""}${entry.category ? ` [${entry.category}]` : ""} ${entry.extra}${entry.url ? `\n  URL: ${entry.url}` : ""}`,
      );
      return `### ${ranking.platform}${ranking.sourceType ? ` (${ranking.sourceType})` : ""}\n${lines.join("\n")}`;
    });

  return sections.length > 0
    ? sections.join("\n\n")
    : "（本次没有拿到可引用的榜单/搜索条目。请不要伪装成实时结论，只能输出低置信度假设，并提示配置搜索或检查信源。）";
}

export function formatSourceHealthForPrompt(health: ReadonlyArray<RadarSourceHealth>): string {
  return health
    .map((source) => `- ${source.platform}: ${source.count} 条 / ${source.sourceType ?? "unknown"} / ${source.ok ? "ok" : "needs-check"}${source.warning ? ` / ${source.warning}` : ""}${source.sourceUrl ? ` / ${source.sourceUrl}` : ""}`)
    .join("\n");
}

export class RadarAgent extends BaseAgent {
  private readonly sources: ReadonlyArray<RadarSource>;

  constructor(
    ctx: ConstructorParameters<typeof BaseAgent>[0],
    sources?: ReadonlyArray<RadarSource>,
  ) {
    super(ctx);
    this.sources = sources ?? DEFAULT_SOURCES;
  }

  get name(): string {
    return "radar";
  }

  async scan(): Promise<RadarResult> {
    const rankings = await Promise.all(this.sources.map(async (source) => {
      try {
        return await source.fetch();
      } catch (error) {
        return {
          platform: source.name,
          sourceType: "manual" as const,
          fetchedAt: new Date().toISOString(),
          entries: [],
          warning: error instanceof Error ? error.message : String(error),
        };
      }
    }));
    const sourceHealth = summarizeSourceHealth(rankings);
    const modelGuidance = buildRadarModelGuidance(this.ctx.client, this.ctx.model, rankings);
    const rankingsText = formatRankingsForPrompt(rankings);
    const sourceHealthText = formatSourceHealthForPrompt(sourceHealth);

    const systemPrompt = `你是卷舍的「题材信号编辑」和「开书定位参谋」。你的任务不是泛泛预测网文市场,而是把可见信源转译成可执行的开书判断。

工作原则:
- 只引用下面提供的榜单、搜索或人工信源;没有信源支持的判断必须写成低置信度假设。
- 不要编造实时排行、平台规则、作者名、数据规模或读者画像。
- 每条建议必须用「平台信号 / 读者承诺 / 开篇钩子 / 首卷循环 / 差异化」五格判断。
- benchmarkTitles 必须来自下面的可见标题或搜索结果,不能凭空补。
- 如果某个平台信源为空或有 warning,要把不确定性写进 marketSummary 或 risks。

## 信源健康

${sourceHealthText}

## 模型与检索边界

${modelGuidance.notes.map((note) => `- ${note}`).join("\n")}

## 可引用信源

${rankingsText}

输出格式必须为 JSON：
{
  "recommendations": [
    {
      "platform": "平台名",
      "genre": "题材类型",
      "concept": "一句话概念描述",
      "confidence": 0.0-1.0,
      "reasoning": "推荐理由（引用具体信源标题或搜索条目）",
      "benchmarkTitles": ["对标书1", "对标书2"],
      "readerPromise": "读者打开这本书期待得到的稳定爽点/情绪价值",
      "openingHook": "前三章最强钩子",
      "firstVolumeLoop": "首卷能反复驱动追更的升级/关系/悬念循环",
      "differentiation": "与榜单常见写法区分开的具体做法",
      "risks": ["风险1", "风险2"]
    }
  ],
  "marketSummary": "整体市场概述（说明哪些结论有信源支持,哪些只是低置信度假设）"
}

推荐数量：3-5个，按 confidence 降序排列。`;

    const response = await this.chat(
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: "请基于上面的可见信源，分析当前网文市场热度，给出可执行的开书建议。",
        },
      ],
      { temperature: 0.6 },
    );

    return this.parseResult(response.content, sourceHealth, modelGuidance);
  }

  private parseResult(
    content: string,
    sourceHealth: ReadonlyArray<RadarSourceHealth>,
    modelGuidance: RadarModelGuidance,
  ): RadarResult {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Radar output format error: no JSON found");
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        recommendations: parsed.recommendations ?? [],
        marketSummary: parsed.marketSummary ?? "",
        sourceHealth,
        modelGuidance,
        warnings: sourceHealth.flatMap((source) => source.warning ? [`${source.platform}: ${source.warning}`] : []),
        timestamp: new Date().toISOString(),
      };
    } catch (e) {
      throw new Error(`Radar JSON parse error: ${e}`);
    }
  }
}
