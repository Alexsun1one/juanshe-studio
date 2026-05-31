import { AGENTS } from "@/lib/studio-data"
import { normalizeRoleQueue } from "@/lib/api/backend-transforms"
import { proxyJSONOrFallback } from "@/lib/api/facade"
import { delay, jsonOK } from "@/lib/api/route-helpers"

/** GET /api/v1/books/:id/chapters/:num/role-queue */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  const chapterNum = Number(num)

  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/chapters/${chapterNum}/role-queue`,
    async () => {
      await delay()
      const items = AGENTS.filter((a) => a.currentTask).map((a) => ({
        bookId: id,
        chapterNum,
        agentId: a.id,
        task: a.currentTask!,
        status: a.status,
        startTime: new Date(Date.now() - 60_000).toISOString(),
        outputCount: Math.floor(a.load * 100),
      }))

      return jsonOK(items)
    },
    { transform: (data) => normalizeRoleQueue(data, id, chapterNum) },
  )
}
