import { proxyJSON } from "@/lib/api/facade"

type RouteContext = {
  params: Promise<{ id: string }>
}

/**
 * POST /api/v1/content-type/:id/write —— 转发到后端真生成端点。
 * 真生成是长耗时调用,放宽超时到 180s,避免默认 6s 把 LLM 请求砍断。
 */
export async function POST(req: Request, ctx: RouteContext) {
  const { id } = await ctx.params
  return proxyJSON(req, `/api/v1/content-type/${encodeURIComponent(id)}/write`, {
    method: "POST",
    timeoutMs: 180_000,
  })
}
