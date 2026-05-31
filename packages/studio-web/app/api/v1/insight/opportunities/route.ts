import { proxyJSONOrFallback, standardError } from "@/lib/api/facade"
import { NextResponse } from "next/server"

/** GET /api/v1/insight/opportunities */
export async function GET(req: Request) {
  return proxyJSONOrFallback(
    req,
    "/api/v1/insight/opportunities",
    () => NextResponse.json(
      standardError(
        "OPPORTUNITIES_BACKEND_MISSING",
        "Insight opportunities are unavailable because the real backend route did not respond.",
      ),
      { status: 503 },
    ),
  )
}
