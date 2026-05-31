import { normalizeConnectivityResults } from "@/lib/api/backend-transforms"
import { proxyJSONOrFallback, standardError } from "@/lib/api/facade"
import { NextResponse } from "next/server"

export async function POST(req: Request) {
  return proxyJSONOrFallback(
    req,
    "/api/v1/atelier/model-connectivity",
    () => NextResponse.json(
      standardError(
        "CONNECTIVITY_BACKEND_MISSING",
        "Connectivity tests did not run because the real backend route did not respond.",
      ),
      { status: 503 },
    ),
    {
      method: "POST",
      transform: (data) => normalizeConnectivityResults(data),
    },
  )
}
