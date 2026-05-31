import { NextResponse } from "next/server"
import { proxyJSONOrFallback } from "@/lib/api/facade"

/** GET /api/v1/books/:id/story-graph — 活的故事知识图谱(实体+时序关系),供交互式图谱页消费。 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/story-graph`,
    () =>
      NextResponse.json({
        bookId: id,
        stats: { entities: 0, relations: 0, activeRelations: 0 },
        nodes: [],
        edges: [],
        unavailable: true,
      }),
  )
}
