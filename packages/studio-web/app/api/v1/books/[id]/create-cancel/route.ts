import { proxyJSON } from "@/lib/api/facade"

/** POST /api/v1/books/:id/create-cancel — 取消进行中的建书(停 run、释放写锁、abort job) */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSON(req, `/api/v1/books/${encodeURIComponent(id)}/create-cancel`, {
    method: "POST",
  })
}
