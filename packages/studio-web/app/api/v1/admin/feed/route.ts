import { proxyJSON } from "@/lib/api/facade"

/** 管理后台动态:GET 列全部 / POST 发布。严格 admin 门禁在后端(桌面404/未登录401/非admin403)。 */
export async function GET(req: Request) {
  return proxyJSON(req, "/api/v1/admin/feed")
}
export async function POST(req: Request) {
  return proxyJSON(req, "/api/v1/admin/feed", { method: "POST" })
}
