import { NextResponse } from "next/server"
import { REWRITE_SAMPLE } from "@/lib/studio-data"
import { normalizeRewriteProposal } from "@/lib/api/backend-transforms"
import { proxyJSONOrFallback } from "@/lib/api/facade"
import type { RewriteProposal } from "@/lib/api/types"

/**
 * GET /api/v1/books/:id/chapters/:num/rewrite-proposal?style=tighten — 改写建议
 *
 * 由"润色师 + 风格指纹官"协同产出，按风格 id 返回对照的原文 / 改写文。
 * 后端可根据 style 参数返回不同建议（tighten / lyric / dialog / sensory）。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  const chapterNum = Number(num)
  const url = new URL(req.url)
  const style = url.searchParams.get("style") ?? "tighten"
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/chapters/${chapterNum}/rewrite-proposal`,
    () => {
      const payload: RewriteProposal = {
        bookId: id,
        chapterNum,
        style,
        original: REWRITE_SAMPLE.original,
        revised: REWRITE_SAMPLE.revised,
        matchScore: 0.924,
        wordsDelta: 18,
      }
      return NextResponse.json(payload)
    },
    {
      transform: (data) => normalizeRewriteProposal(data, id, chapterNum, style),
    },
  )
}
