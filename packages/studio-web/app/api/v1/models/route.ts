import { proxyJSON } from "@/lib/api/facade"

/** GET /api/v1/models — model catalog facade */
export async function GET(req: Request) {
  return proxyJSON(req, "/api/v1/models")
}
