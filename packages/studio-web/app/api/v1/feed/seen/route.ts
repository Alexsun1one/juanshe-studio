import { proxyJSON } from "@/lib/api/facade"

/** POST /api/v1/feed/seen — 标记动态已读(后端写 user.feedSeenAt,withBillingLock 串行)。 */
export async function POST(req: Request) {
  return proxyJSON(req, "/api/v1/feed/seen", { method: "POST" })
}
