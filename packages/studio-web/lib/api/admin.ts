// ============================================================================
// 管理后台 API 客户端 —— 严格 admin,全部走后端 /api/v1/admin/*(门禁在后端)。
// 与 lib/api/client.ts 同风格:真实 fetch、统一错误。独立成模块,不污染大 client。
// 契约对齐 packages/studio/src/api/server.ts 的 admin 路由组。
// ============================================================================

import { ApiClientError } from "./client"

export type Tier = "normal" | "pro" | "ultra"
export type CodeStatus = "valid" | "used" | "expired" | "revoked" | "unknown"

/** GET /auth/me */
export type AuthMe = {
  saas: boolean
  authenticated: boolean
  user: AdminPublicUser | null
}

/** publicUser() 形状 —— 全站会话/用户公共投影 */
export type AdminPublicUser = {
  id: string
  email: string
  role: string
  tenantId: string
  credits: number
  tier: Tier
  tierExpiresAt: string | null
  tierExpired: boolean
  createdAt: string
}

/** GET /admin/overview */
export type AdminOverview = {
  totalUsers: number
  tierDistribution: { normal: number; pro: number; ultra: number }
  totalBooks: number
  recentSignups: number
  creditsGranted: number
  creditsConsumed: number
  activeWritingJobs: number
  activeSessions: number
}

/** GET /admin/users 行 */
export type AdminUserRow = AdminPublicUser & {
  bookCount: number
  lastActiveAt: string | null
}

export type AdminUsersResult = {
  users: AdminUserRow[]
  total: number
  page: number
  pageSize: number
}

/** GET /admin/codes 行 */
export type AdminCodeRow = {
  id: string
  code: string
  tier: Tier
  expiresAt: string | null
  revoked: boolean
  issuedTo: string | null
  issuedAt: string | null
  redeemedAt: string | null
  source: string
  status: CodeStatus
}

export type AdminMintCodeResult = {
  ok: boolean
  code: string
  id: string
  tier: Tier
  expiresAt: string | null
  status: CodeStatus
  issuedBy: string | null
}

// ── fetch 包装(与 client.ts 一致的错误投影,但局部以免 export 表膨胀)──────────
async function adminError(method: string, url: string, res: Response) {
  const text = await res.text().catch(() => "")
  let payload: unknown = null
  let detail = res.statusText
  try {
    payload = text ? JSON.parse(text) : null
    const err = (payload as { error?: { message?: string } } | null)?.error
    if (err?.message) detail = err.message
  } catch {
    if (text) detail = text
  }
  return new ApiClientError(method, url, res.status, detail, payload)
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" })
  if (!res.ok) throw await adminError("GET", url, res)
  return res.json() as Promise<T>
}

async function postJSON<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  })
  if (!res.ok) throw await adminError("POST", url, res)
  return res.json() as Promise<T>
}

// ── 端点 ────────────────────────────────────────────────────────────────────

export function fetchAuthMe(): Promise<AuthMe> {
  return getJSON<AuthMe>("/api/v1/auth/me")
}

export function fetchAdminOverview(): Promise<AdminOverview> {
  return getJSON<AdminOverview>("/api/v1/admin/overview")
}

export function fetchAdminUsers(opts: { page?: number; pageSize?: number; search?: string } = {}): Promise<AdminUsersResult> {
  const params = new URLSearchParams()
  if (opts.page) params.set("page", String(opts.page))
  if (opts.pageSize) params.set("pageSize", String(opts.pageSize))
  if (opts.search?.trim()) params.set("search", opts.search.trim())
  const qs = params.toString()
  return getJSON<AdminUsersResult>(`/api/v1/admin/users${qs ? `?${qs}` : ""}`)
}

export function adjustUserCredits(userId: string, delta: number, reason?: string): Promise<{ ok: boolean; user: AdminPublicUser }> {
  return postJSON(`/api/v1/admin/users/${encodeURIComponent(userId)}/credits`, { delta, reason })
}

export function setUserTier(userId: string, tier: Tier): Promise<{ ok: boolean; user: AdminPublicUser }> {
  return postJSON(`/api/v1/admin/users/${encodeURIComponent(userId)}/tier`, { tier })
}

export function fetchAdminCodes(): Promise<{ codes: AdminCodeRow[] }> {
  return getJSON<{ codes: AdminCodeRow[] }>("/api/v1/admin/codes")
}

export function mintCode(tier: Tier, expiresInDays?: number): Promise<AdminMintCodeResult> {
  return postJSON<AdminMintCodeResult>("/api/v1/admin/codes", {
    tier,
    expiresInDays: expiresInDays && expiresInDays > 0 ? expiresInDays : undefined,
  })
}

export function revokeCode(code: string): Promise<{ ok: boolean; code: string; status: CodeStatus }> {
  return postJSON(`/api/v1/admin/codes/${encodeURIComponent(code)}/revoke`)
}
