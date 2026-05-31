import { normalizeWorkflowContract } from "@/lib/api/backend-transforms"
import { proxyJSONOrFallback, standardError } from "@/lib/api/facade"
import { NextResponse } from "next/server"

export async function GET(req: Request) {
  return proxyJSONOrFallback(
    req,
    "/api/v1/workflow-contract",
    () => NextResponse.json(
      standardError(
        "WORKFLOW_CONTRACT_BACKEND_MISSING",
        "Workflow contract is unavailable because the real backend route did not respond.",
      ),
      { status: 503 },
    ),
    { transform: normalizeWorkflowContract },
  )
}
