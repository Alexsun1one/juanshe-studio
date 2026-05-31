import { normalizeBookCreateStatus } from "@/lib/api/backend-transforms"
import { proxyJSON } from "@/lib/api/facade"

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  return proxyJSON(
    request,
    `/api/v1/books/${encodeURIComponent(id)}/create-status`,
    { transform: normalizeBookCreateStatus },
  )
}
