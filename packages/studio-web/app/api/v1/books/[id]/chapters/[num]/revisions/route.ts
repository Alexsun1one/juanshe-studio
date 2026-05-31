import { NextResponse } from "next/server"
import { proxyJSONOrFallback } from "@/lib/api/facade"

/** GET /api/v1/books/:id/chapters/:num/revisions — 本章修订快照(写手原稿→定稿 + 每轮修复 before/after) */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/chapters/${Number(num)}/revisions`,
    () => NextResponse.json({ bookId: id, chapterNumber: Number(num), passes: [] }),
  )
}
