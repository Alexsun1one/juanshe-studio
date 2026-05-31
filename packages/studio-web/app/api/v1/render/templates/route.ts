import { proxyJSON } from "@/lib/api/facade"

/** GET /api/v1/render/templates —— 转发到后端,列出 wechat 5 个模板 + default。 */
export async function GET(req: Request) {
  return proxyJSON(req, "/api/v1/render/templates", { method: "GET" })
}
