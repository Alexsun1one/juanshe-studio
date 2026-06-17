import { getModel } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";
import {
  normalizeServiceApi,
  normalizeServiceBaseUrl,
  providerFamilyForServiceApi,
  resolveCustomServiceApi,
  resolveServicePiProvider,
  resolveServicePreset,
  type ServiceApi,
} from "./service-presets.js";
import { getServiceApiKey } from "./secrets.js";
import { getEndpoint } from "./providers/index.js";
import type { HardWriteEndpoint } from "./providers/types.js";
import { isApiKeyOptionalForEndpoint } from "../utils/llm-endpoint-auth.js";

export interface ResolvedModel {
  model: Model<Api>;
  apiKey: string;
  writingTemperature?: number;
  temperatureRange?: readonly [number, number];
  temperatureHint?: string;
}

type CustomServiceApiInput = "chat" | "responses" | ServiceApi;

function resolveProviderCompat(
  provider: HardWriteEndpoint | undefined,
  baseUrl: string,
): Record<string, unknown> | undefined {
  const compat = {
    ...(provider?.compat ?? {}),
    ...(baseUrl.includes("generativelanguage.googleapis.com") ? { supportsStore: false } : {}),
  };
  return Object.keys(compat).length > 0 ? compat : undefined;
}

export async function resolveServiceModel(
  service: string,
  modelId: string,
  projectRoot: string,
  customBaseUrl?: string,
  customApiFormat?: CustomServiceApiInput,
): Promise<ResolvedModel> {
  // Determine pi-ai provider
  const isCustomService = service === "custom" || service.startsWith("custom:");
  const baseService = isCustomService ? "custom" : service;
  const preset = resolveServicePreset(baseService);
  const endpoint = getEndpoint(baseService);
  const customApi = isCustomService
    ? resolveCustomServiceApi({
      api: normalizeServiceApi(customApiFormat),
      apiFormat: customApiFormat === "responses" ? "responses" : customApiFormat === "chat" ? "chat" : undefined,
    })
    : undefined;
  const apiType = isCustomService
    ? customApi
    : (preset?.api ?? "openai-completions");
  const piProvider = baseService === "ollama"
    ? "ollama"
    : isCustomService
      ? providerFamilyForServiceApi(apiType) ?? "openai"
      : resolveServicePiProvider(baseService) ?? "openai";
  const configuredBaseUrl = normalizeServiceBaseUrl(customBaseUrl ?? preset?.baseUrl ?? "");
  // 端点内置的模型元数据（真实上下文窗口 / 最大输出），用于补全 pi-ai registry 缺失的值
  const endpointModel = endpoint?.models.find(
    (model) => model.id === modelId || model.deploymentName === modelId,
  );

  // Get pi-ai Model — may return undefined for model IDs not in the built-in registry
  const piModel = getModel(piProvider as any, modelId as any) as Model<Api> | undefined;
  const effectiveBaseUrl = configuredBaseUrl || piModel?.baseUrl || "";
  const compat = apiType === "openai-completions"
    ? resolveProviderCompat(endpoint, effectiveBaseUrl)
    : undefined;

  if (!effectiveBaseUrl) {
    throw new Error(
      `Cannot resolve model "${modelId}" for service "${service}": no baseUrl available.`,
    );
  }

  // Resolve API key after baseUrl/provider are known so local/self-hosted endpoints
  // such as Ollama can be used without forcing a fake secret.
  const apiKey = await getServiceApiKey(projectRoot, service);
  if (!apiKey && !isApiKeyOptionalForEndpoint({
    provider: isCustomService ? providerFamilyForServiceApi(apiType) : preset?.providerFamily,
    baseUrl: effectiveBaseUrl,
  })) {
    throw new Error(
      `API key not found for service "${service}". Add it in .autow/secrets.json or set the environment variable.`,
    );
  }

  const model: Model<Api> = {
    id: modelId,
    name: piModel?.name ?? modelId,
    api: apiType as Api,
    provider: piProvider,
    baseUrl: effectiveBaseUrl,
    reasoning: piModel?.reasoning ?? false,
    input: piModel?.input ?? ["text"] as ("text" | "image")[],
    cost: piModel?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: endpointModel?.contextWindowTokens ?? piModel?.contextWindow ?? 0,
    maxTokens: endpointModel?.maxOutput ?? piModel?.maxTokens ?? 16384,
    ...(compat ? { compat: compat as Model<Api>["compat"] } : {}),
  };

  return {
    model,
    apiKey: apiKey ?? "",
    writingTemperature: preset?.writingTemperature,
    temperatureRange: preset?.temperatureRange,
    temperatureHint: preset?.temperatureHint,
  };
}
