import { proxyJSONOrFallback } from "@/lib/api/facade"
import { jsonOK } from "@/lib/api/route-helpers"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * 流式中断恢复:代理后端「当前在写章节的已累计正文」快照。
 * useLiveRun 在 SSE 订阅建立 / 断线重连时拉一次,把半章正文种回打字机。
 * 后端不可达时回空快照 —— 前端按「无在写草稿」处理,实时流照常订阅。
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/agents/live-draft`,
    () => jsonOK({ bookId: id, chapter: null, agentId: null, text: "", textLength: 0, updatedAt: null, completed: false }),
  )
}
