import { proxyJSON } from "@/lib/api/facade"

/** POST /api/v1/books/:id/write-batch — 连续写 N 章,每章按质量门槛把关,不达标即停 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSON(req, `/api/v1/books/${encodeURIComponent(id)}/write-batch`, {
    method: "POST",
    timeoutMs: 120_000,
  })
}
