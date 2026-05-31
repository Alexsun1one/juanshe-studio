import { okResult } from "@/lib/api/action-results"
import { proxyJSONOrFallback, readJsonBody, standardError } from "@/lib/api/facade"
import { NextResponse } from "next/server"

/** POST /api/v1/books/:id/chapters/:num/publish */
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
