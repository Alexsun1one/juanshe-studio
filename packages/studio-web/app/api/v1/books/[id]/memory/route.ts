import { proxyJSONOrFallback } from "@/lib/api/facade"
import { jsonOK } from "@/lib/api/route-helpers"
import { MEMORIES } from "@/lib/studio-data"

/** GET /api/v1/books/:id/memory?kind=long */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const url = new URL(req.url)
  const kind = url.searchParams.get("kind")
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/memory${url.search}`,
    () => jsonOK(kind ? MEMORIES.filter((item) => item.kind === kind) : MEMORIES),
  )
}
