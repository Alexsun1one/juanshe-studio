import { proxyJSON } from "@/lib/api/facade"

/**
 * POST /api/v1/auth/logout — 清除 SaaS 会话。
 * 透传到后端 /api/v1/auth/logout;后端清会话并回写清空 Cookie 的 Set-Cookie。
 */
export async function POST(req: Request) {
  return proxyJSON(req, "/api/v1/auth/logout", { method: "POST", timeoutMs: 8_000 })
}
