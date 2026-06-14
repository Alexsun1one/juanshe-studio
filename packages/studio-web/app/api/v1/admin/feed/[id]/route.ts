import { proxyJSON } from "@/lib/api/facade"

/** DELETE /api/v1/admin/feed/:id — 删一条动态。admin 门禁在后端。 */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSON(req, `/api/v1/admin/feed/${encodeURIComponent(id)}`, { method: "DELETE" })
}
