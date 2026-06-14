import { backendUrl } from "@/lib/api/facade"

/** GET /api/v1/books/:id/export — 代理真实后端导出文件流 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const upstream = await fetch(
    backendUrl(`/api/v1/books/${encodeURIComponent(id)}/export`, req),
    {
      headers: {
        Accept: req.headers.get("accept") ?? "*/*",
        // 透传 Cookie:SaaS 会话鉴权需要,否则登录态穿不过 Next 代理 → 401。
        cookie: req.headers.get("cookie") ?? "",
      },
      cache: "no-store",
    },
  )

  const headers = new Headers()
  for (const key of ["content-type", "content-disposition"]) {
    const value = upstream.headers.get(key)
    if (value) headers.set(key, value)
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}
