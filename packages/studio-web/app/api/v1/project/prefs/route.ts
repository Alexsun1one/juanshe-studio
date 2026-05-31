import { normalizeProjectPrefs } from "@/lib/api/backend-transforms"
import { proxyJSONOrFallback, readJsonBody, standardError } from "@/lib/api/facade"
import { NextResponse } from "next/server"

export async function GET(req: Request) {
  return proxyJSONOrFallback(
    req,
    "/api/v1/project/prefs",
    () => NextResponse.json(
      standardError(
        "PROJECT_PREFS_BACKEND_MISSING",
        "Project preferences are unavailable because the real backend route did not respond.",
      ),
      { status: 503 },
    ),
    { transform: normalizeProjectPrefs },
  )
}

export async function PATCH(req: Request) {
  const body = await readJsonBody(req)
  return proxyJSONOrFallback(
    req,
    "/api/v1/project/prefs",
    () => NextResponse.json(
      standardError(
        "PROJECT_PREFS_SAVE_UNAVAILABLE",
        "Project preferences were not saved because the real backend route did not respond.",
      ),
      { status: 503 },
    ),
    { method: "PATCH", body, transform: normalizeProjectPrefs },
  )
}
