import { CAST, FACTIONS, RELATIONS } from "@/lib/studio-data"
import { delay, jsonOK } from "@/lib/api/route-helpers"
import { proxyJSONOrFallback } from "@/lib/api/facade"

/** GET /api/v1/books/:id/relationship-graph?focusId=lin */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const url = new URL(req.url)
  const focusId = url.searchParams.get("focusId") ?? "lin"

  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/relationship-graph${url.search}`,
    async () => {
      await delay()
      return jsonOK({
        bookId: id,
        focusId,
        factions: FACTIONS,
        nodes: CAST,
        edges: RELATIONS,
        version: 14,
        updatedAt: new Date().toISOString(),
        uptoChapter: 5,
      })
    },
  )
}
