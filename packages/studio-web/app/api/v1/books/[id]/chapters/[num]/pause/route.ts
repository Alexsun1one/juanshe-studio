import { proxyJSON } from "@/lib/api/facade"

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  return proxyJSON(req, `/api/v1/books/${encodeURIComponent(id)}/workflow/stop`, {
    method: "POST",
    body: {
      reason: `用户在 Studio Web 停止第 ${num} 章工作流`,
    },
  })
}
