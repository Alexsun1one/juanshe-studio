import { NextResponse } from "next/server"
import { proxyJSONOrFallback, standardError } from "@/lib/api/facade"
import { normalizeAutoRun } from "@/lib/api/backend-transforms"

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/runs/${encodeURIComponent(id)}`,
    () => NextResponse.json(
      standardError(
        "RUN_NOT_FOUND",
        `Run ${id} was not returned by the backend.`,
      ),
      { status: 404 },
    ),
    { transform: (data) => normalizeAutoRun(data) },
  )
}
