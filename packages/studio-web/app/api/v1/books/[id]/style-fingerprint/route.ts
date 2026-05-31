import { STYLE_RADAR } from "@/lib/studio-data"
import { delay, jsonOK } from "@/lib/api/route-helpers"
import { proxyJSONOrFallback } from "@/lib/api/facade"

/** GET /api/v1/books/:id/style-fingerprint */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/style-fingerprint`,
    async () => {
      await delay()
      return jsonOK({
        bookId: id,
        axes: STYLE_RADAR,
        matchScore: 0.924,
      })
    },
  )
}
