import { okRunResult } from "@/lib/api/action-results"
import { isRecord, proxyJSON } from "@/lib/api/facade"

/** POST /api/v1/books/:id/repair-quality-batch — 连续复修到目标分，再按需续写 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  return proxyJSON(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/repair-quality-batch`,
    {
      method: "POST",
      transform: (data) => normalizeRepairQualityBatchResult(data, id),
    },
  )
}

function normalizeRepairQualityBatchResult(data: unknown, bookId: string) {
  const payload = isRecord(data) ? data : {}
  const result = okRunResult(payload, "quality-batch-repair")
  return {
    ...payload,
    ...result,
    bookId: typeof payload.bookId === "string" ? payload.bookId : bookId,
    status:
      typeof payload.status === "string"
        ? payload.status
        : "quality-batch-repairing",
  }
}
