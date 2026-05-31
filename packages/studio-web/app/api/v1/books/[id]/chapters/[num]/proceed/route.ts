import { okResult } from "@/lib/api/action-results"
import { proxyJSONOrFallback, readJsonBody } from "@/lib/api/facade"
import { delay, jsonOK } from "@/lib/api/route-helpers"

/** POST /api/v1/books/:id/chapters/:num/proceed — 推进章节状态 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  const chapterNum = Number.parseInt(num, 10) || 1

  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/chapters/${chapterNum}/proceed`,
    async () => {
      await delay(80, 200)
      return jsonOK({ ok: true as const })
    },
    {
      method: "POST",
      body: async (request: Request) => ({
        ...(await readJsonBody(request)),
        chapterNum,
      }),
      transform: () => okResult(),
    },
  )
}
