import { CHAPTERS, PLOT_MILESTONES } from "@/lib/studio-data"
import { delay, jsonOK } from "@/lib/api/route-helpers"
import { proxyJSONOrFallback } from "@/lib/api/facade"

/** GET /api/v1/books/:id/plot-progress */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/plot-progress`,
    async () => {
      await delay()
      return jsonOK({
        bookId: id,
        milestones: PLOT_MILESTONES,
        currentMilestoneId: "p2",
        tensionCurve: CHAPTERS.map((c) => ({
          chapter: c.num,
          tension:
            0.3 +
            Math.sin(c.num * 0.6) * 0.25 +
            (c.num / CHAPTERS.length) * 0.3,
        })),
      })
    },
  )
}
