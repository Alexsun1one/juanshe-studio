import { backendUrl } from "@/lib/api/facade"

/**
 * GET /api/v1/export/books —— 代理真实后端「导出全部书稿」的 zip 文件流。
 * 透传 Cookie(鉴权)与 content-disposition(文件名),把整包 zip 原样流回浏览器触发下载。
 */
export async function GET(req: Request) {
  const upstream = await fetch(backendUrl("/api/v1/export/books", req), {
    headers: {
      Accept: req.headers.get("accept") ?? "*/*",
      cookie: req.headers.get("cookie") ?? "",
    },
    cache: "no-store",
  })

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
