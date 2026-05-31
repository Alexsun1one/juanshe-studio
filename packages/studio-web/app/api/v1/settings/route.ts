import { proxyJSON } from "@/lib/api/facade"

/** GET /api/v1/settings — project and studio settings facade */
export async function GET(req: Request) {
  return proxyJSON(req, "/api/v1/settings")
}
