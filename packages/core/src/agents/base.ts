import type { LLMClient, LLMMessage, LLMResponse, OnStreamProgress } from "../llm/provider.js";
import { chatCompletion } from "../llm/provider.js";
import { searchWeb, fetchUrl } from "../utils/web-search.js";
import type { Logger } from "../utils/logger.js";

export interface AgentContext {
  readonly client: LLMClient;
  readonly model: string;
  readonly projectRoot: string;
  readonly bookId?: string;
  readonly logger?: Logger;
  readonly onStreamProgress?: OnStreamProgress;
  readonly onTextDelta?: (text: string) => void;
}

export abstract class BaseAgent {
  protected readonly ctx: AgentContext;

  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  protected get log() {
    return this.ctx.logger;
  }

  protected async chat(
    messages: ReadonlyArray<LLMMessage>,
    options?: { readonly temperature?: number; readonly maxTokens?: number; readonly requireComplete?: boolean },
  ): Promise<LLMResponse> {
    return chatCompletion(this.ctx.client, this.ctx.model, messages, {
      ...options,
      onStreamProgress: this.ctx.onStreamProgress,
      onTextDelta: this.ctx.onTextDelta,
      onRetry: this.buildRetryReporter(),
    });
  }

  /**
   * 把"模型挂起/抖动正在自动重试"经 ctx.logger(已接 SSE sink)透出到前台运行日志/错误中心,
   * 让用户实时看到"在重试",而不是只在后台 stdout 静默重试。
   */
  private buildRetryReporter(): (attempt: number, error: unknown) => void {
    return (attempt, error) => {
      const text = String((error as { message?: string })?.message ?? error);
      const reason = text.includes("LLM_CALL_TIMEOUT") || text.includes("挂起")
        ? "模型响应超时挂起"
        : "网络 / 上游瞬时抖动";
      this.ctx.logger?.warn(`模型调用第 ${attempt} 次自动重试（${reason}）`);
    };
  }

  /**
   * Chat with web search enabled.
   * OpenAI: uses native web_search_options / web_search_preview.
   * Other providers: searches via Tavily API (TAVILY_API_KEY), injects results into prompt.
   */
  protected async chatWithSearch(
    messages: ReadonlyArray<LLMMessage>,
    options?: { readonly temperature?: number; readonly maxTokens?: number },
  ): Promise<LLMResponse> {
    // OpenAI has native search — use it directly
    if (this.ctx.client.provider === "openai") {
      return chatCompletion(this.ctx.client, this.ctx.model, messages, {
        ...options,
        webSearch: true,
        onStreamProgress: this.ctx.onStreamProgress,
        onTextDelta: this.ctx.onTextDelta,
      });
    }

    // Other providers: self-hosted search → inject results into prompt
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) {
      return this.chat(messages, options);
    }

    try {
      // Extract search query from user message (first 200 chars) — flatten blocks if needed
      const queryText = typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : lastUserMsg.content.map((b) => b.text).join("");
      const query = queryText.slice(0, 200);
      this.log?.info(`[search] Searching: ${query.slice(0, 60)}...`);

      const results = await searchWeb(query, 3);
      if (results.length === 0) {
        this.log?.warn("[search] No results found, falling back to regular chat");
        return this.chat(messages, options);
      }

      // Fetch top result for full content
      let fullContent = "";
      try {
        fullContent = await fetchUrl(results[0]!.url, 4000);
      } catch {
        // Fetch failed, use snippets only
      }

      const searchContext = [
        "## Web Search Results\n",
        ...results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`),
        ...(fullContent ? [`\n## Full Content (Top Result)\n${fullContent}`] : []),
      ].join("\n");

      // Inject search results before the last user message
      const augmentedMessages: LLMMessage[] = messages.map((m) =>
        m === lastUserMsg
          ? { ...m, content: `${searchContext}\n\n---\n\n${m.content}` }
          : m,
      );

      return this.chat(augmentedMessages, options);
    } catch (e) {
      this.log?.warn(`[search] Search failed: ${e}, falling back to regular chat`);
      return this.chat(messages, options);
    }
  }

  abstract get name(): string;
}
