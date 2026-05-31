import { NextResponse } from "next/server"
import { proxyJSONOrFallback } from "@/lib/api/facade"
import { CAST } from "@/lib/studio-data"

/**
 * GET /api/v1/books/:id/cast — 角色列表
 *
 * 返回章节级以上的全角色列表（按重要度排序）。
 * 每个角色包含 id / 双语姓名 / 角色定位 / arc 进度 / 主题色 / 派系。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/cast`,
    () => NextResponse.json(CAST),
  )
}
