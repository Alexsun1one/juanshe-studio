import { NextResponse } from "next/server"
import { proxyJSONOrFallback } from "@/lib/api/facade"
import { WORLD } from "@/lib/studio-data"

/**
 * GET /api/v1/books/:id/world — 世界观节点（核心设定 / 关键事件 / 关系 / 世界观）
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/world`,
    () => NextResponse.json(WORLD),
  )
}
