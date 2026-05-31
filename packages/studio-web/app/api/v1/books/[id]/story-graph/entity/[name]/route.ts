import { NextResponse } from "next/server"
import { proxyJSONOrFallback } from "@/lib/api/facade"

/** GET /api/v1/books/:id/story-graph/entity/:name — 实体卡(状态时间线 + 关系 + 邻居),供实体详情页消费。 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; name: string }> },
) {
  const { id, name } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/story-graph/entity/${encodeURIComponent(name)}`,
    () => NextResponse.json({ error: "实体记忆需要后端在线。" }, { status: 503 }),
  )
}
