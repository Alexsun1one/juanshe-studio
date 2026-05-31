import { NextResponse } from "next/server"
import { proxyJSONOrFallback } from "@/lib/api/facade"

/** GET /api/v1/books/:id/quality — 全书逐章质量 + 读者信号(后端真实落盘) */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/quality`,
    () => NextResponse.json({ bookId: id, chapters: [], summary: {} }),
  )
}
