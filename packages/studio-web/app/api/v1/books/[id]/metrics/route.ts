import { normalizeDockMetrics } from "@/lib/api/backend-transforms"
import { proxyJSONOrFallback } from "@/lib/api/facade"
import { jsonOK } from "@/lib/api/route-helpers"

/** GET /api/v1/books/:id/metrics — 底部 Dock 实时指标 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/quality`,
    () =>
      jsonOK({
        speedWordsPerMinute: 0,
        speedTrend: "0%",
        quality: 0,
        consistency: 0,
        adopted: 0,
        tokens: 0,
        remaining: 0,
        remainingPct: 0,
        etaMinutes: 0,
      }),
    { transform: normalizeDockMetrics },
  )
}
