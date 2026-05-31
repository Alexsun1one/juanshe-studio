import { NextResponse } from "next/server"
import { proxyJSONOrFallback } from "@/lib/api/facade"

/** GET /api/v1/books/:id/chapters/:num/editorial-review — 读总编裁决缓存(不触发 LLM) */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/chapters/${Number(num)}/editorial-review`,
    () => NextResponse.json({ bookId: id, chapterNumber: Number(num), review: null, cached: false }),
  )
}

/** POST /api/v1/books/:id/chapters/:num/editorial-review — 让总编重新做整章裁决(真 LLM) */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/chapters/${Number(num)}/editorial-review`,
    () =>
      NextResponse.json(
        { error: "总编复审需要后端在线。" },
        { status: 503 },
      ),
    // 总编复审是真 LLM 调用(deepseek 整章裁决),20s 不够 → 给足 120s
    { method: "POST", body: {}, timeoutMs: 120_000 },
  )
}
