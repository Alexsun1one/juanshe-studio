import type { LLMConfig } from "../models/project.js";
import {
  streamSimple as piStreamSimple,
  stream as piStream,
  completeSimple as piCompleteSimple,
  complete as piComplete,
} from "@mariozechner/pi-ai";
import type {
  Api as PiApi,
  Model as PiModel,
  Context as PiContext,
  Tool as PiTool,
  TextContent as PiTextContent,
  ToolCall as PiToolCall,
} from "@mariozechner/pi-ai";
import { normalizeServiceApi, normalizeServiceBaseUrl, resolveCustomServiceApi, resolveCustomServiceProviderFamily, resolveServicePreset } from "./service-presets.js";
import { getEndpoint } from "./providers/index.js";
import { lookupModel } from "./providers/lookup.js";
import { fetchWithProxy } from "../utils/proxy-fetch.js";
import { isApiKeyOptionalForEndpoint } from "../utils/llm-endpoint-auth.js";


// === Streaming Monitor Types ===

export interface StreamProgress {
  readonly elapsedMs: number;
  readonly totalChars: number;
  readonly chineseChars: number;
  readonly status: "streaming" | "done";
}

export type OnStreamProgress = (progress: StreamProgress) => void;

const JUANSHE_USER_AGENT = "Juanshe/1.3.5";
const UNKNOWN_MODEL_FALLBACK_MAX_TOKENS = 8192 * 3;
const TRANSIENT_LLM_RETRIES = 2;
// 单次 LLM 调用超时,把"模型挂起不返回"变成可处理的错误,避免无限期冻结工作流。
// 默认宽松(正常慢生成不会触发);可用环境变量调小以更快放弃挂起的请求。
const LLM_TOTAL_TIMEOUT_MS = Math.max(30000, Number(process.env.HARDWRITE_LLM_TIMEOUT_MS) || 240000);
// 默认 180s:推理模型(如 mimo / o1 系列)在大上下文上"先思考后吐字",首 token 常 >90s;
// 90s 太紧会把正常的慢推理误判为挂起。可用 HARDWRITE_LLM_IDLE_TIMEOUT_MS 再调高/调低。
const LLM_IDLE_TIMEOUT_MS = Math.max(15000, Number(process.env.HARDWRITE_LLM_IDLE_TIMEOUT_MS) || 180000);
// 流式调用的「总时长」硬上限:idle 超时改为「任何流活动都复位」后,一个一直吐活动(思考/
// keepalive/工具调用…)却永不收尾的流会永不触发 idle——这道天花板兜底,任何流式调用最多跑这么久。
// 默认 20min(覆盖大上下文长章的正常生成),可用 HARDWRITE_LLM_STREAM_TIMEOUT_MS 调。
const LLM_STREAM_TOTAL_TIMEOUT_MS = Math.max(60000, Number(process.env.HARDWRITE_LLM_STREAM_TIMEOUT_MS) || 1200000);

function mergeUserAgent(headers?: Record<string, string>): Record<string, string> {
  return { "User-Agent": JUANSHE_USER_AGENT, ...(headers ?? {}) };
}

export function createStreamMonitor(
  onProgress?: OnStreamProgress,
  intervalMs: number = 30000,
): { readonly onChunk: (text: string) => void; readonly stop: () => void } {
  let totalChars = 0;
  let chineseChars = 0;
  const startTime = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;

  if (onProgress) {
    timer = setInterval(() => {
      onProgress({
        elapsedMs: Date.now() - startTime,
        totalChars,
        chineseChars,
        status: "streaming",
      });
    }, intervalMs);
  }

  return {
    onChunk(text: string): void {
      totalChars += text.length;
      chineseChars += (text.match(/[\u4e00-\u9fff]/g) || []).length;
    },
    stop(): void {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      onProgress?.({
        elapsedMs: Date.now() - startTime,
        totalChars,
        chineseChars,
        status: "done",
      });
    },
  };
}

// === Shared Types ===

export interface LLMResponse {
  readonly content: string;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

/**
 * 单条消息的内容 — 可以是简单字符串(向后兼容),也可以是分块的 ContentBlock 数组。
 * 分块的目的:支持 Anthropic prompt caching(`cache_control: ephemeral` 加在 block 末尾)。
 * OpenAI 路径会把 blocks flatten 成字符串(它自己做隐式 prefix caching,不需要显式 marker)。
 */
export interface LLMContentBlock {
  readonly text: string;
  /** 标记该 block 为可缓存的"前缀终点"。Anthropic 上加 cache_control: { type: "ephemeral" }。
   *  典型用法:长 system prompt / 大段稳定的章节正文 → 后续相同前缀的请求命中缓存。
   *  注意:Anthropic 限制每次最多 4 个 cache_control 断点。 */
  readonly cache?: boolean;
}

export interface LLMMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string | ReadonlyArray<LLMContentBlock>;
}

/** 把消息内容统一成字符串(给不支持 blocks 的 provider 用) */
export function flattenMessageContent(content: LLMMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((b) => b.text).join("");
}

/** 把消息内容统一成 blocks 数组(给 Anthropic 等支持 cache_control 的 provider 用) */
export function toContentBlocks(content: LLMMessage["content"]): ReadonlyArray<LLMContentBlock> {
  if (typeof content === "string") return [{ text: content }];
  return content;
}

/** 消息列表里有没有 cache 标记 */
function messagesHaveCacheMarkers(messages: ReadonlyArray<LLMMessage>): boolean {
  return messages.some((m) =>
    typeof m.content !== "string" && m.content.some((b) => b.cache === true),
  );
}

export interface LLMClient {
  readonly provider: "openai" | "anthropic";
  readonly service?: string;
  readonly configSource?: LLMConfig["configSource"];
  readonly apiFormat: "chat" | "responses";
  readonly stream: boolean;
  readonly proxyUrl?: string;
  readonly _piModel?: PiModel<PiApi>;
  readonly _apiKey?: string;
  /** 可选 embedding 模型 id(语义检索用)。配置了才启用语义重排,否则纯词面。 */
  readonly embeddingModel?: string;
  /** 可选 embedding 专用 baseUrl。chat 服务(如 deepseek)没有 /embeddings 时,可把嵌入指向本地 Ollama(bge-m3)等;未设则复用本 client 的 baseUrl。 */
  readonly embeddingBaseUrl?: string;
  readonly defaults: {
    readonly temperature: number;
    /**
     * Per-call fallback: 当 agent 调 chat() 不传 options.maxTokens 时用这个值。
     * 命中模型卡时来自 providers bank 的 modelCard.maxOutput；未知模型走写作兜底预算。
     */
    readonly maxTokens: number;
    /**
     * Legacy mock compatibility only. v2 provider resolution no longer caps
     * per-call maxTokens from project config; model max output comes from the
     * provider bank.
     */
    readonly maxTokensCap?: number | null;
    readonly thinkingBudget: number;
    readonly extra: Record<string, unknown>;
  };
}

// === Tool-calling Types ===

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export type AgentMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null; readonly toolCalls?: ReadonlyArray<ToolCall> }
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string };

export interface ChatWithToolsResult {
  readonly content: string;
  readonly toolCalls: ReadonlyArray<ToolCall>;
}

// === Factory ===

export function createLLMClient(config: LLMConfig): LLMClient {
  // C1 (v2.0.0)：config.maxTokens / maxTokensCap 已删除；defaults.maxTokens 完全从 modelCard 推导。
  const rawServiceName = config.service ?? "custom";
  const baseServiceName = rawServiceName.startsWith("custom:") ? "custom" : rawServiceName;
  const _earlyCard = lookupModel(baseServiceName, config.model);
  const defaults = {
    temperature: config.temperature ?? 0.7,
    maxTokens: _earlyCard?.maxOutput ?? UNKNOWN_MODEL_FALLBACK_MAX_TOKENS,
    thinkingBudget: config.thinkingBudget ?? 0,
    extra: config.extra ?? {},
  };

  const apiFormat = config.apiFormat ?? "chat";
  const stream = config.stream ?? true;

  // --- Build pi-ai Model object ---
  const serviceName = rawServiceName;
  const preset = resolveServicePreset(baseServiceName);
  const hardWriteProvider = getEndpoint(baseServiceName);
  const modelCard = lookupModel(baseServiceName, config.model);

  const piApi = resolvePiApi(
    baseServiceName,
    config.apiFormat,
    (hardWriteProvider?.api ?? preset?.api) as PiApi,
    config.provider,
    config.api,
  ) as PiApi;
  const baseUrl = normalizeServiceBaseUrl(config.baseUrl || hardWriteProvider?.baseUrl || preset?.baseUrl || "");
  const extraHeaders = config.headers ?? parseEnvHeaders();
  const compat = piApi === "openai-completions"
    ? resolveProviderCompat(hardWriteProvider, baseUrl)
    : undefined;

  const provider = config.provider === "anthropic" ? "anthropic" : "openai";
  // pi-ai provider 字段：大多数情况 pi-ai 会按 baseUrl 自动嗅探（openrouter.ai / api.z.ai /
  // api.x.ai / deepseek.com / anthropic.com 等）。这里只列 pi-ai 嗅探不到、需要显式指定的少数情况。
  let piProvider: string;
  if (hardWriteProvider?.id === "google") piProvider = "google";
  else if (hardWriteProvider?.id === "zhipu") piProvider = "zai";
  else if (hardWriteProvider?.id === "openrouter") piProvider = "openrouter";
  else if (hardWriteProvider?.id === "githubCopilot") piProvider = "githubCopilot";
  else if (hardWriteProvider?.id === "ollama") piProvider = "ollama";
  else if (hardWriteProvider?.api === "anthropic-messages") piProvider = "anthropic";
  else piProvider = provider;

  const piModel: PiModel<PiApi> = {
    id: modelCard?.deploymentName ?? config.model,
    name: config.model,
    api: piApi,
    provider: piProvider,
    baseUrl,
    // 注意：piModel.reasoning 是"激活 reasoning 模式"标志（会让 pi-ai 把 system 改成 developer role 等），
    // 不是"模型能力"标签。只有用户显式配了 thinkingBudget > 0 才启用 reasoning mode。
    // 千万不要从 lobe abilities.reasoning 自动推导，否则 Moonshot 这类不支持 developer role 的服务
    // 会把 content 吃掉，只返回 reasoning_content（见 R4 bug 1 诊断）。
    reasoning: (config.thinkingBudget ?? 0) > 0,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelCard?.contextWindowTokens ?? 128_000,
    maxTokens: modelCard?.maxOutput ?? UNKNOWN_MODEL_FALLBACK_MAX_TOKENS,
    ...(extraHeaders ? { headers: extraHeaders } : {}),
    ...(compat ? { compat } : {}),
  };

  return {
    provider,
    service: serviceName,
    configSource: config.configSource,
    apiFormat,
    stream,
    proxyUrl: config.proxyUrl,
    _piModel: piModel,
    _apiKey: config.apiKey,
    embeddingModel: config.embeddingModel,
    embeddingBaseUrl: config.embeddingBaseUrl,
    defaults,
  };
}

function resolvePiApi(
  serviceName: string,
  apiFormat: LLMConfig["apiFormat"] | undefined,
  presetApi: PiApi | undefined,
  providerFamily: LLMConfig["provider"] | undefined,
  explicitApi: LLMConfig["api"] | undefined,
): PiApi {
  if (serviceName === "custom") {
    const normalizedApi = normalizeServiceApi(explicitApi);
    if (normalizedApi) return normalizedApi as PiApi;
    if (resolveCustomServiceProviderFamily({ providerFamily }) === "anthropic") {
      return resolveCustomServiceApi({ providerFamily }) as PiApi;
    }
    return apiFormat === "responses" ? "openai-responses" : "openai-completions";
  }
  return (presetApi ?? "openai-completions") as PiApi;
}

function resolveProviderCompat(
  provider: ReturnType<typeof getEndpoint>,
  baseUrl: string,
): Record<string, unknown> | undefined {
  const compat = {
    ...(provider?.compat ?? {}),
    ...(baseUrl.includes("generativelanguage.googleapis.com") ? { supportsStore: false } : {}),
  };
  return Object.keys(compat).length > 0 ? compat : undefined;
}

function parseEnvHeaders(): Record<string, string> | undefined {
  const raw = process.env.HARDWRITE_LLM_HEADERS ?? process.env.AUTOW_LLM_HEADERS;
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // not JSON — treat as single "Key: Value" pair
    const idx = raw.indexOf(":");
    if (idx > 0) {
      return { [raw.slice(0, idx).trim()]: raw.slice(idx + 1).trim() };
    }
  }
  return undefined;
}

// === Partial Response (stream interrupted but usable content received) ===

export class PartialResponseError extends Error {
  readonly partialContent: string;
  constructor(partialContent: string, cause: unknown) {
    super(`Stream interrupted after ${partialContent.length} chars: ${String(cause)}`);
    this.name = "PartialResponseError";
    this.partialContent = partialContent;
  }
}

/** Minimum chars to consider a partial response salvageable (Chinese ~2 chars/word → 500 chars ≈ 250 words) */
const MIN_SALVAGEABLE_CHARS = 500;

/** Keys managed by the provider layer — prevent extra from overriding them. */
const RESERVED_KEYS = new Set(["max_tokens", "temperature", "model", "messages", "stream"]);

function stripReservedKeys(extra: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (!RESERVED_KEYS.has(key)) result[key] = value;
  }
  return result;
}

// === Fixed-Temperature Model Clamp ===
//
// 部分 thinking 模型（如 Moonshot kimi-k2.5/k2.6、kimi-k2-thinking）的 API
// 硬要求 temperature === 1，其他值会被直接 400 拒绝（Moonshot 返回
// `invalid temperature: only 1 is allowed for this model`）。
//
// 卷舍让 writer/validator/architect 各自带 per-call 温度（0.1~1.5），
// 所以 provider 层统一夹制：如果 bank 里模型卡标了 temperature 字段，
// 就把 per-call 温度 clamp 到那个值，并对每个模型名打一次 warning。
//
// 这个字段只表达"服务端硬约束"，普通模型不要标，避免误伤 per-call 调参。

const warnedFixedTemperatureModels = new Set<string>();

function clampTemperatureForModel(
  service: string | undefined,
  model: string,
  requested: number,
): number {
  const card = service ? lookupModel(service, model) : undefined;
  if (card?.temperature === undefined) return requested;
  const locked = card.temperature;
  if (requested === locked) return locked;
  if (!warnedFixedTemperatureModels.has(model)) {
    warnedFixedTemperatureModels.add(model);
    console.warn(
      `[juanshe] 模型 "${model}" API 要求 temperature=${locked}，已 clamp（原值 ${requested}）`,
    );
  }
  return locked;
}

// 仅测试用：清空 warning 去重集合。
export function __resetFixedTemperatureWarnings(): void {
  warnedFixedTemperatureModels.clear();
}

// === Error Wrapping ===

// 把上游/中转站常见英文错误翻译成给终端用户的中文人话提示。
// 命中 → 返回带 { cause: error } 的新 Error：原始英文仍进日志 / isTransientLLMTransportError
//        仍能顺 .cause 链判定瞬时性；命中文案直接展示给用户（write-mode toast / 活动流）。
// 未命中 → 返回 null，回落到 wrapLLMError 既有默认分支，零回归。
// 设计前提：本函数在 wrapLLMError 的所有具体状态码分支（400/401/403/429/连接/5xx-no-body）
//          之后才被调用，只翻译"掉到默认兜底"的错误（中转站 503 无渠道、404 模型不存在、
//          402 余额不足等当前会吐原始英文的情形）。
function translateUpstreamError(
  error: unknown,
  msg: string,
  context?: { readonly baseUrl?: string; readonly model?: string },
): Error | null {
  const detail = msg.replace(/^Error:\s*/i, "").trim().slice(0, 200);
  const model = context?.model || msg.match(/model[\s:"']*([\w\-.]+)/i)?.[1] || "该模型";
  const baseUrl = context?.baseUrl;
  const compose = (headline: string, actions: string): Error => {
    const body =
      `${headline}\n`
      + (detail && detail !== "[object Object]" ? `上游原始报错：${detail}\n` : "")
      + (baseUrl ? `当前接口/中转站：${baseUrl}\n` : "")
      + actions;
    return new Error(body, { cause: error });
  };

  // 1. 中转站无可用渠道（one-api / new-api / 博洛类聚合站典型：「503 No available channel for model X」）。
  //    用文本而非裸 503 判定，避免把直连服务商的普通 503 误贴「无渠道」标签。
  if (/no available channel|no channel available|channel not found|无可用渠道|当前分组.{0,16}无.{0,4}渠道/i.test(msg)) {
    return compose(
      `上游中转站对「${model}」返回了「无可用渠道」(no available channel)。两种常见原因都核一下——多数情况是①：① 模型名没跟中转站后台「已上架模型名」一字对上（最常见是多写/漏写了 provider 前缀如 \`qwen/\`、大小写或版本号对不上）；② 这把令牌所在分组确实没绑到该模型的可用渠道（渠道被禁用 / 欠费 / 没加进当前分组）。`,
      `怎么办：\n`
      + `  1. 先去 LLM 设置，把模型名和中转站后台「已上架模型名」逐字符比对（尤其 \`qwen/\` 这类前缀该不该带、大小写、版本号）——这一步最容易中招\n`
      + `  2. 用「模型连通性检测」试一下当前模型名能不能通\n`
      + `  3. 确认无误仍报无渠道，再去中转站后台看该模型的分组/上游渠道是否启用，或换一个确实在售的模型`,
    );
  }

  // 2. 模型不存在 / 未上架（404、model not found、未知模型）。
  if (/\b404\b|model[_\s]?not[_\s]?found|no such model|model does not exist|unknown model|invalid model|未找到.{0,4}模型|模型不存在|模型未上架/i.test(msg)) {
    return compose(
      `上游找不到「${model}」这个模型（模型名写错、大小写不符，或这个接口根本没上架它）。`,
      `怎么办：\n`
      + `  1. 去 LLM 设置核对模型名，和服务商 /models 列表里的名字逐字符对齐\n`
      + `  2. 用「模型连通性检测」试一下当前模型是否可用\n`
      + `  3. 确认这个 baseUrl 对应的服务商确实提供该模型`,
    );
  }

  // 3. 余额不足 / 额度用尽（402、insufficient_quota、欠费）。
  if (/\b402\b|insufficient[_\s]?(quota|balance|credit)|payment required|余额不足|额度不足|额度已用|欠费|您的余额|账户余额/i.test(msg)) {
    return compose(
      `上游 API 账户余额 / 额度不足，调用被拒（扣的是你自己那把 key 的钱，不是卷舍积分）。`,
      `怎么办：\n`
      + `  1. 去服务商 / 中转站后台给这把 API Key 充值或提额\n`
      + `  2. 或在 LLM 设置换一把有余额的 Key`,
    );
  }

  // 4. 密钥无效 / 未授权（部分中转站用文字而非 401 数字报，故在此兜底）。
  if (/invalid[_\s]?api[_\s]?key|incorrect api key|api key.{0,8}(invalid|expired|wrong)|invalid[_\s]?token|令牌.{0,4}(无效|错误)|密钥.{0,4}(无效|错误)|认证失败|鉴权失败/i.test(msg)) {
    return compose(
      `上游拒绝了这把 API Key（无效、过期或填错）。`,
      `怎么办：\n`
      + `  1. 去 LLM 设置重新粘贴正确的 API Key（注意别带多余空格 / 换行）\n`
      + `  2. 确认这把 Key 对应的正是当前填的 baseUrl 那个服务商`,
    );
  }

  // 5. 限流 / 频控（429 数字一般已被上游分支拦，这里兜文字与 TPM/RPM 表述）。
  if (/rate[_\s]?limit|too many requests|请求过于频繁|频率限制|触发限流|\bt?pm\b限|并发.{0,4}(超|限)|concurrency limit/i.test(msg)) {
    return compose(
      `触发了上游的频率限制（请求太密、或超了 TPM/RPM/并发配额）。`,
      `怎么办：\n`
      + `  1. 等几十秒到一两分钟再重试\n`
      + `  2. 若批量写作并发太高，调小并发档，或换更高配额的 Key / 服务商`,
    );
  }

  // 6. 内容审查拦截（公益 / 免费 / 国产中转常见）。
  if (/content[_\s]?(policy|filter|moderation)|risk[_\s]?control|内容审查|内容安全|敏感词|命中.{0,4}风控|policy violation|flagged|safety system/i.test(msg)) {
    return compose(
      `请求被上游的内容审查拦下了（这一段触发了服务商的敏感内容策略）。`,
      `怎么办：\n`
      + `  1. 这类拦截多由暴力 / 露骨 / 政治敏感情节触发，可微调本章设定后重试\n`
      + `  2. 或换一个对小说内容更宽松的服务商 / 模型`,
    );
  }

  // 7. 消息格式 / role 不兼容（部分服务不支持 system / developer role 或多模态结构）。
  if (/system role|developer role|role.{0,12}(not supported|unsupported|invalid|must be)|messages.{0,16}(invalid|format|must)|不支持.{0,4}role|消息格式.{0,4}(错误|不兼容)/i.test(msg)) {
    return compose(
      `上游不接受当前的消息格式（多半是不支持 system / developer role，或消息结构要求不同）。`,
      `怎么办：\n`
      + `  1. 在 LLM 设置把「接口格式」切到与该服务商匹配的那种（OpenAI / Anthropic）\n`
      + `  2. 或换一个标准 OpenAI 兼容的服务商`,
    );
  }

  // 8. 空响应 / 无内容（连通但上游返回空，常因模型故障或被静默截断）。
  if (/empty (response|completion|content)|no (content|choices|completion)|返回为空|响应为空|空响应|生成内容为空/i.test(msg)) {
    return compose(
      `上游连上了，但返回了空内容（没生成任何正文）。`,
      `怎么办：\n`
      + `  1. 直接重试一次，多数是上游临时抽风\n`
      + `  2. 若反复为空，换个模型试试，可能是该模型当前不稳定`,
    );
  }

  // 9. 上游故障 / 过载 / 网关错误（通用 5xx，放在 503-无渠道之后，避免抢匹配）。
  if (/\b50[0-4]\b|service unavailable|bad gateway|gateway time-?out|internal server error|upstream error|server overload|过载|服务不可用|网关.{0,4}(错误|超时)/i.test(msg)) {
    return compose(
      `上游服务临时故障或过载（${model} 这次没能正常返回，属于服务商侧的波动）。`,
      `怎么办：\n`
      + `  1. 等一会儿直接重试，这类故障通常几分钟内自愈\n`
      + `  2. 若持续报错，换个模型 / 服务商，或稍后再来`,
    );
  }

  return null;
}

// 把上游(中转/服务商)返回的真实错因抽出来 + 脱敏(去掉可能回显的 key/token),供 401/403 透出。
// 不再把"为什么被拒"吞成笼统一句——用户/运维一看就知道是没额度 / key 停用 / IP 没放行 / 区域限制。
function redactedUpstreamDetail(error: unknown, msg: string): string {
  let detail = "";
  if (error && typeof error === "object") {
    const bodyLike = (error as { error?: unknown; body?: unknown }).error
      ?? (error as { body?: unknown }).body;
    if (bodyLike && typeof bodyLike === "object") {
      const b = bodyLike as { reason?: string; message?: string; type?: string };
      if (b.message) detail = b.type ? `${b.type}: ${b.message}` : b.message;
      else if (b.reason) detail = b.reason;
    }
  }
  if (!detail) {
    const raw = msg.replace(/^Error:\s*/i, "").trim();
    if (raw && raw !== "[object Object]") detail = raw;
  }
  return detail
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-(?:or-v1-)?[A-Za-z0-9_-]{8,}/gi, "sk-[redacted]")
    .slice(0, 300);
}

function wrapLLMError(
  error: unknown,
  context?: { readonly baseUrl?: string; readonly model?: string; readonly maxTokens?: number; readonly temperature?: number },
): Error {
  // 幂等:error 若已被本函数包过(消息以"API 返回"/"模型调用超时"开头,或已含"服务商原话"),
  // 直接返回——重试层 / 多层调用会重复包,否则出现"API 返回 401…服务商原话:API 返回 401…"套娃。
  if (error instanceof Error
    && (/^(API 返回|模型调用超时)/.test(error.message) || error.message.includes("服务商原话"))) {
    return error;
  }
  const msg = String(error);
  const ctxLine = context
    ? `\n  (baseUrl: ${context.baseUrl}, model: ${context.model}`
      + `${context.maxTokens != null ? `, max_tokens: ${context.maxTokens}` : ""}`
      + `${context.temperature != null ? `, temperature: ${context.temperature}` : ""})`
    : "";

  // 调用级超时(空闲/总时长)不是 HTTP 错误——必须在状态码匹配之前拦截。
  // 否则超时消息里的 "240000ms" 会被 includes("400") 误判成 HTTP 400(真实踩过)。
  if (error instanceof LLMTimeoutError || msg.includes("LLM_CALL_TIMEOUT")) {
    const detail = msg.replace(/^Error:\s*/i, "").trim();
    return new Error(
      `模型调用超时:${detail}。\n` +
      `常见原因:上游模型临时挂起 / 长文本生成过慢 / 网络抖动。建议重试;若反复超时,考虑换更快的模型或拆短单章。${ctxLine}`,
    );
  }

  // 状态码用词边界匹配(\b),避免把 token 数 / 时长里的 "400" 等数字误判成 HTTP 状态。
  if (/\b400\b/.test(msg)) {
    // 抽上游 error body 的 message / reason / code（和下方 5xx 一致），让真实错因浮到用户面前
    let detail = "";
    if (error && typeof error === "object") {
      const err = error as { error?: unknown; body?: unknown; message?: string };
      const bodyLike = err.error ?? err.body;
      if (bodyLike && typeof bodyLike === "object") {
        const b = bodyLike as { reason?: string; message?: string; code?: number | string; type?: string };
        if (b.message) detail = b.type ? `${b.type}: ${b.message}` : b.message;
        else if (b.reason) detail = b.reason;
      }
    }
    // 多数传输层（PiAi / 原生）把上游原因直接放进 Error message，而非结构化 error/body 字段；
    // 结构化抽取落空时回退到原始消息，确保真实错因（如具体的参数越界说明）不被吞掉。
    if (!detail) {
      const raw = msg.replace(/^Error:\s*/i, "").trim();
      if (raw && raw !== "[object Object]") detail = raw.slice(0, 600);
    }
    return new Error(
      `API 返回 400（请求参数错误）。${detail ? `上游详情：${detail}。\n` : ""}` +
      `常见原因：\n` +
      `  1. temperature / max_tokens 超出模型约束（如 Moonshot kimi-k2.X 强制 temperature=1）\n` +
      `  2. 模型名称不正确或未上架\n` +
      `  3. 消息格式不兼容（部分服务不支持 system role 或 developer role）${ctxLine}`,
    );
  }
  if (/\b403\b/.test(msg)) {
    const upstream = redactedUpstreamDetail(error, msg);
    return new Error(
      `API 返回 403 (请求被拒绝)。可能原因：\n` +
      `  1. API Key 无效或过期\n` +
      `  2. API 提供方的内容审查拦截了请求（公益/免费 API 常见）\n` +
      `  3. 账户余额不足 / 该 Key 限制了来源 IP（服务器出口 IP 未被放行）\n` +
      `  建议：用模型连通性检测测试 API，或换一个不限制内容的 API 提供方${upstream ? `\n  服务商原话：${upstream}` : ""}${ctxLine}`,
    );
  }
  if (/\b401\b/.test(msg)) {
    const upstream = redactedUpstreamDetail(error, msg);
    return new Error(
      `API 返回 401 (未授权)：你配置的 API Key 被该服务商拒绝。请确认这把 Key 正确、未过期、有余额,且确实属于该服务商（不同服务商的 Key 不通用）。${upstream ? `\n服务商原话：${upstream}` : ""}${ctxLine}`,
    );
  }
  if (/\b429\b/.test(msg)) {
    return new Error(
      `API 返回 429 (请求过多)。请稍后重试，或检查 API 配额。${ctxLine}`,
    );
  }
  if (
    msg.includes("Connection error")
    || msg.includes("ECONNREFUSED")
    || msg.includes("ENOTFOUND")
    || msg.includes("fetch failed")
    || msg.includes("terminated")
    || msg.includes("UND_ERR_SOCKET")
    || msg.includes("ECONNRESET")
    || msg.includes("ETIMEDOUT")
    || msg.includes("EPIPE")
  ) {
    return new Error(
      `无法连接到 API 服务。可能原因：\n` +
      `  1. baseUrl 地址不正确（当前：${context?.baseUrl ?? "未知"}）\n` +
      `  2. 网络不通或被防火墙拦截\n` +
      `  3. API 服务暂时不可用\n` +
      `  建议：检查 JUANSHE_LLM_BASE_URL 是否包含完整路径（如 /v1）；旧 HARDWRITE_LLM_BASE_URL / AUTOW_LLM_BASE_URL 仍兼容。`,
    );
  }
  // R4 Bug 2: 5xx "status code (no body)" — 尝试从 OpenAI SDK APIError 里抽 body 给用户看具体原因
  // （如 PPIO 的 {"code":500,"reason":"MODEL_NOT_AVAILABLE","message":"model not available"}）
  if (msg.includes("status code") && msg.includes("no body")) {
    let detail = "";
    if (error && typeof error === "object") {
      const err = error as { error?: unknown; body?: unknown; message?: string };
      const bodyLike = err.error ?? err.body;
      if (bodyLike && typeof bodyLike === "object") {
        const b = bodyLike as { reason?: string; message?: string; code?: number | string };
        if (b.reason) detail = `${b.reason}${b.message ? `: ${b.message}` : ""}`;
        else if (b.message) detail = b.message;
      }
    }
    return new Error(
      `API 返回 5xx（上游服务异常）。${detail ? `上游详情：${detail}。` : ""}\n` +
      `可能原因：\n` +
      `  1. 模型在 /models 列表但 inference 未上架（如 PPIO 返回 MODEL_NOT_AVAILABLE）\n` +
      `  2. 服务端临时故障，稍后重试\n` +
      `  3. 当前 apikey 无权限调用该模型${ctxLine}`,
    );
  }
  // 上述具体状态码分支之外，把中转站/上游的常见英文错误翻译成人话（中转站 503 无渠道、
  // 404 模型不存在、402 余额不足等当前会掉到默认兜底吐英文的情形）。未命中返回 null 不影响兜底。
  const translated = translateUpstreamError(error, msg, context);
  if (translated) return translated;
  return error instanceof Error ? error : new Error(msg);
}

function collectErrorText(error: unknown, depth = 0): string {
  if (depth > 4 || error === null || error === undefined) return "";
  const parts = [String(error)];
  if (error instanceof Error) {
    parts.push(error.name, error.message);
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause) parts.push(collectErrorText(cause, depth + 1));
  } else if (typeof error === "object") {
    const err = error as { code?: unknown; cause?: unknown; message?: unknown; name?: unknown };
    if (err.name) parts.push(String(err.name));
    if (err.message) parts.push(String(err.message));
    if (err.code) parts.push(String(err.code));
    if (err.cause) parts.push(collectErrorText(err.cause, depth + 1));
  }
  return parts.join("\n");
}

function isTransientLLMTransportError(error: unknown): boolean {
  const text = collectErrorText(error);
  return [
    "terminated",
    "UND_ERR_SOCKET",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "socket hang up",
    "other side closed",
    "network socket disconnected",
    "LLM_CALL_TIMEOUT",
  ].some((needle) => text.includes(needle));
}

class LLMTimeoutError extends Error {
  constructor(ms: number, kind: "idle" | "total") {
    super(`LLM_CALL_TIMEOUT: 模型${kind === "idle" ? `空闲 ${ms}ms 无输出` : ` ${ms}ms 内无响应`},判定为挂起`);
    this.name = "LLMTimeoutError";
  }
}

/**
 * 给单次 LLM 调用加超时,把"挂起不返回"变成可抛出的超时错误,避免无限期冻结工作流。
 *   - 非流式:总超时(LLM_TOTAL_TIMEOUT_MS)。
 *   - 流式:双闸——① 空闲超时(LLM_IDLE_TIMEOUT_MS),由「任何流活动」复位(正文/思考/工具/keepalive
 *     等,见各 transport 的 reader 循环顶部 onTextDelta?.(""));② 总时长硬上限(LLM_STREAM_TOTAL_TIMEOUT_MS),
 *     永不复位,兜住「一直有活动但永不收尾」。只杀真正卡死/失控的流,不误杀「慢但在思考/在产出」的流
 *     ——治推理模型(MiMo/o1/kimi-thinking 等)思考阶段被误判挂起。
 * 注意:超时只解除"等待",底层 fetch 可能仍在后台跑完(可接受);目的是让上层能重试 / 走 recovery,而不是卡死。
 */
async function withCallTimeout<T>(
  start: (wrappedDelta?: (text: string) => void) => Promise<T>,
  originalDelta: ((text: string) => void) | undefined,
  overrideTotalMs?: number,
): Promise<T> {
  const streaming = Boolean(originalDelta);
  // 连通性探测等场景可传 overrideTotalMs 设一个硬性短上限:非流式总超时、流式空闲与硬上限都不超过它,
  // 让"测试连接"几秒内必出结论,而不是继承 240s / 20min 的正文生成预算把慢网关拖成"未联通"。
  const nonStreamTotal = overrideTotalMs ?? LLM_TOTAL_TIMEOUT_MS;
  const idleCap = overrideTotalMs != null ? Math.min(LLM_IDLE_TIMEOUT_MS, overrideTotalMs) : LLM_IDLE_TIMEOUT_MS;
  const streamTotalCap = overrideTotalMs != null ? Math.min(LLM_STREAM_TOTAL_TIMEOUT_MS, overrideTotalMs) : LLM_STREAM_TOTAL_TIMEOUT_MS;
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout>;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    const clearAll = () => { clearTimeout(idleTimer); if (totalTimer) clearTimeout(totalTimer); };
    const fail = (ms: number, kind: "idle" | "total") => {
      if (settled) return;
      settled = true;
      clearAll();
      reject(new LLMTimeoutError(ms, kind));
    };
    // idle:每次「流活动」复位(见 wrappedDelta);非流式则等同总超时。
    const armIdle = () => {
      clearTimeout(idleTimer);
      const ms = streaming ? idleCap : nonStreamTotal;
      idleTimer = setTimeout(() => fail(ms, streaming ? "idle" : "total"), ms);
    };
    // 流式:总时长硬上限,永不复位——兜住「一直有活动但永不收尾」。
    if (streaming) {
      totalTimer = setTimeout(() => fail(streamTotalCap, "total"), streamTotalCap);
    }
    // 任何流活动(正文/思考/工具/keepalive)都经此复位 idle。
    // 空串 = 纯心跳:只复位计时器,不转发给 UI delta 流(否则思考/keepalive 会把 '' 漏进正文流)。
    const wrappedDelta = originalDelta
      ? (text: string) => { armIdle(); if (text) originalDelta(text); }
      : undefined;
    armIdle();
    start(wrappedDelta).then(
      (value) => { if (!settled) { settled = true; clearAll(); resolve(value); } },
      (error) => { if (!settled) { settled = true; clearAll(); reject(error); } },
    );
  });
}

async function withTransientLLMRetry<T>(
  run: () => Promise<T>,
  options?: {
    readonly enabled?: boolean;
    readonly retryTimeoutsWhenDisabled?: boolean;
    readonly retryPartial?: boolean;
    readonly onRetry?: (attempt: number, error: unknown) => void;
  },
): Promise<T> {
  const enabled = options?.enabled ?? true;
  // 流式默认关重试(避免重复 UI 文本);但「调用超时」是无可用产出的挂起,重试既不会重复
  // 正文、又能扛上游瞬时挂起。所以即便 enabled=false,也单独放行 timeout 重试(由本开关控制)。
  const retryTimeoutsWhenDisabled = options?.retryTimeoutsWhenDisabled ?? false;
  // 结构化调用(requireComplete)放行「流中断」重试:整段重跑,而非把半截内容当成功。
  const retryPartial = options?.retryPartial ?? false;
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_LLM_RETRIES; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      const isTimeout = error instanceof LLMTimeoutError;
      const retryable = error instanceof PartialResponseError
        ? retryPartial
        : (enabled && isTransientLLMTransportError(error))
          || (retryTimeoutsWhenDisabled && isTimeout);
      if (attempt >= TRANSIENT_LLM_RETRIES || !retryable) {
        throw error;
      }
      // 重试可见化:挂起/抖动不再"静默吞掉"。console 留后台排查;onRetry 让上层(agent)
      // 经 SSE logger 把"正在重试"透出到前台运行日志/错误中心,用户实时可见。
      console.warn(
        `[juanshe] LLM 调用${isTimeout ? "超时挂起" : "瞬时传输错误"},自动重试 ${attempt + 1}/${TRANSIENT_LLM_RETRIES}:${String(error).slice(0, 140)}`,
      );
      try {
        options?.onRetry?.(attempt + 1, error);
      } catch {
        // onRetry 仅用于上报,异常绝不影响重试主流程。
      }
    }
  }
  throw lastError;
}

function shouldUseNativeCustomTransport(client: LLMClient): boolean {
  const service = client.service ?? "";
  if (service === "custom" || service.startsWith("custom:")) {
    if (
      client.configSource === "studio"
      && (client.provider === "openai" || client.provider === "anthropic")
    ) {
      return true;
    }
    return client.provider === "openai" && shouldUseNativeLocalOpenAICompatibleTransport(client);
  }
  return client.service === "ollama"
    && client.provider === "openai"
    && shouldUseNativeLocalOpenAICompatibleTransport(client);
}

function shouldUseNativeLocalOpenAICompatibleTransport(client: LLMClient): boolean {
  return !client._apiKey
    && isApiKeyOptionalForEndpoint({
      provider: client.provider,
      baseUrl: client._piModel?.baseUrl,
    });
}

function buildCustomHeaders(client: LLMClient): Record<string, string> {
  return {
    Authorization: `Bearer ${client._apiKey ?? ""}`,
    "Content-Type": "application/json",
    ...(client._piModel?.headers ?? {}),
  };
}

function joinSystemPrompt(messages: ReadonlyArray<LLMMessage>): string | undefined {
  const systemParts = messages
    .filter((message) => message.role === "system" && flattenMessageContent(message.content).trim().length > 0)
    .map((message) => flattenMessageContent(message.content).trim());
  return systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
}

/**
 * Anthropic-format system:string OR blocks[] for cache_control support.
 * 如果任一 system block 标了 cache,返回 blocks 数组;否则返回简单字符串。
 */
function buildAnthropicSystem(messages: ReadonlyArray<LLMMessage>):
  | string
  | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>
  | undefined
{
  const sysMessages = messages.filter((m) => m.role === "system");
  if (sysMessages.length === 0) return undefined;
  // 没有 cache 标记 → 走旧的字符串路径
  const anyCache = sysMessages.some((m) =>
    typeof m.content !== "string" && m.content.some((b) => b.cache === true),
  );
  if (!anyCache) {
    const joined = sysMessages
      .map((m) => flattenMessageContent(m.content).trim())
      .filter((t) => t.length > 0)
      .join("\n\n");
    return joined.length > 0 ? joined : undefined;
  }
  // 有 cache → 拆 blocks
  const out: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [];
  for (const m of sysMessages) {
    const blocks = toContentBlocks(m.content);
    for (const b of blocks) {
      if (b.text.length === 0) continue;
      out.push({
        type: "text",
        text: b.text,
        ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

function buildChatMessages(messages: ReadonlyArray<LLMMessage>): Array<{ role: string; content: string }> {
  // OpenAI 等 chat completion 不支持显式 cache_control(它自动做 prefix caching)。
  // 把所有 blocks flatten 成字符串,cache 标记被静默忽略。
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: flattenMessageContent(message.content),
    }));
}

/**
 * Anthropic-format messages — 如果消息里有 cache 标记,返回 blocks 数组形式;
 * 否则维持原来的简单字符串形式(对存量调用 0 行为变化)。
 */
function buildAnthropicMessages(messages: ReadonlyArray<LLMMessage>):
  | Array<{ role: "user" | "assistant"; content: string }>
  | Array<{ role: "user" | "assistant"; content: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> }>
{
  const userAsst = messages
    .filter((m): m is Readonly<LLMMessage> & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant");
  const useBlocks = messagesHaveCacheMarkers(userAsst);
  if (!useBlocks) {
    return userAsst.map((m) => ({ role: m.role, content: flattenMessageContent(m.content) }));
  }
  return userAsst.map((m) => {
    const blocks = toContentBlocks(m.content);
    const out: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [];
    for (const b of blocks) {
      if (b.text.length === 0) continue;
      out.push({
        type: "text",
        text: b.text,
        ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
      });
    }
    return { role: m.role, content: out };
  });
}

function buildResponsesInput(messages: ReadonlyArray<LLMMessage>): Array<{ role: string; content: Array<{ type: "input_text"; text: string }> }> {
  // OpenAI Responses API:类似 chat,flatten + 忽略 cache marker
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: [{ type: "input_text", text: flattenMessageContent(message.content) }],
    }));
}

function hasSystemMessages(messages: ReadonlyArray<LLMMessage>): boolean {
  return messages.some((message) =>
    message.role === "system" && flattenMessageContent(message.content).trim().length > 0,
  );
}

function foldSystemMessagesIntoFirstUser(messages: ReadonlyArray<LLMMessage>): LLMMessage[] {
  const system = joinSystemPrompt(messages);
  const nonSystemMessages = messages.filter((message) => message.role !== "system");
  if (!system) return [...nonSystemMessages];

  const firstUserIndex = nonSystemMessages.findIndex((message) => message.role === "user");
  const prefix = `System instructions:\n${system}\n\nUser request:\n`;
  if (firstUserIndex < 0) {
    return [{ role: "user", content: `System instructions:\n${system}` }, ...nonSystemMessages];
  }

  // 注意:fold 时把 user 内容 flatten 成字符串(因为我们已经丢掉 system,
  // 也就丢掉了在 system 上做 cache breakpoint 的可能,所以 user 也没必要再保留 blocks)
  return nonSystemMessages.map((message, index) => index === firstUserIndex
    ? { ...message, content: `${prefix}${flattenMessageContent(message.content)}` }
    : message);
}

function isSystemRoleUnsupportedErrorText(text: string): boolean {
  const normalized = text.toLowerCase();
  const mentionsSystemRole = normalized.includes("system") && normalized.includes("role");
  if (!mentionsSystemRole) return false;
  return normalized.includes("unsupported")
    || normalized.includes("not support")
    || normalized.includes("does not support")
    || normalized.includes("invalid")
    || normalized.includes("不支持")
    || normalized.includes("不允许");
}

async function readErrorResponse(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; detail?: string };
    if (typeof json.error === "string" && json.error) return `${res.status} ${json.error}`;
    if (json.error && typeof json.error === "object" && typeof json.error.message === "string") {
      return `${res.status} ${json.error.message}`;
    }
    if (typeof json.detail === "string" && json.detail) return `${res.status} ${json.detail}`;
  } catch {
    // fall through
  }
  return `${res.status} ${text || res.statusText}`.trim();
}

type ParsedSseEvent = {
  readonly event?: string;
  readonly data?: string;
};

function parseSseEvents(buffer: string): { readonly events: ParsedSseEvent[]; readonly rest: string } {
  const chunks = buffer.split(/\n\n/);
  const rest = chunks.pop() ?? "";
  const events: ParsedSseEvent[] = [];

  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (eventName || dataLines.length > 0) {
      events.push({
        ...(eventName ? { event: eventName } : {}),
        ...(dataLines.length > 0 ? { data: dataLines.join("\n") } : {}),
      });
    }
  }

  return { events, rest };
}

function extractOpenAITextPart(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => typeof item?.text === "string" ? item.text : typeof item?.content === "string" ? item.content : "")
      .join("");
  }
  return "";
}

function extractChatContent(json: any): string {
  const message = json?.choices?.[0]?.message;
  return extractOpenAITextPart(message?.content) || extractOpenAITextPart(message?.reasoning_content);
}

function extractChatDeltaContent(json: any): string {
  return extractOpenAITextPart(json?.choices?.[0]?.delta?.content);
}

function extractChatDeltaReasoningContent(json: any): string {
  return extractOpenAITextPart(json?.choices?.[0]?.delta?.reasoning_content);
}

function extractResponsesContent(json: any): string {
  const output = Array.isArray(json?.output) ? json.output : [];
  return output
    .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
    .map((part: any) => {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      if (typeof part?.output_text === "string") return part.output_text;
      return "";
    })
    .join("");
}

function extractAnthropicContent(json: any): string {
  const content = Array.isArray(json?.content) ? json.content : [];
  return content
    .map((part: any) => typeof part?.text === "string" ? part.text : "")
    .join("");
}

function anthropicMessagesUrl(baseUrl: string): string {
  const normalized = normalizeServiceBaseUrl(baseUrl);
  return `${normalized}/messages`;
}

function openAIChatCompletionsUrl(baseUrl: string): string {
  return `${normalizeServiceBaseUrl(baseUrl)}/chat/completions`;
}

async function chatCompletionViaCustomAnthropicCompatible(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  resolved: { readonly temperature: number; readonly maxTokens: number; readonly extra: Record<string, unknown> },
  onStreamProgress?: OnStreamProgress,
  onTextDelta?: (text: string) => void,
): Promise<LLMResponse> {
  const baseUrl = client._piModel?.baseUrl ?? "";
  const errorCtx = { baseUrl, model };
  const extra = stripReservedKeys(resolved.extra);
  const payload: Record<string, unknown> = {
    model,
    messages: buildAnthropicMessages(messages),
    stream: client.stream,
    max_tokens: resolved.maxTokens,
    temperature: resolved.temperature,
    ...extra,
  };
  // System 走带 cache_control 的 blocks 数组;无 cache 标记时仍是字符串(向后兼容)
  const system = buildAnthropicSystem(messages);
  if (system) payload.system = system;
  // Anthropic prompt caching 默认开,看本次消息有没有 cache_control 来决定是否带 beta header
  const usesCaching = messagesHaveCacheMarkers(messages)
    || (Array.isArray(system) && system.some((b) => b.cache_control));

  const response = await fetchWithProxy(anthropicMessagesUrl(baseUrl), {
    method: "POST",
    headers: {
      "User-Agent": JUANSHE_USER_AGENT,
      "x-api-key": client._apiKey ?? "",
      "anthropic-version": "2023-06-01",
      ...(usesCaching ? { "anthropic-beta": "prompt-caching-2024-07-31" } : {}),
      "Content-Type": "application/json",
      Authorization: `Bearer ${client._apiKey ?? ""}`,
      ...(client._piModel?.headers ?? {}),
    },
    body: JSON.stringify(payload),
  }, client.proxyUrl);

  if (!response.ok) {
    throw wrapLLMError(new Error(await readErrorResponse(response)), errorCtx);
  }

  if (!client.stream) {
    const json = await response.json() as any;
    const content = extractAnthropicContent(json);
    if (!content) {
      throw wrapLLMError(new Error("LLM returned empty response"), errorCtx);
    }
    return {
      content,
      usage: {
        promptTokens: json?.usage?.input_tokens ?? 0,
        completionTokens: json?.usage?.output_tokens ?? 0,
        totalTokens: (json?.usage?.input_tokens ?? 0) + (json?.usage?.output_tokens ?? 0),
      },
    };
  }

  const reader = response.body?.getReader();
  if (!reader) throw wrapLLMError(new Error("Streaming body unavailable"), errorCtx);
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const monitor = createStreamMonitor(onStreamProgress);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onTextDelta?.(""); // 收到任意字节=流还活着→复位空闲超时(覆盖思考/keepalive/任意活动,不止正文)
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseEvents(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (!event.data) continue;
        const json = JSON.parse(event.data);
        if (json.type === "message_start" && json.message?.usage) {
          usage.promptTokens = json.message.usage.input_tokens ?? usage.promptTokens;
        }
        if (json.type === "content_block_delta" && json.delta?.type === "text_delta" && typeof json.delta.text === "string") {
          content += json.delta.text;
          monitor.onChunk(json.delta.text);
          onTextDelta?.(json.delta.text);
        }
        if (json.type === "message_delta" && json.usage) {
          usage.completionTokens = json.usage.output_tokens ?? usage.completionTokens;
        }
        if (json.type === "message_stop") {
          usage.totalTokens = usage.promptTokens + usage.completionTokens;
        }
      }
    }
  } finally {
    monitor.stop();
  }

  if (!content) {
    throw wrapLLMError(new Error("LLM returned empty response from stream"), errorCtx);
  }
  if (!usage.totalTokens) {
    usage.totalTokens = usage.promptTokens + usage.completionTokens;
  }
  return { content, usage };
}

async function chatCompletionViaCustomOpenAICompatible(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  resolved: { readonly temperature: number; readonly maxTokens: number; readonly extra: Record<string, unknown> },
  onStreamProgress?: OnStreamProgress,
  onTextDelta?: (text: string) => void,
  allowSystemRoleFallback = true,
): Promise<LLMResponse> {
  if (client.provider === "anthropic") {
    return chatCompletionViaCustomAnthropicCompatible(client, model, messages, resolved, onStreamProgress, onTextDelta);
  }
  const baseUrl = client._piModel?.baseUrl ?? "";
  const headers = buildCustomHeaders(client);
  const errorCtx = { baseUrl, model };
  const extra = stripReservedKeys(resolved.extra);

  if (client.apiFormat === "responses") {
    const payload: Record<string, unknown> = {
      model,
      input: buildResponsesInput(messages),
      stream: client.stream,
      store: false,
      max_output_tokens: resolved.maxTokens,
      temperature: resolved.temperature,
      ...extra,
    };
    const instructions = joinSystemPrompt(messages);
    if (instructions) payload.instructions = instructions;

    const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }, client.proxyUrl);
    if (!response.ok) {
      throw wrapLLMError(new Error(await readErrorResponse(response)), errorCtx);
    }

    if (!client.stream) {
      const json = await response.json() as any;
      const content = extractResponsesContent(json);
      if (!content) {
        throw wrapLLMError(new Error("LLM returned empty response"), errorCtx);
      }
      return {
        content,
        usage: {
          promptTokens: json?.usage?.input_tokens ?? 0,
          completionTokens: json?.usage?.output_tokens ?? 0,
          totalTokens: json?.usage?.total_tokens ?? 0,
        },
      };
    }

    const reader = response.body?.getReader();
    if (!reader) throw wrapLLMError(new Error("Streaming body unavailable"), errorCtx);
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const monitor = createStreamMonitor(onStreamProgress);

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        onTextDelta?.(""); // 收到任意字节=流还活着→复位空闲超时(覆盖思考/keepalive/任意活动,不止正文)
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseEvents(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) {
          if (!event.data) continue;
          const json = JSON.parse(event.data);
          if (json.type === "response.output_text.delta" && typeof json.delta === "string") {
            content += json.delta;
            monitor.onChunk(json.delta);
            onTextDelta?.(json.delta);
          }
          if (json.type === "response.completed") {
            usage = {
              promptTokens: json.response?.usage?.input_tokens ?? 0,
              completionTokens: json.response?.usage?.output_tokens ?? 0,
              totalTokens: json.response?.usage?.total_tokens ?? 0,
            };
            if (!content) {
              content = extractResponsesContent(json.response);
            }
          }
        }
      }
    } finally {
      monitor.stop();
    }

    if (!content) {
      throw wrapLLMError(new Error("LLM returned empty response from stream"), errorCtx);
    }
    return { content, usage };
  }

  const payload: Record<string, unknown> = {
    model,
    messages: [
      ...messages
        .filter((message) => message.role === "system")
        .map((message) => ({ role: "system", content: flattenMessageContent(message.content) })),
      ...buildChatMessages(messages),
    ],
    stream: client.stream,
    temperature: resolved.temperature,
    max_tokens: resolved.maxTokens,
    ...extra,
  };
  if (client.stream) {
    payload.stream_options = { include_usage: true };
  }

  const response = await fetchWithProxy(openAIChatCompletionsUrl(baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }, client.proxyUrl);
  if (!response.ok) {
    const detail = await readErrorResponse(response);
    if (allowSystemRoleFallback && hasSystemMessages(messages) && isSystemRoleUnsupportedErrorText(detail)) {
      return chatCompletionViaCustomOpenAICompatible(
        client,
        model,
        foldSystemMessagesIntoFirstUser(messages),
        resolved,
        onStreamProgress,
        onTextDelta,
        false,
      );
    }
    throw wrapLLMError(new Error(detail), errorCtx);
  }

  if (!client.stream) {
    const json = await response.json() as any;
    const content = extractChatContent(json);
    if (!content) {
      throw wrapLLMError(new Error("LLM returned empty response"), errorCtx);
    }
    return {
      content,
      usage: {
        promptTokens: json?.usage?.prompt_tokens ?? 0,
        completionTokens: json?.usage?.completion_tokens ?? 0,
        totalTokens: json?.usage?.total_tokens ?? 0,
      },
    };
  }

  const reader = response.body?.getReader();
  if (!reader) throw wrapLLMError(new Error("Streaming body unavailable"), errorCtx);
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const monitor = createStreamMonitor(onStreamProgress);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onTextDelta?.(""); // 收到任意字节=流还活着→复位空闲超时(覆盖思考/keepalive/任意活动,不止正文)
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseEvents(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (!event.data || event.data === "[DONE]") continue;
        const json = JSON.parse(event.data);
        const delta = extractChatDeltaContent(json);
        if (delta) {
          content += delta;
          monitor.onChunk(delta);
          onTextDelta?.(delta);
        } else {
          const reasoningDelta = extractChatDeltaReasoningContent(json);
          if (reasoningDelta) {
            reasoningContent += reasoningDelta;
            monitor.onChunk(reasoningDelta); // idle 已在读取层复位(任意字节);此处仅累计思考进度
          }
        }
        if (json?.usage) {
          usage = {
            promptTokens: json.usage.prompt_tokens ?? usage.promptTokens,
            completionTokens: json.usage.completion_tokens ?? usage.completionTokens,
            totalTokens: json.usage.total_tokens ?? usage.totalTokens,
          };
        }
      }
    }
  } finally {
    monitor.stop();
  }

  const finalContent = content || reasoningContent;
  if (!finalContent) {
    throw wrapLLMError(new Error("LLM returned empty response from stream"), errorCtx);
  }
  return { content: finalContent, usage };
}

// === Embeddings (OpenAI-compatible /embeddings; used by 语义检索) ===

/**
 * 取一批文本的向量(OpenAI 兼容 /embeddings)。语义检索用——把"词面命中候选池"按语义重排。
 * 复用同一 client 的 baseUrl/key/proxy;`embeddingModel` 指定 embedding 模型 id。
 * 失败抛错(调用方在 memory-retrieval 里 try/catch 后退化成纯词面检索,不影响写作)。
 * 注意:并非所有服务都提供 /embeddings(如小米 MiMo 当前不提供)——未配置 embedding 模型时根本不会调用本函数。
 */
export async function embedTexts(
  client: LLMClient,
  texts: ReadonlyArray<string>,
  embeddingModel: string,
  baseUrlOverride?: string,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  // baseUrlOverride 让嵌入走独立服务(如本地 Ollama bge-m3),不必和 chat 同 baseUrl。
  const baseUrl = normalizeServiceBaseUrl(baseUrlOverride ?? client._piModel?.baseUrl ?? "");
  if (!baseUrl) throw new Error("embedTexts: 缺少 baseUrl");
  const headers = buildCustomHeaders(client);
  const errorCtx = { baseUrl, model: embeddingModel };
  // 加超时:嵌入服务(本地 Ollama 等)卡住时绝不能拖死每章 compose——超时即 abort 抛错,上层 rerank 优雅退回纯词面。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let response: Awaited<ReturnType<typeof fetchWithProxy>>;
  try {
    response = await fetchWithProxy(
      `${baseUrl}/embeddings`,
      { method: "POST", headers, body: JSON.stringify({ model: embeddingModel, input: [...texts] }), signal: controller.signal },
      client.proxyUrl,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw wrapLLMError(new Error(await readErrorResponse(response)), errorCtx);
  }
  const json = await response.json().catch(() => null) as { data?: Array<{ embedding?: number[]; index?: number }> } | null;
  const rows = Array.isArray(json?.data) ? json!.data : [];
  // 按 index 回排(部分服务乱序返回),缺失的填空向量(语义分记 0,安全退化)。
  const out: number[][] = texts.map(() => []);
  rows.forEach((row, i) => {
    const idx = Number.isInteger(row?.index) ? (row!.index as number) : i;
    if (idx >= 0 && idx < out.length && Array.isArray(row?.embedding)) out[idx] = row!.embedding as number[];
  });
  return out;
}

// === Simple Chat (used by all agents via BaseAgent.chat()) ===

export async function chatCompletion(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  options?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly webSearch?: boolean;
    readonly onStreamProgress?: OnStreamProgress;
    readonly onTextDelta?: (text: string) => void;
    /** 每次自动重试前回调(attempt 从 1 起);用于把"模型挂起/抖动正在重试"透出到前台日志,而不只是后台 stdout。 */
    readonly onRetry?: (attempt: number, error: unknown) => void;
    /**
     * 结构化输出(如架构师基础设定、JSON 大纲)必须拿到**完整**响应。
     * 默认 false:流中断时把已收到的半截内容当可用结果返回(适合正文——截断的章节仍可用)。
     * 设为 true:流中断改为「整段重试」(最多 TRANSIENT_LLM_RETRIES 次重跑完整流),
     * 最终仍不完整则抛错,交给调用方的重试循环重生成。半截结构化内容是垃圾,绝不静默返回。
     */
    readonly requireComplete?: boolean;
    /**
     * 硬性总超时(ms)。仅用于"连通性探测/快速 ping"这类必须秒级出结论的场景:
     * 不传则继承默认 240s(非流式)/ 20min(流式)的正文生成预算。传了就把空闲/总超时都压到它以下。
     */
    readonly timeoutMs?: number;
  },
): Promise<LLMResponse> {
  // C1 (v2.0.0)：删除 maxTokensCap 机制。per-call 显式传的 maxTokens 永远不被裁剪。
  const resolved = {
    temperature: clampTemperatureForModel(
      client.service,
      model,
      options?.temperature ?? client.defaults.temperature,
    ),
    maxTokens: options?.maxTokens ?? client.defaults.maxTokens,
    extra: client.defaults.extra,
  };
  const onStreamProgress = options?.onStreamProgress;
  const onTextDelta = options?.onTextDelta;
  const requireComplete = options?.requireComplete ?? false;
  const errorCtx = {
    baseUrl: client._piModel?.baseUrl ?? "(unknown)",
    model,
    maxTokens: resolved.maxTokens,
    temperature: resolved.temperature,
  };

  try {
    return await withTransientLLMRetry(
      async () => withCallTimeout(
        (delta) => {
          if (shouldUseNativeCustomTransport(client)) {
            return chatCompletionViaCustomOpenAICompatible(client, model, messages, resolved, onStreamProgress, delta);
          }
          return chatCompletionViaPiAi(client, model, messages, resolved, onStreamProgress, delta);
        },
        onTextDelta,
        options?.timeoutMs,
      ),
      // Retrying after UI text deltas have been emitted can duplicate visible text.
      // 流式仍关掉常规重试(防 UI 重复),但放行「超时」重试——抗 MiMo Pro 等端点的瞬时挂起。
      // requireComplete 的结构化调用额外放行「流中断」重试:整段重跑,而不是吞下半截内容。
      { enabled: !onTextDelta, retryTimeoutsWhenDisabled: true, retryPartial: requireComplete, onRetry: options?.onRetry },
    );
  } catch (error) {
    // Stream interrupted with usable partial content. 对正文调用,截断的内容仍可用,直接返回;
    // 对结构化调用(requireComplete),半截内容是垃圾——重试已耗尽后抛错,交给上层重生成。
    if (error instanceof PartialResponseError && !requireComplete) {
      return {
        content: error.partialContent,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }
    throw wrapLLMError(error, errorCtx);
  }
}

// === Tool-calling Chat (used by agent loop) ===

export async function chatWithTools(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<AgentMessage>,
  tools: ReadonlyArray<ToolDefinition>,
  options?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
  },
): Promise<ChatWithToolsResult> {
  try {
    const resolved = {
      temperature: clampTemperatureForModel(
        client.service,
        model,
        options?.temperature ?? client.defaults.temperature,
      ),
      maxTokens: options?.maxTokens ?? client.defaults.maxTokens,
    };
    return await chatWithToolsViaPiAi(client, model, messages, tools, resolved);
  } catch (error) {
    throw wrapLLMError(error);
  }
}

// === pi-ai Unified Implementation ===

/**
 * Build a pi-ai Model<Api> for a specific per-call model name.
 * The base template comes from client._piModel (created in createLLMClient);
 * we override .id / .name when the caller passes a different model string
 * (e.g. agent overrides).
 */
function resolvePiModel(client: LLMClient, model: string): PiModel<PiApi> {
  const base = client._piModel!;
  if (base.id === model) return base;
  return { ...base, id: model, name: model };
}

/** Convert Juanshe LLMMessage[] to pi-ai Context. */
function toPiContext(messages: ReadonlyArray<LLMMessage>): PiContext {
  // pi-ai 不支持 cache_control,把 blocks 全 flatten 成字符串
  const systemParts = messages.filter((m) => m.role === "system").map((m) => flattenMessageContent(m.content));
  const systemPrompt = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
  const piMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const flat = flattenMessageContent(m.content);
      if (m.role === "user") {
        return { role: "user" as const, content: flat, timestamp: Date.now() };
      }
      // assistant
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: flat }],
        api: "openai-completions" as PiApi,
        provider: "openai",
        model: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
    });
  return { systemPrompt, messages: piMessages };
}

/** Convert Juanshe AgentMessage[] to pi-ai Context (with tool calls/results). */
function agentMessagesToPiContext(messages: ReadonlyArray<AgentMessage>): PiContext {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => (m as { content: string }).content);
  const systemPrompt = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
  const piMessages: PiContext["messages"] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      piMessages.push({ role: "user", content: msg.content, timestamp: Date.now() });
      continue;
    }
    if (msg.role === "assistant") {
      const content: (PiTextContent | PiToolCall)[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          content.push({
            type: "toolCall",
            id: tc.id,
            name: tc.name,
            arguments: JSON.parse(tc.arguments),
          });
        }
      }
      if (content.length === 0) content.push({ type: "text", text: "" });
      piMessages.push({
        role: "assistant",
        content,
        api: "openai-completions" as PiApi,
        provider: "openai",
        model: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      continue;
    }
    if (msg.role === "tool") {
      piMessages.push({
        role: "toolResult",
        toolCallId: msg.toolCallId,
        toolName: "",
        content: [{ type: "text", text: msg.content }],
        isError: false,
        timestamp: Date.now(),
      });
    }
  }
  return { systemPrompt, messages: piMessages };
}

/** Convert Juanshe ToolDefinition[] to pi-ai Tool[]. */
function toPiTools(tools: ReadonlyArray<ToolDefinition>): PiTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as PiTool["parameters"],
  }));
}

async function chatCompletionViaPiAi(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  resolved: { readonly temperature: number; readonly maxTokens: number; readonly extra: Record<string, unknown> },
  onStreamProgress?: OnStreamProgress,
  onTextDelta?: (text: string) => void,
): Promise<LLMResponse> {
  const piModel = resolvePiModel(client, model);
  const context = toPiContext(messages);
  const streamOpts = {
    temperature: resolved.temperature,
    maxTokens: resolved.maxTokens,
    apiKey: client._apiKey,
    headers: mergeUserAgent(piModel.headers),
  };

  if (!client.stream) {
    const response = await piCompleteSimple(piModel, context, streamOpts);
    if (response.stopReason === "error" && response.errorMessage) {
      throw new Error(response.errorMessage);
    }
    const content = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (!content) {
      const diag = `usage=${response.usage.input}+${response.usage.output}`;
      console.warn(`[juanshe] LLM 非流式响应无文本内容 (${diag})`);
      throw new Error(`LLM returned empty response (${diag})`);
    }
    return {
      content,
      usage: {
        promptTokens: response.usage.input,
        completionTokens: response.usage.output,
        totalTokens: response.usage.totalTokens,
      },
    };
  }

  const eventStream = piStreamSimple(piModel, context, streamOpts);
  const chunks: string[] = [];
  const monitor = createStreamMonitor(onStreamProgress);
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    for await (const event of eventStream) {
      // 任何事件都说明「流还活着」→ 复位空闲超时。覆盖 thinking_delta(推理模型 MiMo/o1/kimi-thinking
      // 先思考后吐字)、toolcall_delta(工具调用)、*_start/*_end 等所有非正文活动,不止某一种模型。
      // 空串只复位计时器,不计入正文、不喷给 UI(思考/工具过程不入稿)。
      // 否则:这些阶段 >180s 无 text_delta 会被误判"模型空闲挂起"、超时重试又重复挂="跑很久不出内容"。
      onTextDelta?.("");
      if (event.type === "text_delta") {
        chunks.push(event.delta);
        monitor.onChunk(event.delta);
        onTextDelta?.(event.delta);
      }
      if (event.type === "done" || event.type === "error") {
        const msg = event.type === "done" ? event.message : event.error;
        inputTokens = msg.usage.input;
        outputTokens = msg.usage.output;
        if (event.type === "error" && msg.errorMessage) {
          const partial = chunks.join("");
          if (partial.length >= MIN_SALVAGEABLE_CHARS) {
            throw new PartialResponseError(partial, new Error(msg.errorMessage));
          }
          throw new Error(msg.errorMessage);
        }
      }
    }
  } catch (streamError) {
    monitor.stop();
    if (streamError instanceof PartialResponseError) throw streamError;
    const partial = chunks.join("");
    if (partial.length >= MIN_SALVAGEABLE_CHARS) {
      throw new PartialResponseError(partial, streamError);
    }
    throw streamError;
  } finally {
    monitor.stop();
  }

  const content = chunks.join("");
  if (!content) {
    const diag = `usage=${inputTokens}+${outputTokens}`;
    console.warn(`[juanshe] LLM 流式响应无文本内容 (${diag})`);
    throw new Error(`LLM returned empty response from stream (${diag})`);
  }

  return {
    content,
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}

async function chatWithToolsViaPiAi(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<AgentMessage>,
  tools: ReadonlyArray<ToolDefinition>,
  resolved: { readonly temperature: number; readonly maxTokens: number },
): Promise<ChatWithToolsResult> {
  const piModel = resolvePiModel(client, model);
  const context = agentMessagesToPiContext(messages);
  context.tools = toPiTools(tools);
  const streamOpts = {
    temperature: resolved.temperature,
    maxTokens: resolved.maxTokens,
    apiKey: client._apiKey,
    headers: mergeUserAgent(piModel.headers),
  };

  if (!client.stream) {
    const response = await piComplete(piModel, context, streamOpts);
    if (response.stopReason === "error" && response.errorMessage) {
      throw new Error(response.errorMessage);
    }
    const content = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    const toolCalls = response.content
      .filter((block): block is PiToolCall => block.type === "toolCall")
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.arguments),
      }));
    return { content, toolCalls };
  }

  const eventStream = piStream(piModel, context, streamOpts);
  let content = "";
  const toolCalls: ToolCall[] = [];

  for await (const event of eventStream) {
    if (event.type === "text_delta") {
      content += event.delta;
    }
    if (event.type === "toolcall_end") {
      toolCalls.push({
        id: event.toolCall.id,
        name: event.toolCall.name,
        arguments: JSON.stringify(event.toolCall.arguments),
      });
    }
    if (event.type === "error" && event.error.errorMessage) {
      throw new Error(event.error.errorMessage);
    }
  }

  return { content, toolCalls };
}
