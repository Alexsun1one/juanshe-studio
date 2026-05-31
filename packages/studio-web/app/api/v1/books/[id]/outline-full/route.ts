import { proxyJSON } from "@/lib/api/facade"

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSON(req, `/api/v1/books/${encodeURIComponent(id)}/outline-full`)
}
