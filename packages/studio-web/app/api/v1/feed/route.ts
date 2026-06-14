import { proxyJSON } from "@/lib/api/facade"

/** GET /api/v1/feed — 登录用户读动态(含 unreadCount)。桌面 saas:false 空态;门禁/剥 createdBy 在后端。 */
export async function GET(req: Request) {
  return proxyJSON(req, "/api/v1/feed")
}
