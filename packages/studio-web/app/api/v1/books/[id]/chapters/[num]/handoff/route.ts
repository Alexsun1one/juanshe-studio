import { NextResponse } from "next/server"
import { proxyJSONOrFallback } from "@/lib/api/facade"

/** GET /api/v1/books/:id/chapters/:num/handoff — 每章交接透明面板(纯读,不触发 LLM) */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/chapters/${Number(num)}/handoff`,
    () =>
      NextResponse.json(
        { error: "本章交接需要后端在线。" },
        { status: 503 },
      ),
  )
}
