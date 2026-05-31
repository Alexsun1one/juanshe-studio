import { proxyJSON } from "@/lib/api/facade"

/** POST /api/v1/render —— 转发到后端,用 core 渲染器把 Markdown 渲染成各平台成品。 */
export async function POST(req: Request) {
  return proxyJSON(req, "/api/v1/render", { method: "POST" })
}
