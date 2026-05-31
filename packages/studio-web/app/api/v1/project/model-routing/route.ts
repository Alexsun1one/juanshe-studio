import { backendJSON, isRecord, readJsonBody } from "@/lib/api/facade"
import { NextResponse } from "next/server"

export async function GET(req: Request) {
  return readModelRouting(req)
}

export async function PATCH(req: Request) {
  const body = await readJsonBody(req)
  const routes = isRecord(body) && isRecord(body.routes) ? body.routes : {}
  const defaultRoute = isRecord(body) && typeof body.default === "string"
    ? body.default
    : undefined

  try {
    const current = await backendJSON("/api/v1/atelier/agent-profiles", req)
    if (!current.response.ok) {
      return NextResponse.json(current.data ?? { error: "backend unavailable" }, {
        status: current.response.status,
      })
    }

    const currentProfiles = profilesOf(current.data)
    const fallbackRoute = defaultRoute ?? firstRoute(currentProfiles)
    const nextProfiles = Object.fromEntries(
      Object.entries(currentProfiles).map(([id, profile]) => {
        const route = typeof routes[id] === "string" ? routes[id] : fallbackRoute
        return [id, { ...profile, ...routeToProfile(route, profile) }]
      }),
    )

    const saved = await backendJSON("/api/v1/atelier/agent-profiles", req, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ profiles: nextProfiles }),
    })
    if (!saved.response.ok) {
      return NextResponse.json(saved.data ?? { error: "model routing save failed" }, {
        status: saved.response.status,
      })
    }
    return modelRoutingResponse(saved.data)
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    )
  }
}

async function readModelRouting(req: Request) {
  try {
    const { response, data } = await backendJSON("/api/v1/atelier/agent-profiles", req)
    if (!response.ok) {
      return NextResponse.json(data ?? { error: "backend unavailable" }, {
        status: response.status,
      })
    }
    return modelRoutingResponse(data)
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    )
  }
}

function modelRoutingResponse(data: unknown) {
  const profiles = profilesOf(data)
  const routes = Object.fromEntries(
    Object.entries(profiles).map(([id, profile]) => [id, routeOf(profile)]),
  )
  return NextResponse.json({
    routes,
    default: firstRoute(profiles),
  })
}

function profilesOf(data: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(data) || !isRecord(data.profiles)) return {}
  return Object.fromEntries(
    Object.entries(data.profiles)
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])),
  )
}

function firstRoute(profiles: Record<string, Record<string, unknown>>) {
  return routeOf(Object.values(profiles)[0] ?? {})
}

function routeOf(profile: Record<string, unknown>) {
  const service = typeof profile.service === "string" ? profile.service : ""
  const model = typeof profile.model === "string" ? profile.model : ""
  return service ? `${service}/${model}` : model
}

function routeToProfile(route: string, current: Record<string, unknown>) {
  const slashIndex = route.lastIndexOf("/")
  if (slashIndex < 0) return { model: route }
  return {
    service: route.slice(0, slashIndex) || current.service,
    model: route.slice(slashIndex + 1) || current.model,
  }
}
