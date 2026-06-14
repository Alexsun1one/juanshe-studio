import { proxyJSON } from "@/lib/api/facade"

/**
 * POST /api/v1/admin/users/:id/credits — 调软配额(delta 可正可负,非零整数)。
 * 后端复用 withBillingLock + ledger 记一笔 reason=admin-adjust。门禁在后端。
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSON(req, `/api/v1/admin/users/${encodeURIComponent(id)}/credits`, {
    method: "POST",
  })
}
