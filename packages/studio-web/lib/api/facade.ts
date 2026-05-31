import { NextResponse } from "next/server"

// 规范后端为 studio :4569(纯 API,含全部 per-book 路由 cast/world/chapters/memory/…)。
// 旧默认 4567 是过期实例:有 /books 但 per-book 路由 404,导致角色/知识/记忆等页空白。
// 可经 JUANSHE_API_BASE 覆盖。
const DEFAULT_BACKEND_BASE = "http://localhost:4569"
// 单进程 tsx 后端在前端并发突发(首页一次约 8 个代理请求)下会串行排队,
// 6s 太短会误判超时 → 502 → 工作区被清空。放宽到 20s(可经 HARDWRITE_BACKEND_TIMEOUT_MS 覆盖)。
const DEFAULT_BACKEND_TIMEOUT_MS = 20_000

export type JsonRecord = Record<string, unknown>

type Transform = (data: unknown, response: Response) => unknown | Promise<unknown>

type ProxyOptions = {
  method?: string
  body?: unknown | ((request: Request) => unknown | Promise<unknown>)
  transform?: Transform
  /** 覆盖默认 6s 后端超时(长耗时端点如真生成必须放宽)。 */
  timeoutMs?: number
}

const MISSING_ENDPOINT_STATUSES = new Set([404, 405, 501])

export function backendBaseUrl() {
  return (
    process.env.JUANSHE_API_BASE ||
    process.env.NEXT_PUBLIC_JUANSHE_API_BASE ||
    process.env.HARDWRITE_API_BASE ||
    process.env.NEXT_PUBLIC_HARDWRITE_API_BASE ||
    DEFAULT_BACKEND_BASE
  ).replace(/\/+$/, "")
}

export function frontendFallbackEnabled() {
  if (process.env.NODE_ENV === "production") return false
  const explicit =
    process.env.AUTOW_STUDIO_WEB_ALLOW_MOCKS ??
    process.env.NEXT_PUBLIC_AUTOW_STUDIO_WEB_ALLOW_MOCKS ??
    process.env.JUANSHE_ALLOW_FRONTEND_FALLBACK ??
    process.env.NEXT_PUBLIC_JUANSHE_ALLOW_FRONTEND_FALLBACK ??
    process.env.HARDWRITE_ALLOW_FRONTEND_FALLBACK ??
    process.env.NEXT_PUBLIC_HARDWRITE_ALLOW_FRONTEND_FALLBACK

  // Mock surfaces must be opt-in. Default Studio Web should expose missing real
  // backend capability as an error instead of silently pretending it worked.
  return explicit == null ? false : truthyEnv(explicit)
}

export function backendUrl(path: string, request?: Request) {
  const base = backendBaseUrl()
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  const url = new URL(`${base}${normalizedPath}`)
  if (request) {
    const input = new URL(request.url)
    input.searchParams.forEach((value, key) => {
      if (!url.searchParams.has(key)) url.searchParams.append(key, value)
    })
  }
  return url
}

function backendTimeoutMs() {
  const raw = process.env.HARDWRITE_BACKEND_TIMEOUT_MS
  const parsed = raw ? Number(raw) : DEFAULT_BACKEND_TIMEOUT_MS
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1_000, Math.floor(parsed))
    : DEFAULT_BACKEND_TIMEOUT_MS
}

export async function readJsonBody(request: Request) {
  const text = await request.text().catch(() => "")
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export async function backendJSON(
  path: string,
  request?: Request,
  init: RequestInit = {},
  timeoutMs?: number,
) {
  const url = backendUrl(path, request)
  const headers = new Headers(init.headers)
  if (!headers.has("accept")) headers.set("accept", "application/json")
  // 透传浏览器 Cookie → 后端(SaaS 会话鉴权 hardwrite_saas_session 需要;否则登录态穿不过 Next 代理)
  const cookie = request?.headers.get("cookie")
  if (cookie && !headers.has("cookie")) headers.set("cookie", cookie)
  const controller = new AbortController()
  const ms = timeoutMs && timeoutMs > 0 ? timeoutMs : backendTimeoutMs()
  const timeout = setTimeout(() => {
    controller.abort(`Backend request timed out after ${ms}ms`)
  }, ms)
  init.signal?.addEventListener(
    "abort",
    () => controller.abort(init.signal?.reason),
    { once: true },
  )

  try {
    const response = await fetch(url, {
      ...init,
      headers,
      cache: "no-store",
      signal: controller.signal,
    })
    const text = await response.text()
    const data = text ? parseJSON(text) : null
    return { response, data }
  } finally {
    clearTimeout(timeout)
  }
}

export async function proxyJSON(
  request: Request,
  path: string,
  options: ProxyOptions = {},
) {
  const method = options.method || request.method
  const headers = new Headers()
  headers.set("accept", "application/json")

  let body: BodyInit | undefined
  if (!["GET", "HEAD"].includes(method.toUpperCase())) {
    headers.set("content-type", "application/json")
    const nextBody =
      typeof options.body === "function"
        ? await options.body(request)
        : options.body !== undefined
          ? options.body
          : await readJsonBody(request)
    body = JSON.stringify(nextBody ?? {})
  }

  try {
    const { response, data } = await backendJSON(path, request, {
      method,
      headers,
      body,
    }, options.timeoutMs)
    const payload = response.ok && options.transform
      ? await options.transform(data, response)
      : data
    const res = NextResponse.json(payload ?? {}, { status: response.status })
    const setCookie = response.headers.get("set-cookie")
    if (setCookie) res.headers.set("set-cookie", setCookie) // 回写后端 Set-Cookie 给浏览器(登录/登出)
    return res
  } catch (error) {
    return backendUnavailable(error)
  }
}

export async function proxyJSONOrFallback(
  request: Request,
  path: string,
  fallback: () => Response | Promise<Response>,
  options: ProxyOptions = {},
) {
  const allowFallback = frontendFallbackEnabled()
  const method = options.method || request.method
  const headers = new Headers()
  headers.set("accept", "application/json")

  let body: BodyInit | undefined
  if (!["GET", "HEAD"].includes(method.toUpperCase())) {
    headers.set("content-type", "application/json")
    const nextBody =
      typeof options.body === "function"
        ? await options.body(request)
        : options.body !== undefined
          ? options.body
          : await readJsonBody(request)
    body = JSON.stringify(nextBody ?? {})
  }

  try {
    const { response, data } = await backendJSON(path, request, {
      method,
      headers,
      body,
    }, options.timeoutMs)
    const isRead = ["GET", "HEAD"].includes(method.toUpperCase())
    const isMissingEndpoint = MISSING_ENDPOINT_STATUSES.has(response.status)
    if (!response.ok && allowFallback && (isMissingEndpoint || isRead)) {
      return frontendFallbackResponse(fallback)
    }
    const payload = response.ok && options.transform
      ? await options.transform(data, response)
      : data
    return NextResponse.json(payload ?? {}, { status: response.status })
  } catch (error) {
    if (!allowFallback) return backendUnavailable(error)
    return frontendFallbackResponse(fallback)
  }
}

export async function proxySSE(request: Request, path: string) {
  try {
    const response = await fetch(backendUrl(path, request), {
      headers: { accept: "text/event-stream" },
      cache: "no-store",
      signal: request.signal,
    })
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "")
      return NextResponse.json(
        standardError(
          "BACKEND_STREAM_ERROR",
          text || `SSE upstream returned ${response.status}`,
        ),
        { status: response.status || 502 },
      )
    }
    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    })
  } catch (error) {
    return backendUnavailable(error)
  }
}

export async function proxySSEOrFallback(
  request: Request,
  path: string,
  fallback: () => Response | Promise<Response>,
) {
  const allowFallback = frontendFallbackEnabled()
  try {
    const response = await fetch(backendUrl(path, request), {
      headers: { accept: "text/event-stream" },
      cache: "no-store",
      signal: request.signal,
    })
    if (!response.ok || !response.body) {
      if (allowFallback) return frontendFallbackResponse(fallback)
      const text = await response.text().catch(() => "")
      return NextResponse.json(
        standardError(
          "BACKEND_STREAM_ERROR",
          text || `SSE upstream returned ${response.status}`,
        ),
        { status: response.status || 502 },
      )
    }
    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    })
  } catch (error) {
    if (!allowFallback) return backendUnavailable(error)
    return frontendFallbackResponse(fallback)
  }
}

export async function frontendFallbackResponse(
  fallback: () => Response | Promise<Response>,
) {
  const response = await fallback()
  const headers = new Headers(response.headers)
  headers.set("x-autow-studio-fallback", "true")
  headers.set("x-autow-studio-fallback-mode", "explicit-mock")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function standardError(code: string, message: string) {
  return { ok: false, error: { code, message } }
}

export function backendUnavailable(error: unknown) {
  return NextResponse.json(
    standardError(
      "BACKEND_UNAVAILABLE",
      error instanceof Error ? error.message : String(error),
    ),
    { status: 502 },
  )
}

export function pickArray(data: unknown, keys: string[] = ["items"]) {
  if (Array.isArray(data)) return data
  if (!isRecord(data)) return []
  for (const key of keys) {
    const value = data[key]
    if (Array.isArray(value)) return value
  }
  return []
}

export function pickObject(data: unknown, keys: string[] = ["item"]) {
  if (!isRecord(data)) return data ?? {}
  for (const key of keys) {
    const value = data[key]
    if (isRecord(value)) return value
  }
  return data
}

export function bilingual(value: unknown, fallback = "") {
  if (isRecord(value)) {
    const zh = typeof value.zh === "string" ? value.zh : undefined
    const en = typeof value.en === "string" ? value.en : undefined
    if (zh || en) return { zh: zh || en || fallback, en: en || zh || fallback }
  }
  const text = value == null ? fallback : String(value)
  return { zh: text, en: text }
}

export function toEpoch(value: unknown, fallback = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJSON(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

function truthyEnv(value: string) {
  return /^(1|true|yes|on)$/i.test(value.trim())
}
