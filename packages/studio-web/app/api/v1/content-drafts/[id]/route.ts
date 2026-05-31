import { NextResponse } from "next/server"
import { proxyJSONOrFallback } from "@/lib/api/facade"

/** DELETE /api/v1/content-drafts/:id — 删除一篇多平台成品 */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/content-drafts/${encodeURIComponent(id)}`,
    () => NextResponse.json({ error: "后端离线,无法删除成品。" }, { status: 503 }),
  )
}
