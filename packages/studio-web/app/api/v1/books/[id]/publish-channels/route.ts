import { NextResponse } from "next/server"
import { proxyJSONOrFallback, standardError } from "@/lib/api/facade"

/**
 * GET /api/v1/books/:id/publish-channels — 发布渠道列表
 *
 * 已绑定的所有发布渠道（起点 / 番茄 / 微信读书 / Royal Road 等），
 * 含每渠道的最新状态和上次同步时间。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/publish-channels`,
    () => NextResponse.json(
      standardError(
        "PUBLISH_CHANNELS_BACKEND_MISSING",
        "Publish channels are unavailable because the real backend route did not respond.",
      ),
      { status: 503 },
    ),
  )
}
