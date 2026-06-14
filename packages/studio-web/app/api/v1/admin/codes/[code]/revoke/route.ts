import { proxyJSON } from "@/lib/api/facade"

/**
 * POST /api/v1/admin/codes/:code/revoke — 吊销一个码(按规范化后的明文码匹配)。
 * 门禁在后端。
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ code: string }> },
) {
  const { code } = await ctx.params
  return proxyJSON(req, `/api/v1/admin/codes/${encodeURIComponent(code)}/revoke`, {
    method: "POST",
  })
}
