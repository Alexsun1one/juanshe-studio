import { fetchWithProxy } from "../../utils/proxy-fetch.js";

/**
 * 通用 OpenAI 兼容 /models 探针。
 * 任何失败（网络错、超时、非 JSON、非 2xx）一律返回空数组，不抛异常。
 */

export interface ProbedModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
}

export async function probeModelsFromUpstream(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<ReadonlyArray<ProbedModel>> {
  if (!baseUrl) return [];
  try {
    const modelsUrl = baseUrl.replace(/\/$/, "") + "/models";
    // 带 Bearer + Anthropic 头:OpenAI 兼容端点忽略多余头,Anthropic 协议端点
    // (/models 只认 x-api-key + anthropic-version)也能拉到模型列表,而不是被 401 静默吞成空。
    const res = await fetchWithProxy(modelsUrl, {
      headers: apiKey
        ? { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id: unknown }> };
    if (!Array.isArray(json.data)) return [];
    return json.data
      .filter((m): m is { id: string } => typeof m.id === "string" && m.id.length > 0)
      .map((m) => ({ id: m.id, name: m.id, contextWindow: 0 }));
  } catch {
    return [];
  }
}
