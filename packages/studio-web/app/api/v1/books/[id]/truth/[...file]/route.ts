import { proxyJSON } from "@/lib/api/facade"

function truthPath(id: string, file: string[]) {
  const joined = file.join("/")
  return `/api/v1/books/${encodeURIComponent(id)}/truth/${encodeURIComponent(joined)}`
}

/**
 * GET /api/v1/books/:id/truth/:file — 读取 story truth 原文。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; file: string[] }> },
) {
  const { id, file } = await ctx.params
  return proxyJSON(req, truthPath(id, file))
}

/**
 * PUT /api/v1/books/:id/truth/:file — 保存 story truth 原文。
 */
export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string; file: string[] }> },
) {
  const { id, file } = await ctx.params
  return proxyJSON(req, truthPath(id, file), { method: "PUT" })
}
