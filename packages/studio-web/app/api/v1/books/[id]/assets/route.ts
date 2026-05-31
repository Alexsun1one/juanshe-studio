import { NextResponse } from "next/server"
import { proxyJSONOrFallback } from "@/lib/api/facade"
import { ASSETS } from "@/lib/studio-data"

/**
 * GET /api/v1/books/:id/assets — 素材资产列表（doc / image / audio / video）
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/assets`,
    () => NextResponse.json(ASSETS),
  )
}
