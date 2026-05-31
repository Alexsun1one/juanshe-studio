import { normalizeChapters } from "@/lib/api/backend-transforms"
import {
  backendJSON,
  backendUnavailable,
  frontendFallbackEnabled,
} from "@/lib/api/facade"
import { jsonOK } from "@/lib/api/route-helpers"
import { CHAPTERS } from "@/lib/studio-data"
import { NextResponse } from "next/server"

/** GET /api/v1/books/:id/chapters */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  try {
    const { response, data } = await backendJSON(
      `/api/v1/books/${encodeURIComponent(id)}/chapters`,
      req,
    )

    if (!response.ok) {
      if (isBookStillMaterializing(response.status, data)) return jsonOK([])
      if (canUseChapterFallback(response.status)) {
        const chapters = await loadBookDetailChapters(id, req)
        if (chapters.length) return jsonOK(chapters)
        return jsonOK(sampleChapters(id))
      }
      return NextResponse.json(data ?? {}, { status: response.status })
    }

    return jsonOK(normalizeChapters(data, id))
  } catch (error) {
    if (frontendFallbackEnabled()) {
      const chapters = await loadBookDetailChapters(id, req).catch(() => [])
      if (chapters.length) return jsonOK(chapters)
      return jsonOK(sampleChapters(id))
    }
    return backendUnavailable(error)
  }
}

async function loadBookDetailChapters(id: string, req: Request) {
  const { response, data } = await backendJSON(
    `/api/v1/books/${encodeURIComponent(id)}`,
    req,
  )
  if (!response.ok) return []
  return normalizeChapters(data, id)
}

function sampleChapters(id: string) {
  return normalizeChapters({ chapters: CHAPTERS }, id)
}

function canUseChapterFallback(status: number) {
  if (!frontendFallbackEnabled()) return false
  return status === 404 || status === 405 || status === 501 || status >= 500
}

function isBookStillMaterializing(status: number, data: unknown) {
  if (status !== 404 && status < 500) return false
  const text =
    typeof data === "string"
      ? data
      : data && typeof data === "object"
        ? JSON.stringify(data)
        : ""
  return text.includes("ENOENT") && text.includes("book.json")
}
