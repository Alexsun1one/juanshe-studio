import { proxyJSONOrFallback, standardError } from "@/lib/api/facade"
import { NextResponse } from "next/server"

/** POST /api/v1/books/:id/chapters/:num/repair-low-score —— 低分章一键复修(工作台「修复本章」/ 一致性页「复修」)。
 *  之前缺这个代理路由:POST 落到 Next 自身、没匹配到任何 route → 返回 HTML 404 页,
 *  前端报「复修触发失败 … 404: <!DOCTYPE html>…」。后端 server.ts 一直有该路由(返回 { ok, runId, status }),
 *  缺的只是这一层转发。body { targetScore } 由 proxyJSONOrFallback 默认透传到后端。 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  const chapterNum = Number.parseInt(num, 10) || 1

  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/chapters/${chapterNum}/repair-low-score`,
    () => NextResponse.json(
      standardError(
        "CHAPTER_REPAIR_LOW_SCORE_BACKEND_MISSING",
        "Low-score repair did not run because the real backend route did not respond.",
      ),
      { status: 503 },
    ),
    { method: "POST" },
  )
}
