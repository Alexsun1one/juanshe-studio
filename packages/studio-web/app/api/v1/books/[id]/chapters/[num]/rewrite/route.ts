import { proxyJSON, readJsonBody } from "@/lib/api/facade"

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  return proxyJSON(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/rewrite/${encodeURIComponent(num)}`,
    {
      method: "POST",
      body: async (request: Request) => {
        const body = await readJsonBody(request)
        const brief =
          typeof body.brief === "string" && body.brief.trim()
            ? body.brief.trim()
            : typeof body.style === "string" && body.style.trim()
              ? `按 ${body.style.trim()} 风格复修本章，并保持上下文连续。`
              : "复修本章，保留事实、视角和上下文连续性。"
        return { ...body, brief }
      },
    },
  )
}
