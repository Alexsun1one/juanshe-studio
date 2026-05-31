import { afterEach, describe, expect, it } from "vitest";
import { SearchTrendRadarSource, TextRadarSource } from "../agents/radar-source.js";

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
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("radar sources", () => {
  it("returns an explicit warning when search is not configured", async () => {
    clearSearchEnv();

    const source = new SearchTrendRadarSource(["起点 月票榜 网络小说"], 1);
    const result = await source.fetch();

    expect(result.platform).toBe("搜索增强信源");
    expect(result.sourceType).toBe("web-search");
    expect(result.entries).toEqual([]);
    expect(result.warning).toContain("JUANSHE_SEARCH_API_KEY");
  });

  it("marks injected research notes as manual sources", async () => {
    const source = new TextRadarSource("短剧化仙侠复仇正在升温", "人工研判");
    const result = await source.fetch();

    expect(result.platform).toBe("人工研判");
    expect(result.sourceType).toBe("manual");
    expect(result.entries[0]?.title).toBe("短剧化仙侠复仇正在升温");
    expect(result.entries[0]?.extra).toBe("[外部分析]");
    expect(result.fetchedAt).toBeTruthy();
  });
});
