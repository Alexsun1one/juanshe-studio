import { proxyJSON } from "@/lib/api/facade"

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(req: Request, ctx: RouteContext) {
  const { id } = await ctx.params
  return proxyJSON(req, `/api/v1/genres/${encodeURIComponent(id)}/copy`, {
    method: "POST",
  })
}
