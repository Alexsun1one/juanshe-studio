import type { LLMProvider } from "@/lib/api/types"
import { backendJSON, isRecord, readJsonBody } from "@/lib/api/facade"

const MIMO_MODELS = [
  "mimo-v2.5-pro",
  "mimo-v2.5",
  "mimo-v2-omni",
  "mimo-v2-pro",
]

export type ProviderTestResult = {
  ok: boolean
  latencyMs?: number
  error?: string
  modelCount?: number
  models?: string[]
  selectedModel?: string
}

export async function loadLLMProviders(req: Request): Promise<LLMProvider[]> {
  const [{ response: servicesResponse, data: servicesData }, { data: configData }] =
    await Promise.all([
      backendJSON("/api/v1/services", req),
      backendJSON("/api/v1/services/config", req),
    ])

  if (!servicesResponse.ok) {
    throw new Error(`services endpoint returned ${servicesResponse.status}`)
  }

  const services = records(servicesData, ["services", "items", "data"])
  const config = asRecord(configData)
  const configured = records(config, ["services"])
  const activeService = text(config.service)
  const defaultModel = text(config.defaultModel ?? config.model)
  const configuredIds = new Set(configured.map(configuredServiceId).filter(Boolean))

  const candidates = services.filter((service) => {
    const id = serviceIdOf(service)
    return (
      Boolean(id) &&
      (id === activeService || Boolean(service.connected) || configuredIds.has(id))
    )
  })

  if (!candidates.some((service) => serviceIdOf(service) === activeService)) {
    const configuredActive = configured.find(
      (service) => configuredServiceId(service) === activeService,
    )
    if (configuredActive && activeService) {
      candidates.unshift({
        ...configuredActive,
        service: activeService,
        label: text(configuredActive.name, activeService.replace(/^custom:/, "")),
        connected: true,
      })
    }
  }

  const providers = await Promise.all(
    candidates.map(async (service): Promise<LLMProvider> => {
      const id = serviceIdOf(service)
      const configuredService = configured.find(
        (item) => configuredServiceId(item) === id,
      )
      const selectedModel =
        id === activeService
          ? defaultModel || text(configuredService?.model)
          : text(configuredService?.model)
      const upstreamModels = await loadModelsForService(req, id)
      const models = unique([
        selectedModel,
        ...(isXiaomiMiMo(id) ? MIMO_MODELS : []),
        ...upstreamModels,
      ])

      return {
        id,
        name: text(service.label ?? service.name, id.replace(/^custom:/, "")),
        kind: providerKind(id),
        baseUrl: text(service.baseUrl ?? configuredService?.baseUrl),
        providerFamily: providerFamily(service.providerFamily ?? configuredService?.providerFamily),
        api: providerApi(service.api ?? configuredService?.api),
        hasKey: Boolean(service.connected ?? service.hasKey),
        enabled: id === activeService || Boolean(service.connected),
        selectedModel: selectedModel || models[0],
        lastTestedAt: numberOrUndefined(service.lastTestedAt ?? service.testedAt),
        lastTestOk: booleanOrUndefined(service.lastTestOk),
        models,
      }
    }),
  )

  return providers.filter((provider) => provider.id)
}

export async function loadLLMProvider(
  req: Request,
  id: string,
): Promise<LLMProvider | undefined> {
  const providers = await loadLLMProviders(req)
  return providers.find((provider) => provider.id === id)
}

export async function createLLMProvider(req: Request): Promise<LLMProvider> {
  const body = await readJsonBody(req)
  const { response, data } = await backendJSON("/api/v1/llm-providers", req, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  })
  if (response.ok) return asProvider(data)
  if (![404, 405, 501].includes(response.status)) {
    throw new Error(errorMessage(data, response.status))
  }

  return createViaServices(req, asRecord(body))
}

export async function updateLLMProvider(
  req: Request,
  id: string,
): Promise<LLMProvider> {
  const body = await readJsonBody(req)
  const { response, data } = await backendJSON(
    `/api/v1/llm-providers/${encodeURIComponent(id)}`,
    req,
    {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    },
  )

  if (response.ok) return asProvider(data)
  if (![404, 405, 501].includes(response.status)) {
    throw new Error(errorMessage(data, response.status))
  }

  await updateViaServices(req, id, asRecord(body))
  const provider = await loadLLMProvider(req, id)
  if (!provider) throw new Error(`provider not found: ${id}`)
  return provider
}

export async function deleteLLMProvider(
  req: Request,
  id: string,
): Promise<{ ok?: boolean; id?: string }> {
  const { response, data } = await backendJSON(
    `/api/v1/llm-providers/${encodeURIComponent(id)}`,
    req,
    { method: "DELETE" },
  )
  if (!response.ok) {
    throw new Error(errorMessage(data, response.status))
  }
  const record = asRecord(data)
  return { ok: record.ok === undefined ? true : Boolean(record.ok), id: text(record.id, id) }
}

// 测试探测会真的去打中转(拉 /models + 一次 chat ping),慢中转用默认网关超时(偏短)容易被掐。
// 给测试一条更宽松的墙钟(60s):平时就慢到 60s 都 ping 不通的中转,对写作也是不可用的。
const TEST_BACKEND_TIMEOUT_MS = 60_000

export async function testLLMProvider(
  req: Request,
  id: string,
): Promise<ProviderTestResult> {
  let body: unknown = {}
  try {
    body = await readJsonBody(req)
  } catch {
    body = {}
  }
  try {
    const direct = await backendJSON(
      `/api/v1/llm-providers/${encodeURIComponent(id)}/test`,
      req,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      },
      TEST_BACKEND_TIMEOUT_MS,
    )
    if (direct.response.ok) return asProviderTestResult(direct.data)

    const fallback = await backendJSON(
      `/api/v1/services/${encodeURIComponent(id)}/test`,
      req,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      },
      TEST_BACKEND_TIMEOUT_MS,
    )
    const result = asProviderTestResult(fallback.data)
    if (!fallback.response.ok && !result.error) {
      result.error = errorMessage(fallback.data, fallback.response.status)
    }
    return result
  } catch (e) {
    // 探测超时 / 连不通 / 响应不是 JSON 都会让 backendJSON 抛错。绝不能冒泡成 500 ——
    // 翻成可执行人话,jsonOK 包成 200,前端走 {ok:false} 清爽路径渲染。
    return { ok: false, error: describeTestException(e) }
  }
}

function describeTestException(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "")
  if (/timed out|timeout|abort/i.test(msg)) {
    return "测试超时 —— 这个服务商 / 中转地址响应太慢或连不通(已等 60 秒)。请确认 Base URL 可达、模型已上架;若它平时就慢,建议换一个更快的服务商。"
  }
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|getaddrinfo|network|socket|certificate|TLS|SSL/i.test(msg)) {
    return "连不上这个服务地址 —— 请检查 Base URL 是否写对(要带 http(s):// 和正确路径,如 /v1),以及该地址是否可公网访问、证书是否正常。"
  }
  return `测试时出错:${msg.slice(0, 200) || "未知错误"}。请检查 Base URL、模型名与协议类型后重试。`
}

async function updateViaServices(
  req: Request,
  id: string,
  patch: Record<string, unknown>,
) {
  if (typeof patch.apiKey === "string") {
    const secretResponse = await backendJSON(
      `/api/v1/services/${encodeURIComponent(id)}/secret`,
      req,
      {
        method: "PUT",
        headers: jsonHeaders(),
        body: JSON.stringify({ apiKey: patch.apiKey }),
      },
    )
    if (!secretResponse.response.ok) {
      throw new Error(errorMessage(secretResponse.data, secretResponse.response.status))
    }
  }

  const selectedModel = text(patch.selectedModel ?? patch.model)
  const serviceEntry = serviceConfigPatch(id, patch, selectedModel)
  const configPatch: Record<string, unknown> = {}
  if (serviceEntry) configPatch.services = [serviceEntry]
  if (patch.enabled !== false) configPatch.service = id
  if (selectedModel) configPatch.defaultModel = selectedModel
  if (Object.keys(configPatch).length) {
    configPatch.configSource = "studio"
    const configResponse = await backendJSON("/api/v1/services/config", req, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify(configPatch),
    })
    if (!configResponse.response.ok) {
      throw new Error(errorMessage(configResponse.data, configResponse.response.status))
    }
  }
}

async function createViaServices(req: Request, body: Record<string, unknown>) {
  const rawName = text(body.id ?? body.name).replace(/^custom:/, "")
  const name = rawName || "Custom"
  const id = text(body.id) || `custom:${name}`
  const selectedModel = text(body.selectedModel ?? body.model)
  const serviceEntry = serviceConfigPatch(
    id,
    { ...body, name, service: id },
    selectedModel,
  )
  if (!serviceEntry?.baseUrl) throw new Error("Base URL is required")

  if (typeof body.apiKey === "string" && body.apiKey.trim()) {
    const secretResponse = await backendJSON(
      `/api/v1/services/${encodeURIComponent(id)}/secret`,
      req,
      {
        method: "PUT",
        headers: jsonHeaders(),
        body: JSON.stringify({ apiKey: body.apiKey }),
      },
    )
    if (!secretResponse.response.ok) {
      throw new Error(errorMessage(secretResponse.data, secretResponse.response.status))
    }
  }

  const configPatch: Record<string, unknown> = {
    services: [serviceEntry],
    configSource: "studio",
  }
  if (body.enabled !== false) configPatch.service = id
  if (selectedModel) configPatch.defaultModel = selectedModel

  const configResponse = await backendJSON("/api/v1/services/config", req, {
    method: "PUT",
    headers: jsonHeaders(),
    body: JSON.stringify(configPatch),
  })
  if (!configResponse.response.ok) {
    throw new Error(errorMessage(configResponse.data, configResponse.response.status))
  }

  const provider = await loadLLMProvider(req, id)
  if (provider) return provider
  return {
    id,
    name,
    kind: "custom",
    baseUrl: text(body.baseUrl),
    providerFamily: providerFamily(body.providerFamily),
    api: providerApi(body.api),
    hasKey: Boolean(text(body.apiKey)),
    enabled: body.enabled !== false,
    selectedModel,
    models: selectedModel ? [selectedModel] : [],
  }
}

function serviceConfigPatch(
  id: string,
  patch: Record<string, unknown>,
  selectedModel: string,
) {
  const entry: Record<string, unknown> = id.startsWith("custom:")
    ? { service: "custom", name: id.replace(/^custom:/, "") }
    : { service: id }
  let changed = id.startsWith("custom:")

  if (typeof patch.baseUrl === "string") {
    entry.baseUrl = patch.baseUrl.trim()
    changed = true
  }
  if (selectedModel) {
    entry.model = selectedModel
    changed = true
  }
  if (providerFamily(patch.providerFamily)) {
    entry.providerFamily = providerFamily(patch.providerFamily)
    changed = true
  }
  if (providerApi(patch.api)) {
    entry.api = providerApi(patch.api)
    changed = true
  }
  if (patch.apiFormat === "chat" || patch.apiFormat === "responses") {
    entry.apiFormat = patch.apiFormat
    changed = true
  }
  if (typeof patch.stream === "boolean") {
    entry.stream = patch.stream
    changed = true
  }
  if (typeof patch.temperature === "number") {
    entry.temperature = patch.temperature
    changed = true
  }

  return changed ? entry : null
}

async function loadModelsForService(req: Request, id: string) {
  const { response, data } = await backendJSON(
    `/api/v1/services/${encodeURIComponent(id)}/models`,
    req,
  )
  if (!response.ok) return []
  return records(data, ["models", "items", "data"])
    .map((model) => text(model.id ?? model.name ?? model.model))
    .filter(Boolean)
}

function asProvider(value: unknown): LLMProvider {
  const record = asRecord(value)
  return {
    id: text(record.id),
    name: text(record.name),
    kind: text(record.kind, "custom"),
    baseUrl: text(record.baseUrl),
    providerFamily: providerFamily(record.providerFamily),
    api: providerApi(record.api),
    hasKey: Boolean(record.hasKey),
    enabled: Boolean(record.enabled),
    selectedModel: text(record.selectedModel),
    lastTestedAt: numberOrUndefined(record.lastTestedAt),
    lastTestOk: booleanOrUndefined(record.lastTestOk),
    models: Array.isArray(record.models) ? record.models.map((m) => String(m)) : [],
  }
}

// 后端失败有两种形:{ok:false,error:"串"} 与 {error:{code,message}}(ApiError / 鉴权)。
// 旧实现 text(record.error) 碰到对象形会渲染成 "[object Object]" —— 统一解包成可读串。
function errText(err: unknown): string {
  if (typeof err === "string") return err
  if (isRecord(err) && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message
  }
  return ""
}

function asProviderTestResult(value: unknown): ProviderTestResult {
  const record = asRecord(value)
  return {
    ok: Boolean(record.ok),
    latencyMs: numberOrUndefined(record.latencyMs),
    error: errText(record.error) || undefined,
    modelCount: numberOrUndefined(record.modelCount),
    models: Array.isArray(record.models)
      ? record.models.map((model) =>
          isRecord(model) ? text(model.id ?? model.name ?? model.model) : String(model),
        ).filter(Boolean)
      : undefined,
    selectedModel: text(record.selectedModel) || undefined,
  }
}

function records(value: unknown, keys: string[]) {
  if (Array.isArray(value)) return value.filter(isRecord)
  if (!isRecord(value)) return []
  for (const key of keys) {
    const nested = value[key]
    if (Array.isArray(nested)) return nested.filter(isRecord)
  }
  return []
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function serviceIdOf(service: Record<string, unknown>) {
  return text(service.service ?? service.id)
}

function configuredServiceId(service: Record<string, unknown>) {
  const id = text(service.service ?? service.id)
  if (id !== "custom") return id
  const name = text(service.name, "Custom")
  return `custom:${name}`
}

function text(value: unknown, fallback = "") {
  if (typeof value === "string") return value.trim() || fallback
  if (value == null) return fallback
  return String(value).trim() || fallback
}

function numberOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanOrUndefined(value: unknown) {
  return typeof value === "boolean" ? value : undefined
}

function providerFamily(value: unknown): LLMProvider["providerFamily"] | undefined {
  return value === "openai" || value === "anthropic" ? value : undefined
}

function providerApi(value: unknown): LLMProvider["api"] | undefined {
  return value === "openai-completions" || value === "openai-responses" || value === "anthropic-messages"
    ? value
    : undefined
}

function unique(values: Array<string | undefined>) {
  return values.filter((value, index, array): value is string =>
    Boolean(value) && array.indexOf(value) === index,
  )
}

function providerKind(id: string) {
  if (id.startsWith("custom:")) return "custom"
  if (id.includes("anthropic")) return "anthropic"
  if (id.includes("groq")) return "groq"
  if (id.includes("ollama")) return "custom"
  return "openai"
}

function isXiaomiMiMo(id: string) {
  return id.toLowerCase().includes("mimo") || id.includes("小米")
}

function jsonHeaders() {
  return { accept: "application/json", "content-type": "application/json" }
}

function errorMessage(data: unknown, status: number) {
  const record = asRecord(data)
  const error = record.error
  if (typeof error === "string") return error
  if (isRecord(error) && typeof error.message === "string") return error.message
  return `backend returned ${status}`
}
