import { proxyJSON } from "@/lib/api/facade"

/**
 * POST /api/v1/books/:id/chapters/:num/enhance — 按指令增强并可落地改写本章。
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  return proxyJSON(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/chapters/${Number(num)}/enhance`,
    { method: "POST", timeoutMs: 120_000 },
  )
}
