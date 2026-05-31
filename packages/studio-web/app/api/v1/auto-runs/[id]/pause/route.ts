import { proxyRunStopOrFallback } from "@/lib/api/run-actions"

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  return proxyRunStopOrFallback(req, id, "cancelled", "Stopped from Studio Web", missingRun)
}

function missingRun() {
  return Response.json({ error: "not found" }, { status: 404 })
}
