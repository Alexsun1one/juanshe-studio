import { NextResponse } from "next/server"
import { proxyJSONOrFallback } from "@/lib/api/facade"
import { OUTLINE } from "@/lib/studio-data"
import type { OutlineAct } from "@/lib/api/types"

/**
 * GET /api/v1/books/:id/outline — 卷/章节大纲（带 beats 数与目标字数）
 *
 * 用于 OutlineMode：每卷一个 section，里面是章节卡片。
 * Writer 完成 beats 后，beats / words / status 会被实时更新。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/outline`,
    () => NextResponse.json(OUTLINE as OutlineAct[]),
  )
}
