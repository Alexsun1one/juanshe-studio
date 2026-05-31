import { normalizeAgentProfiles } from "@/lib/api/backend-transforms"
import { proxyJSONOrFallback, standardError } from "@/lib/api/facade"
import { NextResponse } from "next/server"

export async function GET(req: Request) {
  return proxyJSONOrFallback(
    req,
    "/api/v1/atelier/agent-profiles",
    () => NextResponse.json(
      standardError(
        "AGENT_PROFILES_BACKEND_MISSING",
        "Agent profiles are unavailable because the real backend route did not respond.",
      ),
      { status: 503 },
    ),
    { transform: (data) => normalizeAgentProfiles(data) },
  )
}
