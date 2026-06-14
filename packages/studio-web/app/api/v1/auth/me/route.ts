import { proxyJSONOrFallback } from "@/lib/api/facade"
import { jsonOK } from "@/lib/api/route-helpers"

/**
 * GET /api/v1/auth/me — 当前会话用户(SaaS)。
 * 经 facade 透传浏览器 Cookie 让后端解析会话;返回 { saas, authenticated, user }。
 * 后端不可达时按桌面形态降级(saas:false, user:null)——让会话守卫回落本地逻辑,
 * 不把用户硬锁在门外(与 /auth/activation 的降级策略一致)。
 */
export async function GET(req: Request) {
  return proxyJSONOrFallback(
    req,
    "/api/v1/auth/me",
    () => jsonOK({ saas: false, authenticated: true, user: null }),
    { timeoutMs: 8_000 },
  )
}
