import { proxyJSONOrFallback } from "@/lib/api/facade"
import { jsonOK } from "@/lib/api/route-helpers"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const url = new URL(req.url)
  const since = url.searchParams.get("since")
  const limit = boundedLimit(url.searchParams.get("limit"))
  const query = since ? `?since=${encodeURIComponent(since)}` : ""

  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/agents/events${query}`,
    () => jsonOK([]),
    { transform: (data) => sliceRecentEvents(data, limit) },
  )
}

function boundedLimit(value: string | null) {
  const parsed = Number.parseInt(value ?? "", 10)
  if (!Number.isFinite(parsed)) return 80
  return Math.min(Math.max(parsed, 1), 200)
}

function sliceRecentEvents(data: unknown, limit: number) {
  const events = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { events?: unknown }).events)
      ? (data as { events: unknown[] }).events
      : []

  return events
    .slice()
    .sort((a, b) => eventTime(b) - eventTime(a))
    .slice(0, limit)
}

function eventTime(value: unknown) {
  if (!value || typeof value !== "object") return 0
  const source = value as Record<string, unknown>
  const raw = source.time ?? source.ts ?? source.timestamp
  if (typeof raw !== "string") return 0
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}
