import { proxyJSONOrFallback } from "@/lib/api/facade"
import { NextResponse } from "next/server"

/** GET /api/v1/content-drafts — 已生成的多平台成品库(后端真实落盘) */
export async function GET(req: Request) {
  return proxyJSONOrFallback(
    req,
    "/api/v1/content-drafts",
    () => NextResponse.json({ drafts: [], total: 0 }),
  )
}
