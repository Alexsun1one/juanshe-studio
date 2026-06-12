import { proxyJSONOrFallback, standardError } from "@/lib/api/facade"
import { NextResponse } from "next/server"

/** POST /api/v1/books/:id/chapters/:num/approve —— 强制签发单章(编辑器「批准本章」)。
 *  与 publish/route.ts 同源转发,但透传后端 JSON({ok, chapterNumber, status}),
 *  因为调用方(editor approveChapter)要读 status 刷新目录 pill。 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  const chapterNum = Number.parseInt(num, 10) || 1

  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/chapters/${chapterNum}/approve`,
    () => NextResponse.json(
      standardError(
        "CHAPTER_APPROVE_BACKEND_MISSING",
        "Chapter approval did not run because the real backend route did not respond.",
      ),
      { status: 503 },
    ),
    { method: "POST" },
  )
}
