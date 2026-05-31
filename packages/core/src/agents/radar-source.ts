import { searchWeb } from "../utils/web-search.js";

export interface RankingEntry {
  readonly title: string;
  readonly author: string;
  readonly category: string;
  readonly extra: string;
  readonly url?: string;
}

export interface PlatformRankings {
  readonly platform: string;
  readonly entries: ReadonlyArray<RankingEntry>;
  readonly sourceType?: "rank-page" | "app-api" | "web-search" | "manual";
  readonly sourceUrl?: string;
  readonly fetchedAt?: string;
  readonly warning?: string;
}

/**
 * Pluggable data source for the Radar agent.
 * Implement this interface to feed custom ranking/trend data
 * from curated notes, custom scrapers, paid APIs, or search providers.
 */
export interface RadarSource {
  readonly name: string;
  fetch(): Promise<PlatformRankings>;
}

/**
 * Wraps raw natural language text as a radar source.
 * Use this to inject a human research memo or an external analysis into the radar pipeline.
 */
export class TextRadarSource implements RadarSource {
  readonly name: string;
  private readonly text: string;

  constructor(text: string, name = "external") {
    this.name = name;
    this.text = text;
  }

  async fetch(): Promise<PlatformRankings> {
    return {
      platform: this.name,
      sourceType: "manual",
      fetchedAt: new Date().toISOString(),
      entries: [{ title: this.text, author: "", category: "", extra: "[外部分析]" }],
    };
  }
}

// ---------------------------------------------------------------------------
// Built-in sources
// ---------------------------------------------------------------------------

const FANQIE_RANK_TYPES = [
  { sideType: 10, label: "热门榜" },
  { sideType: 13, label: "黑马榜" },
] as const;

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; Juanshe/1.3; +https://github.com/Alexsun1one/juanshe)",
  "Accept": "text/html,application/json,text/plain;q=0.9,*/*;q=0.8",
} as const;

function cleanTitle(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&apos;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeEntries(entries: RankingEntry[], limit: number): RankingEntry[] {
  const seen = new Set<string>();
  const out: RankingEntry[] = [];
  for (const entry of entries) {
    const title = cleanTitle(entry.title);
    if (!title || title.length < 2 || title.length > 60 || seen.has(title)) continue;
    seen.add(title);
    out.push({ ...entry, title });
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await globalThis.fetch(url, {
    headers: DEFAULT_HEADERS,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.text();
}

type HtmlTitlePattern = {
  readonly pattern: RegExp;
  readonly titleGroup?: number;
  readonly authorGroup?: number;
  readonly category?: string;
};

class HtmlRadarSource implements RadarSource {
  readonly name: string;
  private readonly platform: string;
  private readonly url: string;
  private readonly extra: string;
  private readonly patterns: readonly HtmlTitlePattern[];
  private readonly limit: number;

  constructor(input: {
    readonly name: string;
    readonly platform: string;
    readonly url: string;
    readonly extra: string;
    readonly patterns: readonly HtmlTitlePattern[];
    readonly limit?: number;
  }) {
    this.name = input.name;
    this.platform = input.platform;
    this.url = input.url;
    this.extra = input.extra;
    this.patterns = input.patterns;
    this.limit = input.limit ?? 20;
  }

  async fetch(): Promise<PlatformRankings> {
    try {
      const html = await fetchHtml(this.url);
      const entries: RankingEntry[] = [];
      for (const { pattern, titleGroup = 1, authorGroup, category } of this.patterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(html)) !== null) {
          entries.push({
            title: cleanTitle(match[titleGroup] ?? ""),
            author: authorGroup ? cleanTitle(match[authorGroup] ?? "") : "",
            category: category ?? "",
            extra: this.extra,
            url: this.url,
          });
          if (entries.length >= this.limit * 2) break;
        }
      }
      const ranked = dedupeEntries(entries, this.limit);
      return {
        platform: this.platform,
        sourceType: "rank-page",
        sourceUrl: this.url,
        fetchedAt: new Date().toISOString(),
        entries: ranked,
        warning: ranked.length === 0 ? "页面可访问，但未解析到书名；可能是站点改版或反爬。" : undefined,
      };
    } catch (error) {
      return {
        platform: this.platform,
        sourceType: "rank-page",
        sourceUrl: this.url,
        fetchedAt: new Date().toISOString(),
        entries: [],
        warning: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export class FanqieRadarSource implements RadarSource {
  readonly name = "fanqie";

  async fetch(): Promise<PlatformRankings> {
    const entries: RankingEntry[] = [];

    for (const { sideType, label } of FANQIE_RANK_TYPES) {
      try {
        const url = `https://api-lf.fanqiesdk.com/api/novel/channel/homepage/rank/rank_list/v2/?aid=13&limit=15&offset=0&side_type=${sideType}`;
        const res = await globalThis.fetch(url, {
          headers: DEFAULT_HEADERS,
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) continue;
        const data = (await res.json()) as Record<string, unknown>;
        const list = (data as { data?: { result?: unknown[] } }).data?.result;
        if (!Array.isArray(list)) continue;

        for (const item of list) {
          const rec = item as Record<string, unknown>;
          entries.push({
            title: String(rec.book_name ?? ""),
            author: String(rec.author ?? ""),
            category: String(rec.category ?? ""),
            extra: `[${label}]`,
          });
        }
      } catch {
        // skip on network error
      }
    }

    const ranked = dedupeEntries(entries, 30);
    return {
      platform: "番茄小说",
      sourceType: "app-api",
      sourceUrl: "https://fanqienovel.com",
      fetchedAt: new Date().toISOString(),
      entries: ranked,
      warning: ranked.length === 0 ? "未拿到番茄榜单数据；可能是网络、接口或反爬限制。" : undefined,
    };
  }
}

export class QidianRadarSource implements RadarSource {
  readonly name = "qidian";

  async fetch(): Promise<PlatformRankings> {
    const entries: RankingEntry[] = [];

    try {
      const url = "https://www.qidian.com/rank/";
      const html = await fetchHtml(url);

      const bookPattern =
        /<a[^>]*href="\/\/book\.qidian\.com\/info\/(\d+)"[^>]*>([^<]+)<\/a>/g;
      let match: RegExpExecArray | null;
      const seen = new Set<string>();
      while ((match = bookPattern.exec(html)) !== null) {
        const title = match[2].trim();
        if (title && !seen.has(title) && title.length > 1 && title.length < 30) {
          seen.add(title);
          entries.push({ title, author: "", category: "", extra: "[起点热榜]", url: "https://www.qidian.com/rank/" });
        }
        if (entries.length >= 20) break;
      }
    } catch (error) {
      return {
        platform: "起点中文网",
        sourceType: "rank-page",
        sourceUrl: "https://www.qidian.com/rank/",
        fetchedAt: new Date().toISOString(),
        entries: [],
        warning: error instanceof Error ? error.message : String(error),
      };
    }

    const ranked = dedupeEntries(entries, 20);
    return {
      platform: "起点中文网",
      sourceType: "rank-page",
      sourceUrl: "https://www.qidian.com/rank/",
      fetchedAt: new Date().toISOString(),
      entries: ranked,
      warning: ranked.length === 0 ? "页面可访问，但未解析到起点榜单书名。" : undefined,
    };
  }
}

export class ZonghengRadarSource extends HtmlRadarSource {
  constructor() {
    super({
      name: "zongheng",
      platform: "纵横中文网",
      url: "https://book.zongheng.com/rank.html",
      extra: "[纵横榜单]",
      patterns: [
        { pattern: /book\.zongheng\.com\/book\/\d+\.html[^>]*>([^<]{2,60})<\/a>/g },
      ],
    });
  }
}

export class SeventeenKSource extends HtmlRadarSource {
  constructor() {
    super({
      name: "17k",
      platform: "17K 小说网",
      url: "https://www.17k.com/top/",
      extra: "[17K 榜单]",
      patterns: [
        { pattern: /www\.17k\.com\/book\/\d+\.html[^>]*>([^<]{2,60})<\/a>/g },
      ],
    });
  }
}

export class JinjiangRadarSource extends HtmlRadarSource {
  constructor() {
    super({
      name: "jinjiang",
      platform: "晋江文学城",
      url: "https://www.jjwxc.net/topten.php",
      extra: "[晋江榜单]",
      patterns: [
        { pattern: /onebook\.php\?novelid=\d+[^>]*>([^<]{2,60})<\/a>/g },
      ],
    });
  }
}

export class QimaoRadarSource extends HtmlRadarSource {
  constructor() {
    super({
      name: "qimao",
      platform: "七猫小说",
      url: "https://www.qimao.com/rank/",
      extra: "[七猫榜单]",
      patterns: [
        { pattern: /qimao\.com\/shuku\/\d+[^>]*>([^<]{2,60})<\/a>/g },
        { pattern: /<a[^>]+title="([^"]{2,60})"[^>]+href="[^"]*qimao\.com\/shuku\/\d+/g },
      ],
    });
  }
}

export class RoyalRoadRadarSource extends HtmlRadarSource {
  constructor() {
    super({
      name: "royalroad",
      platform: "Royal Road",
      url: "https://www.royalroad.com/fictions/best-rated",
      extra: "[Royal Road best-rated]",
      patterns: [
        { pattern: /href="\/fiction\/\d+\/[^"]+"[^>]*>\s*([^<]{2,80})<\/a>/g },
      ],
    });
  }
}

export class WebNovelRadarSource extends HtmlRadarSource {
  constructor() {
    super({
      name: "webnovel",
      platform: "WebNovel",
      url: "https://www.webnovel.com/ranking/novel",
      extra: "[WebNovel ranking]",
      patterns: [
        { pattern: /href="\/book\/[^"]+"[^>]*>\s*([^<]{2,80})<\/a>/g },
        { pattern: /"bookName"\s*:\s*"([^"]{2,80})"/g },
      ],
    });
  }
}

const DEFAULT_TREND_QUERIES = [
  "起点 月票榜 网络小说 题材 趋势",
  "番茄小说 热榜 网络小说 题材 趋势",
  "晋江文学城 金榜 小说 题材 趋势",
  "七猫 小说 榜单 热门 题材",
  "WebNovel ranking trending genres fantasy romance",
  "Royal Road best rated trending progression fantasy",
] as const;

export class SearchTrendRadarSource implements RadarSource {
  readonly name = "web-trend-search";
  private readonly queries: readonly string[];
  private readonly maxResultsPerQuery: number;

  constructor(queries: readonly string[] = DEFAULT_TREND_QUERIES, maxResultsPerQuery = 3) {
    this.queries = queries;
    this.maxResultsPerQuery = maxResultsPerQuery;
  }

  async fetch(): Promise<PlatformRankings> {
    const entries: RankingEntry[] = [];
    const warnings: string[] = [];
    for (const query of this.queries) {
      try {
        const results = await searchWeb(query, this.maxResultsPerQuery);
        for (const result of results) {
          entries.push({
            title: result.title,
            author: "",
            category: query,
            extra: result.snippet ? `[搜索] ${result.snippet.slice(0, 140)}` : "[搜索]",
            url: result.url,
          });
        }
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
        break;
      }
    }

    return {
      platform: "搜索增强信源",
      sourceType: "web-search",
      sourceUrl: "JUANSHE_SEARCH_API_KEY/TAVILY_API_KEY",
      fetchedAt: new Date().toISOString(),
      entries: dedupeEntries(entries, 24),
      warning: warnings[0],
    };
  }
}
