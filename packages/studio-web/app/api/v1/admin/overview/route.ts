import { proxyJSON } from "@/lib/api/facade"

/**
 * GET /api/v1/admin/overview — 管理后台概览(全平台真数据)。
 * 严格 admin 门禁在后端:桌面模式整段 404,SaaS 非 admin 401/403。
 * 这里只做透传(带 Cookie),不降级 mock —— 后端不可达直接报 502,绝不假装成功。
 */
export async function GET(req: Request) {
  return proxyJSON(req, "/api/v1/admin/overview")
}
