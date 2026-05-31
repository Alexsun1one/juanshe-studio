import { NextResponse } from "next/server"
import {
  normalizeChapters,
  normalizeChapterStats,
} from "@/lib/api/backend-transforms"
import {
  backendJSON,
  backendUnavailable,
  frontendFallbackEnabled,
} from "@/lib/api/facade"
import type { ChapterStats } from "@/lib/api/types"

/**
 * GET /api/v1/books/:id/chapters/:num/stats — 章节实时统计
 *
 * Write Mode 头部和控制栏显示：当前字数 / 本次会话耗时 / 章节目标 / 章节进度。
 * 实时性要求高，前端建议 4s 轮询，并配合 SSE 的 metric 事件做即时更新。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  const chapterNum = Number(num)

  try {
    const { response, data } = await backendJSON(
      `/api/v1/books/${encodeURIComponent(id)}/chapters/${chapterNum}/stats`,
      req,
    )

    if (response.ok) {
      return NextResponse.json(normalizeChapterStats(data, id, chapterNum))
    }

    if (canUseChapterFallback(response.status)) {
      const stats = await loadStatsFromBookDetail(id, chapterNum, req)
      if (stats) return NextResponse.json(stats)
      return NextResponse.json(emptyStats(id, chapterNum))
    }

    return NextResponse.json(data ?? {}, { status: response.status })
  } catch (error) {
    if (frontendFallbackEnabled()) {
      const stats = await loadStatsFromBookDetail(id, chapterNum, req).catch(
        () => undefined,
      )
      return NextResponse.json(stats ?? emptyStats(id, chapterNum))
    }
    return backendUnavailable(error)
  }
}

async function loadStatsFromBookDetail(
  id: string,
  chapterNum: number,
  req: Request,
): Promise<ChapterStats | undefined> {
  const { response, data } = await backendJSON(
    `/api/v1/books/${encodeURIComponent(id)}`,
    req,
  )
  if (!response.ok) return undefined

  const chapter = normalizeChapters(data, id).find((item) => item.num === chapterNum)
  if (!chapter) return undefined

  return normalizeChapterStats(
    {
      stats: {
        bookId: id,
        chapterNum,
        currentWords: chapter.words,
        thisRunWords: chapter.words,
        chapterTarget: 3000,
      },
    },
    id,
    chapterNum,
  )
}

function emptyStats(id: string, chapterNum: number): ChapterStats {
  return {
    bookId: id,
    chapterNum,
    currentWords: 0,
    todayMinutes: 0,
    todaySeconds: 0,
    chapterTarget: 0,
    thisRunWords: 0,
    chapterPct: 0,
  }
}

function canUseChapterFallback(status: number) {
  if (!frontendFallbackEnabled()) return false
  return status === 404 || status === 405 || status === 501 || status >= 500
}
