import { CHAPTERS } from "@/lib/studio-data"
import {
  normalizeChapterDetail,
  normalizeChapters,
} from "@/lib/api/backend-transforms"
import {
  backendJSON,
  backendUnavailable,
  frontendFallbackEnabled,
  proxyJSON,
} from "@/lib/api/facade"
import { jsonErr, jsonOK } from "@/lib/api/route-helpers"
import { NextResponse } from "next/server"

/** DELETE /api/v1/books/:id/chapters/:num — 删除第 N 章及之后全部章节(尾部截断,原稿进 backups/) */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params

  return proxyJSON(req, `/api/v1/books/${encodeURIComponent(id)}/chapters/${Number(num)}`, {
    method: "DELETE",
  })
}

/** GET /api/v1/books/:id/chapters/:num */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  const chapterNum = Number(num)

  try {
    const { response, data } = await backendJSON(
      `/api/v1/books/${encodeURIComponent(id)}/chapters/${chapterNum}`,
      req,
    )

    if (response.ok) {
      return jsonOK(
        normalizeChapterDetail(
          { chapter: chapterRecordFromBackend(data, chapterNum) },
          id,
          chapterNum,
        ),
      )
    }

    if (canUseChapterFallback(response.status)) {
      const realChapter = await loadChapterFromBookDetail(id, chapterNum, req)
      if (realChapter) return jsonOK(realChapter)

      const sampleChapter = CHAPTERS.find((chapter) => chapter.num === chapterNum)
      if (sampleChapter) {
        return jsonOK(normalizeChapterDetail({ chapter: sampleChapter }, id, chapterNum))
      }
      return jsonErr("not_found", `chapter ${num}`, 404)
    }

    return NextResponse.json(data ?? {}, { status: response.status })
  } catch (error) {
    if (frontendFallbackEnabled()) {
      const realChapter = await loadChapterFromBookDetail(id, chapterNum, req).catch(
        () => undefined,
      )
      if (realChapter) return jsonOK(realChapter)

      const sampleChapter = CHAPTERS.find((chapter) => chapter.num === chapterNum)
      if (sampleChapter) {
        return jsonOK(normalizeChapterDetail({ chapter: sampleChapter }, id, chapterNum))
      }
    }
    return backendUnavailable(error)
  }
}

async function loadChapterFromBookDetail(
  id: string,
  chapterNum: number,
  req: Request,
) {
  const { response, data } = await backendJSON(
    `/api/v1/books/${encodeURIComponent(id)}`,
    req,
  )
  if (!response.ok) return undefined

  const chapters = normalizeChapters(data, id)
  return chapters.find((chapter) => chapter.num === chapterNum)
}

function canUseChapterFallback(status: number) {
  if (!frontendFallbackEnabled()) return false
  return status === 404 || status === 405 || status === 501 || status >= 500
}

function chapterRecordFromBackend(data: unknown, chapterNum: number) {
  const source = asObject(data)
  const quality = asObject(source.quality)
  const qualityStats = asObject(quality.stats)
  const qualityReport = asObject(source.qualityReport)
  const title =
    text(source.title) ||
    text(qualityReport.title) ||
    titleFromFilename(text(source.filename)) ||
    `Chapter ${chapterNum}`
  const words =
    numeric(source.wordCount) ||
    numeric(source.words) ||
    numeric(qualityStats.chineseChars) ||
    numeric(qualityStats.wordCount)

  return {
    ...source,
    num:
      numeric(source.num) ||
      numeric(source.number) ||
      numeric(source.chapterNum) ||
      numeric(source.chapterNumber) ||
      chapterNum,
    title,
    words,
    wordCount: words,
    status: text(source.status) || text(qualityReport.status) || "draft",
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown) {
  return typeof value === "string" ? value : ""
}

function numeric(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""))
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function titleFromFilename(filename: string) {
  const match = filename.match(/^\d+_(.+?)\.md$/)
  return match?.[1] ?? ""
}
