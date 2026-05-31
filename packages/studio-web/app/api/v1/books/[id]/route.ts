import { findBookSummary, toBook } from "@/lib/books"
import { CHAPTERS, CHAPTER_STATS } from "@/lib/studio-data"
import { normalizeBookDetail } from "@/lib/api/backend-transforms"
import { proxyJSON, proxyJSONOrFallback } from "@/lib/api/facade"
import { delay, jsonErr, jsonOK } from "@/lib/api/route-helpers"

/** GET /api/v1/books/:id */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}`,
    async () => {
      await delay()
      const book = findBookSummary(id)
      if (!book) return jsonErr("BOOK_NOT_FOUND", `Book not found: ${id}`, 404)

      return jsonOK(
        id === "book-instance-arrival"
          ? {
              ...toBook(book),
              totalWords: CHAPTER_STATS.currentWords,
              chapterCount: CHAPTERS.length,
              currentChapterPct: CHAPTER_STATS.chapterPct,
              updatedAt: new Date().toISOString(),
            }
          : toBook(book),
      )
    },
    { transform: (data) => normalizeBookDetail(data, id) },
  )
}

/** PATCH /api/v1/books/:id — Web 使用 PATCH，后端 CLI parity 使用 PUT */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  return proxyJSON(req, `/api/v1/books/${encodeURIComponent(id)}`, {
    method: "PUT",
    transform: (data) => normalizeBookDetail(data, id),
  })
}

/** DELETE /api/v1/books/:id — 删除整本书(含半成品):取消未完成工作流 + 删本地目录 */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  return proxyJSON(req, `/api/v1/books/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
}
