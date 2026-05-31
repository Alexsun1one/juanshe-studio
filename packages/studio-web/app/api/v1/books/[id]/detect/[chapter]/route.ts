import { proxyJSON } from "@/lib/api/facade"

type RouteContext = {
  params: Promise<{ id: string; chapter: string }>
}

export async function POST(req: Request, ctx: RouteContext) {
  const { id, chapter } = await ctx.params
  return proxyJSON(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/detect/${encodeURIComponent(chapter)}`,
    { method: "POST" },
  )
}
