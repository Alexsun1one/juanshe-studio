import { proxyJSON } from "@/lib/api/facade"

type RouteContext = {
  params: Promise<{ sessionId: string }>
}

export async function GET(req: Request, ctx: RouteContext) {
  const { sessionId } = await ctx.params
  return proxyJSON(req, `/api/v1/sessions/${encodeURIComponent(sessionId)}`)
}

export async function PUT(req: Request, ctx: RouteContext) {
  const { sessionId } = await ctx.params
  return proxyJSON(req, `/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PUT",
  })
}

export async function DELETE(req: Request, ctx: RouteContext) {
  const { sessionId } = await ctx.params
  return proxyJSON(req, `/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  })
}
