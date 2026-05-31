import { proxyJSON } from "@/lib/api/facade"

/** POST /api/v1/books/:id/workflow/stop — 停止本书全部进行中的工作流(真实端点) */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSON(req, `/api/v1/books/${encodeURIComponent(id)}/workflow/stop`, {
    method: "POST",
  })
}
