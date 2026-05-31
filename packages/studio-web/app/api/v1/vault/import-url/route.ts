import { proxyJSON } from "@/lib/api/facade"

export async function POST(req: Request) {
  return proxyJSON(req, "/api/v1/vault/import-url", { method: "POST" })
}
