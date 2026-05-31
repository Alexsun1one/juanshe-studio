/**
 * Web search + URL fetch utilities.
 *
 * searchWeb(): external search API, currently Tavily.
 * fetchUrl(): Fetch a specific URL and return plain text.
 */

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export function getConfiguredSearchApiKey(): string | undefined {
  return process.env.JUANSHE_SEARCH_API_KEY
    || process.env.HARDWRITE_SEARCH_API_KEY
    || process.env.TAVILY_API_KEY;
}

export function getConfiguredSearchProvider(): string {
  return (process.env.JUANSHE_SEARCH_PROVIDER || process.env.HARDWRITE_SEARCH_PROVIDER || "tavily").toLowerCase();
}

/**
 * Search the web via the configured provider.
 * Chat models only analyze the context we provide here; they do not add live
 * retrieval to this pipeline unless an external search provider is configured.
 */
export async function searchWeb(query: string, maxResults = 5): Promise<ReadonlyArray<SearchResult>> {
  const apiKey = getConfiguredSearchApiKey();
  if (!apiKey) {
    throw new Error("Search is not configured. Set JUANSHE_SEARCH_API_KEY (or TAVILY_API_KEY) to enable live retrieval; DeepSeek and other chat models can analyze provided context but do not fetch web results for this pipeline by themselves.");
  }

  const provider = getConfiguredSearchProvider();
  if (provider !== "tavily") {
    throw new Error(`Unsupported search provider "${provider}". Current Juanshe builds support tavily via JUANSHE_SEARCH_PROVIDER=tavily.`);
  }

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: "basic",
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Tavily search failed: ${res.status} ${await res.text().catch(() => "")}`);
  }

  const data = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
}

/**
 * Fetch a URL and return its text content.
 * HTML is stripped to plain text. Output is truncated to maxChars.
 */
export async function fetchUrl(url: string, maxChars = 8000): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "text/html, application/json, text/plain",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();

  if (contentType.includes("html")) {
    return text
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxChars);
  }

  return text.slice(0, maxChars);
}
