import { normalizeSystemHealth } from "@/lib/api/backend-transforms"
import { proxyJSONOrFallback, standardError } from "@/lib/api/facade"
import { NextResponse } from "next/server"

/** GET /api/v1/system/health */
export async function GET(req: Request) {
  return proxyJSONOrFallback(
    req,
    "/api/v1/doctor",
    () => NextResponse.json(
      standardError(
        "SYSTEM_HEALTH_BACKEND_MISSING",
        "System health is unavailable because the real backend route did not respond.",
      ),
      { status: 503 },
    ),
    { transform: normalizeSystemHealth, timeoutMs: 25_000 },
  )
}
