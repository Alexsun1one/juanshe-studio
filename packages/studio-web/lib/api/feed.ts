// ============================================================================
// 站长广播 Feed —— 登录用户侧 API 客户端(读取 + 标记已读)。
// 站长在管理后台发的「动态」(公众号文章 / 新品 / 更新日志)→ 全体用户站内可见。
// 这是免费产品(BYOK)的直达广播频道,把活跃写作者注意力导回站长的内容。
// 桌面单机模式无广播概念:后端按 isSaasModeEnabled gate 返回 { saas:false, items:[] },
// 行为字节级不变(不报错、不暴露 SaaS 语义)。前端据 saas 字段决定是否渲染动态条。
// 契约对齐 packages/studio/src/api/server.ts 的 /api/v1/feed 路由组。
// 与 lib/api/admin.ts 同风格:真实 fetch、统一错误,独立成模块不污染大 client。
// ============================================================================

import { ApiClientError } from "./client"

export type FeedType = "update" | "article" | "product"

/** 一条站长动态(GET /feed 行 / admin 列表行同形) */
export type FeedItem = {
  id: string
  title: string
  body: string
  link: string
  type: FeedType
  pinned: boolean
  createdAt: string
  createdBy: string | null
}

/** GET /api/v1/feed —— 登录用户读取 + 未读计数 */
export type FeedResult = {
  saas: boolean
  items: FeedItem[]
  unreadCount: number
  feedSeenAt?: string | null
}

// ── fetch 包装(与 admin.ts 一致的错误投影,局部以免 export 表膨胀)──────────────
async function feedError(method: string, url: string, res: Response) {
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

/** GET /feed —— 拉全体动态 + 当前用户未读数。401 等错误照常抛(由调用方/SWR 处理)。 */
export async function fetchFeed(): Promise<FeedResult> {
  const url = "/api/v1/feed"
  const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" })
  if (!res.ok) throw await feedError("GET", url, res)
  return res.json() as Promise<FeedResult>
}

/** POST /feed/seen —— 把 user.feedSeenAt = now,清零未读(后端走 withBillingLock 串行写)。 */
export async function markFeedSeen(): Promise<{ ok: boolean; feedSeenAt: string | null }> {
  const url = "/api/v1/feed/seen"
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json" },
    cache: "no-store",
  })
  if (!res.ok) throw await feedError("POST", url, res)
  return res.json() as Promise<{ ok: boolean; feedSeenAt: string | null }>
}
