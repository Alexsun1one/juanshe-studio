import type { BookSummary } from "@/lib/api/types"
import { normalizeBookSummaries, normalizeChapters } from "@/lib/api/backend-transforms"
import { backendJSON, proxyJSON, proxyJSONOrFallback } from "@/lib/api/facade"
import { jsonOK } from "@/lib/api/route-helpers"

/** GET /api/v1/books */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const enrich = url.searchParams.get("enrich")
  const shouldEnrich = enrich === "1" || enrich === "true"

  return proxyJSONOrFallback(req, "/api/v1/books", () => jsonOK([]), {
    transform: (data) =>
      shouldEnrich
        ? enrichBookSummaries(data, req)
        : normalizeBookSummaries(data),
  })
}

/** POST /api/v1/books — 创建真实后端书籍 */
export async function POST(req: Request) {
  return proxyJSON(req, "/api/v1/books/create", { method: "POST" })
}

async function enrichBookSummaries(data: unknown, req: Request) {
  const summaries = normalizeBookSummaries(data)
  return Promise.all(summaries.map((book) => enrichBookSummary(book, req)))
}

async function enrichBookSummary(book: BookSummary, req: Request): Promise<BookSummary> {
  try {
    const chapters = await loadBackendChapters(book.id, req)
    if (!chapters.length) return book

    const totalWords = chapters.reduce((sum, chapter) => sum + chapter.words, 0)
    const latestChapter = Math.max(...chapters.map((chapter) => chapter.num), book.currentChapter)
    const currentChapter = Math.max(book.currentChapter, latestChapter)
    const chapterCount = Math.max(book.chapterCount, chapters.length)

    return {
      ...book,
      totalWords: totalWords || book.totalWords,
      chapterCount,
      currentChapter,
      currentChapterPct: book.plannedChapters > 0
        ? currentChapter / book.plannedChapters
        : book.currentChapterPct,
    }
  } catch {
    return book
  }
}

async function loadBackendChapters(bookId: string, req: Request) {
  const encodedId = encodeURIComponent(bookId)
  const paths = [
    `/api/v1/books/${encodedId}/chapters`,
    `/api/v1/books/${encodedId}`,
  ]

  for (const path of paths) {
    const { response, data } = await backendJSON(path, req)
    if (!response.ok) continue

    const chapters = normalizeChapters(data, bookId)
    if (chapters.length) return chapters
  }

  return []
}
