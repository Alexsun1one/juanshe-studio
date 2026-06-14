import { proxyJSON } from "@/lib/api/facade"

/**
 * GET /api/v1/admin/users — 用户分页列表(email/tier/credits/书数/注册时间/最近活跃)。
 * 透传 query(page/pageSize/search)与 Cookie 到后端 admin 路由;门禁在后端。
 */
export async function GET(req: Request) {
  return proxyJSON(req, "/api/v1/admin/users")
}
