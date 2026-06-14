import { proxyJSON } from "@/lib/api/facade"

/**
 * POST /api/v1/admin/users/:id/tier — 改 tier(normal/pro/ultra)。
 * 管理员手改 = 永久 tier(后端清掉限时到期标记)。门禁在后端。
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSON(req, `/api/v1/admin/users/${encodeURIComponent(id)}/tier`, {
    method: "POST",
  })
}
