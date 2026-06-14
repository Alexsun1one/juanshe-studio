import { proxyJSON } from "@/lib/api/facade"

/**
 * POST /api/v1/auth/login — SaaS 邮箱+密码登录。
 * 透传到后端 /api/v1/auth/login;Set-Cookie 回写浏览器以建立会话。
 */
export async function POST(req: Request) {
  return proxyJSON(req, "/api/v1/auth/login", { method: "POST", timeoutMs: 12_000 })
}
