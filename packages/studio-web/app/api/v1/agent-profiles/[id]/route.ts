import { normalizeAgentProfiles } from "@/lib/api/backend-transforms"
import { sameAgentId, toBackendAgentId, toFrontendAgentId } from "@/lib/api/agent-aliases"
import {
  backendJSON,
  backendUnavailable,
  readJsonBody,
  standardError,
} from "@/lib/api/facade"
import { NextResponse } from "next/server"

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await params
  const id = toFrontendAgentId(rawId)
  const backendId = toBackendAgentId(id)
  try {
    const current = await backendJSON(
      `/api/v1/agent-profiles/${encodeURIComponent(backendId)}`,
      req,
    )
    if (!current.response.ok) {
      return NextResponse.json(
        current.data ??
          standardError(
            "AGENT_PROFILES_BACKEND_ERROR",
            `Backend returned ${current.response.status} while loading agent profile ${id}.`,
          ),
        { status: current.response.status },
      )
    }
    const profile = normalizeAgentProfiles(current.data).find((item) => sameAgentId(item.id, id))
    if (!profile) return agentProfileNotFound(id)
    return NextResponse.json(profile)
  } catch (error) {
    return backendUnavailable(error)
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await params
  const id = toFrontendAgentId(rawId)
  const backendId = toBackendAgentId(id)
  const body = await readJsonBody(req)
  const patch = isPatchRecord(body) ? body.patch : {}
  try {
    const current = await backendJSON("/api/v1/atelier/agent-profiles", req)
    if (!current.response.ok) {
      return NextResponse.json(current.data ?? { error: "backend unavailable" }, {
        status: current.response.status,
      })
    }
    const root = asRecord(current.data)
    const profiles = asRecord(root.profiles)
    const nextProfiles = {
      ...profiles,
      [backendId]: {
        ...asRecord(profiles[id]),
        ...asRecord(profiles[backendId]),
        ...asRecord(profiles[rawId]),
        ...toBackendPatch(patch),
      },
    }
    const saved = await backendJSON("/api/v1/atelier/agent-profiles", req, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ profiles: nextProfiles }),
    })
    if (!saved.response.ok) {
      return NextResponse.json(saved.data ?? { error: "profile save failed" }, {
        status: saved.response.status,
      })
    }
    const profile = normalizeAgentProfiles(saved.data).find((item) => sameAgentId(item.id, id))
    if (!profile) return agentProfileNotFound(id)
    return NextResponse.json(profile)
  } catch (error) {
    return backendUnavailable(error)
  }
}

function agentProfileNotFound(id: string) {
  return NextResponse.json(
    standardError(
      "AGENT_PROFILE_NOT_FOUND",
      `Agent profile ${id} was not returned by the backend.`,
    ),
    { status: 404 },
  )
}

function isPatchRecord(value: unknown): value is { patch: Record<string, unknown> } {
  return typeof value === "object" &&
    value !== null &&
    "patch" in value &&
    typeof value.patch === "object" &&
    value.patch !== null &&
    !Array.isArray(value.patch)
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function toBackendPatch(patch: Record<string, unknown>) {
  const next: Record<string, unknown> = { ...patch }
  if (typeof patch.systemPrompt === "string") next.promptPatch = patch.systemPrompt
  if (typeof patch.outputSchema === "string") next.outputFormat = patch.outputSchema
  return next
}
