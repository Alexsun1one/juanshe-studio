import { okRunResult } from "@/lib/api/action-results"
import { proxyJSONOrFallback, readJsonBody, standardError } from "@/lib/api/facade"
import { NextResponse } from "next/server"

/** POST /api/v1/books/:id/chapters/:num/review */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  const chapterNum = Number.parseInt(num, 10) || 1

  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/review`,
    () => NextResponse.json(
      standardError(
        "REVIEW_BACKEND_MISSING",
        "Review did not start because the real backend route did not respond.",
      ),
      { status: 503 },
    ),
    {
      method: "POST",
      body: async (request: Request) => ({
        ...(await readJsonBody(request)),
        chapterNum,
      }),
      transform: (data) => okRunResult(data, "review"),
    },
  )
}
