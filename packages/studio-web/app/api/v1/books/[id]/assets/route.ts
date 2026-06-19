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

/**
 * POST /api/v1/books/:id/assets — 新建 Markdown 素材。
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/assets`,
    () => NextResponse.json({ error: "素材写入需要连接后端。" }, { status: 501 }),
    { method: "POST" },
  )
}
