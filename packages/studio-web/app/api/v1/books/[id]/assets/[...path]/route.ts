import { proxyJSON } from "@/lib/api/facade"

function assetPath(id: string, path: string[]) {
  const joined = path.join("/")
  return `/api/v1/books/${encodeURIComponent(id)}/assets/${encodeURIComponent(joined)}`
}

/**
 * GET /api/v1/books/:id/assets/:path — 读取文本/Markdown 素材原文。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; path: string[] }> },
) {
  const { id, path } = await ctx.params
  return proxyJSON(req, assetPath(id, path))
}

/**
 * PUT /api/v1/books/:id/assets/:path — 更新文本/Markdown 素材。
 */
export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string; path: string[] }> },
) {
  const { id, path } = await ctx.params
  return proxyJSON(req, assetPath(id, path), { method: "PUT" })
}

/**
 * DELETE /api/v1/books/:id/assets/:path — 删除素材。
 */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string; path: string[] }> },
) {
  const { id, path } = await ctx.params
  return proxyJSON(req, assetPath(id, path), { method: "DELETE" })
}
