import { proxyJSON } from "@/lib/api/facade"

/** GET /api/v1/admin/codes — 列已发码(admin 全显明文 + 状态)。 */
export async function GET(req: Request) {
  return proxyJSON(req, "/api/v1/admin/codes")
}

/**
 * POST /api/v1/admin/codes — 发码(tier + 可选 expiresInDays → expiresAt)。
 * 返回明文码;门禁在后端。
 */
export async function POST(req: Request) {
  return proxyJSON(req, "/api/v1/admin/codes", { method: "POST" })
}
