import { NextResponse } from "next/server"
import { normalizeManuscript } from "@/lib/api/backend-transforms"
import {
  backendJSON,
  backendUnavailable,
  frontendFallbackEnabled,
  proxyJSONOrFallback,
  readJsonBody,
} from "@/lib/api/facade"
import {
  getManualManuscript,
  saveManualManuscript,
} from "@/lib/api/manual-manuscripts"
import type { Manuscript } from "@/lib/api/types"

/**
 * GET /api/v1/books/:id/chapters/:num/manuscript — 章节正文段落（流式快照）
 *
 * 返回当前章节已落库的全部段落数组。前端配合 SSE 的 token / paragraph-done
 * 事件做流式追加；这个 endpoint 用于初次加载和重连时恢复。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  const chapterNum = Number(num)
  const manual = getManualManuscript(id, chapterNum)
  if (manual) return NextResponse.json(manual)

  try {
    const { response, data } = await backendJSON(
      `/api/v1/books/${encodeURIComponent(id)}/chapters/${chapterNum}/manuscript`,
      req,
    )

    if (response.ok) {
      return NextResponse.json(normalizeManuscript(data, id, chapterNum))
    }

    if (canUseManuscriptFallback(response.status)) {
      const manuscript = await loadManuscriptFromChapterDetail(id, chapterNum, req)
      return NextResponse.json(manuscript ?? emptyManuscript(id, chapterNum))
    }

    return NextResponse.json(data ?? {}, { status: response.status })
  } catch (error) {
    if (frontendFallbackEnabled()) {
      const manuscript = await loadManuscriptFromChapterDetail(
        id,
        chapterNum,
        req,
      ).catch(() => undefined)
      return NextResponse.json(manuscript ?? emptyManuscript(id, chapterNum))
    }
    return backendUnavailable(error)
  }
}

async function loadManuscriptFromChapterDetail(
  id: string,
  chapterNum: number,
  req: Request,
) {
  const { response, data } = await backendJSON(
    `/api/v1/books/${encodeURIComponent(id)}/chapters/${chapterNum}`,
    req,
  )
  if (!response.ok) return undefined
  return normalizeManuscript({ manuscript: data }, id, chapterNum)
}

function emptyManuscript(id: string, chapterNum: number): Manuscript {
  return {
    bookId: id,
    chapterNum,
    paragraphs: [],
    cursorParagraph: 0,
  }
}

function canUseManuscriptFallback(status: number) {
  if (!frontendFallbackEnabled()) return false
  return status === 404 || status === 405 || status === 501 || status >= 500
}

/**
 * PATCH /api/v1/books/:id/chapters/:num/manuscript — 手写接管后保存整章正文。
 *
 * 优先转发真实后端；如果后端还没有这个写入端点，则在 Studio Web 进程内保存
 * 当前章节覆盖稿，保证刷新后仍然能读到刚写的内容。
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await ctx.params
  const chapterNum = Number(num)
  const body = await readJsonBody(req)
  const content = typeof body.content === "string" ? body.content : ""
  const locale = body.locale === "en" ? "en" : "zh"

  if (!content.trim()) {
    return NextResponse.json(
      { ok: false, error: "正文为空，不能保存当前章节。" },
      { status: 400 },
    )
  }

  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/chapters/${chapterNum}/manuscript`,
    () =>
      NextResponse.json(
        saveManualManuscript({ bookId: id, chapterNum, content, locale }),
      ),
    {
      method: "PATCH",
      body,
      transform: (data) => normalizeManuscript(data, id, chapterNum),
    },
  )
}
