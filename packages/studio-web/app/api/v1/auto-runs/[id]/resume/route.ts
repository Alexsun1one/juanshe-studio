import { proxyRunResumeOrFallback } from "@/lib/api/run-actions"

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  return proxyRunResumeOrFallback(req, id, missingRun)
}

function missingRun() {
  return Response.json({ error: "not found" }, { status: 404 })
}
