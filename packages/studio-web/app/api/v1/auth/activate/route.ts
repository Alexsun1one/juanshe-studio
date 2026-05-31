import { proxyJSON } from "@/lib/api/facade"

/** POST /api/v1/auth/activate — 校验激活码、设置作者名,解锁记录落在后端工作区 .autow/activation.json */
export async function POST(req: Request) {
  return proxyJSON(req, "/api/v1/auth/activate", { method: "POST", timeoutMs: 12_000 })
}
