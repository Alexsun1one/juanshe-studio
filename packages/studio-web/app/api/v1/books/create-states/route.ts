import { proxyJSON } from "@/lib/api/facade"

/**
 * GET /api/v1/books/create-states
 * 代理到后端的轻量只读"所有当前/最近建书状态"列表(server.ts: bookCreateStatus 快照)。
 * 给侧栏「在建/在写」常驻指示器批量轮询用 —— 一次拿全,不用逐本打 create-status。
 * 必须放在 [id] 动态段之外:静态段在 Next App Router 里优先于 `[id]` 匹配。
 */
export async function GET(request: Request) {
  return proxyJSON(request, "/api/v1/books/create-states")
}
