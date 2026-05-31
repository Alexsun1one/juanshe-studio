import { NextResponse } from "next/server"
import { REVIEW_ISSUES } from "@/lib/studio-data"
import { normalizeReviewIssues } from "@/lib/api/backend-transforms"
import { proxyJSONOrFallback } from "@/lib/api/facade"

/**
 * GET /api/v1/books/:id/chapters/:num/review-issues — 审稿待处理项
 *
 * 由"审稿官 / 状态校验员 / 章节分析官 / 润色师"等多 agent 协作产出。
 * 每条 issue 携带：严重度 / 引文 / 建议 / 来源 agent。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/chapters/${Number(num)}/review-issues`,
    () => NextResponse.json(REVIEW_ISSUES),
    { transform: normalizeReviewIssues },
  )
}
