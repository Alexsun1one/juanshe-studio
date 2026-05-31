import { okRunResult } from "@/lib/api/action-results"
import { isRecord, proxyJSON } from "@/lib/api/facade"

/** POST /api/v1/books/:id/write-next — 智能一键续写，后端负责质检与自动复修 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSON(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/write-next`,
    {
      method: "POST",
      timeoutMs: 120_000,
      transform: (data) => normalizeWriteNextResult(data, id),
    },
  )
}

function normalizeWriteNextResult(data: unknown, bookId: string) {
  const payload = isRecord(data) ? data : {}
  const result = okRunResult(payload, "write")
  return {
    ...payload,
    ...result,
    bookId: typeof payload.bookId === "string" ? payload.bookId : bookId,
    status: typeof payload.status === "string" ? payload.status : "queued",
    chapterNumber:
      typeof payload.chapterNumber === "number"
        ? payload.chapterNumber
        : undefined,
  }
}
