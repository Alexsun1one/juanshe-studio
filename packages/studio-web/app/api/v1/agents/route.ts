import { normalizeAgentsFromFlow } from "@/lib/api/backend-transforms"
import { proxyJSONOrFallback, standardError } from "@/lib/api/facade"
import { NextResponse } from "next/server"

/** GET /api/v1/agents — 全局 agent 列表 */
export async function GET(req: Request) {
  return proxyJSONOrFallback(
    req,
    "/api/v1/agent-flow",
    () => NextResponse.json(
      standardError(
        "AGENT_FLOW_BACKEND_MISSING",
        "Agent flow is unavailable because the real backend route did not respond.",
      ),
      { status: 503 },
    ),
    { transform: (data) => normalizeAgentsFromFlow(data) },
  )
}
