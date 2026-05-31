import { proxyJSON, isRecord } from "@/lib/api/facade"
import type { BookFoundationValidateResult } from "@/lib/api/types"

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(req: Request, ctx: RouteContext) {
  const { id } = await ctx.params
  return proxyJSON(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/foundation/validate`,
    {
      method: "POST",
      transform: (data) => normalizeFoundationValidate(data, id),
    },
  )
}

function normalizeFoundationValidate(
  data: unknown,
  bookId: string,
): BookFoundationValidateResult {
  const payload = isRecord(data) ? data : {}
  const assessment = isRecord(payload.assessment) ? payload.assessment : {}
  const score = numberValue(payload.score) ?? numberValue(assessment.score)
  const blockers = stringList(payload.blockers, stringList(assessment.blockers))
  const repaired = stringList(payload.repaired)
  const ready =
    typeof payload.ready === "boolean"
      ? payload.ready
      : typeof assessment.ready === "boolean"
        ? assessment.ready
        : blockers.length === 0 && payload.ok !== false

  return {
    ...payload,
    ok: typeof payload.ok === "boolean" ? payload.ok : true,
    bookId: typeof payload.bookId === "string" ? payload.bookId : bookId,
    ready,
    score,
    repaired,
    blockers,
    assessment: {
      ...assessment,
      ready,
      score,
      blockers,
    },
  }
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringList(value: unknown, fallback: string[] = []) {
  if (!Array.isArray(value)) return fallback
  const items = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  )
  return items.length ? items.map((item) => item.trim()) : fallback
}
