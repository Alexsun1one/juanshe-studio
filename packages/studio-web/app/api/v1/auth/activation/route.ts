import { proxyJSONOrFallback } from "@/lib/api/facade"
import { jsonOK } from "@/lib/api/route-helpers"

/** GET /api/v1/auth/activation — 当前解锁状态(required / unlocked / 作者名 / 掩码) */
export async function GET(req: Request) {
  // 后端不可达时按"未要求激活、已解锁"降级,避免把用户锁在门外(单机直通)
  return proxyJSONOrFallback(
    req,
    "/api/v1/auth/activation",
    () => jsonOK({ required: false, unlocked: true, authorName: null, plan: null, codeMasked: null }),
    { timeoutMs: 8_000 },
  )
}

/** POST /api/v1/auth/deactivate(经由 /activation 复用)— 解除本机解锁 */
export async function DELETE(req: Request) {
  return proxyJSONOrFallback(
    req,
    "/api/v1/auth/deactivate",
    () => jsonOK({ ok: true }),
    { method: "POST", timeoutMs: 8_000 },
  )
}
