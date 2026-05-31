import { okResult } from "@/lib/api/action-results"
import { proxyJSONOrFallback } from "@/lib/api/facade"
import { delay, jsonOK } from "@/lib/api/route-helpers"

/** POST /api/v1/books/:id/workflow/advance — 推进到下一阶段 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/workflow/progress`,
    async () => {
      await delay(100, 250)
      return jsonOK({ ok: true as const })
    },
    {
      method: "POST",
      transform: () => okResult(),
    },
  )
}
