import { proxyJSON } from "@/lib/api/facade"

/**
 * POST /api/v1/auth/register — SaaS 邮箱+密码注册。
 * 透传到后端 /api/v1/auth/register;facade.proxyJSON 已携带 Cookie 并回写
 * 后端的 Set-Cookie(会话 hardwrite_saas_session),浏览器借此拿到登录态。
 */
export async function POST(req: Request) {
  return proxyJSON(req, "/api/v1/auth/register", { method: "POST", timeoutMs: 12_000 })
}
