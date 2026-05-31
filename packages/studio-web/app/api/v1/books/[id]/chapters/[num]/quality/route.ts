import { DOCK_METRICS } from "@/lib/studio-data"
import { normalizeQuality } from "@/lib/api/backend-transforms"
import { proxyJSONOrFallback } from "@/lib/api/facade"
import { delay, jsonOK } from "@/lib/api/route-helpers"

/** GET /api/v1/books/:id/chapters/:num/quality */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  const chapterNum = Number(num)
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/chapters/${chapterNum}/quality`,
    async () => {
      await delay()
      return jsonOK({
        bookId: id,
        chapterNum,
        overall: DOCK_METRICS.quality,
        consistency: DOCK_METRICS.consistency,
        pacing: 76,
        emotion: 81,
        diction: 79,
        aiTone: 82,
        adopted: DOCK_METRICS.adopted,
        tokens: DOCK_METRICS.tokens,
        speedWordsPerMinute: DOCK_METRICS.speed,
      })
    },
    { transform: (data) => normalizeQuality(data, id, chapterNum) },
  )
}
