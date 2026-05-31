import { proxyJSON } from "@/lib/api/facade"

/**
 * GET /api/v1/books/:id/runs — 真实任务运行列表(后端 task_runs 真相)。
 * 判断"是否正在写作 / 当前 agent / 当前阶段"。
 * 不再用空数组兜底:runs 是写作状态唯一真相,后端超时/502 时返错,
 * 前端 SWR 保留上一帧 → isRunning 不被瞬间清成 false(不再"假装写了又退回")。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const limit = new URL(req.url).searchParams.get("limit") ?? "8"
  return proxyJSON(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/runs?limit=${encodeURIComponent(limit)}`,
    { timeoutMs: 12_000 },
  )
}
