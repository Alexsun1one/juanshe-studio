import { NextResponse } from "next/server"
import { proxyJSONOrFallback } from "@/lib/api/facade"

/** GET /api/v1/books/:id/analytics — 作品分析(章节/字数/审计/Token 用量统计),供洞察页 token 面板消费。 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/analytics`,
    () =>
      NextResponse.json({
        bookId: id,
        totalChapters: 0,
        totalWords: 0,
        unavailable: true,
      }),
  )
}
