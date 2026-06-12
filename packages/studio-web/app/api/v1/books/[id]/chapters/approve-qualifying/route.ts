import { proxyJSONOrFallback, standardError } from "@/lib/api/facade"
import { NextResponse } from "next/server"

/** POST /api/v1/books/:id/chapters/approve-qualifying —— 一键放行所有 score≥targetScore 的章。
 *  静态段必须存在:否则会被同级 [num] 动态段吞掉(parseInt("approve-qualifying")=NaN → 405),
 *  这正是工作台「批准达标」此前静默失效的根因。透传后端 JSON({ok, threshold, approved, total})。 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/chapters/approve-qualifying`,
    () => NextResponse.json(
      standardError(
        "CHAPTER_APPROVE_QUALIFYING_BACKEND_MISSING",
        "Qualifying-chapter approval did not run because the real backend route did not respond.",
      ),
      { status: 503 },
    ),
    { method: "POST" },
  )
}
