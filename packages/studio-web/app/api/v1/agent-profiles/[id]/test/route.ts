import { normalizeConnectivityResult } from "@/lib/api/backend-transforms"
import { proxyJSONOrFallback, standardError } from "@/lib/api/facade"
import { NextResponse } from "next/server"

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  return proxyJSONOrFallback(
    req,
    "/api/v1/atelier/model-connectivity",
    () => NextResponse.json(
      standardError(
        "CONNECTIVITY_BACKEND_MISSING",
        `Connectivity test for ${id} did not run because the real backend route did not respond.`,
      ),
      { status: 503 },
    ),
    {
      method: "POST",
      transform: (data) => normalizeConnectivityResult(data, id),
    },
  )
}
