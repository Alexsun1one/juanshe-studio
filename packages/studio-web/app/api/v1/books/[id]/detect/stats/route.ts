import { proxyJSON } from "@/lib/api/facade"

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function GET(req: Request, ctx: RouteContext) {
  const { id } = await ctx.params
  return proxyJSON(req, `/api/v1/books/${encodeURIComponent(id)}/detect/stats`)
}
