import { proxyJSON } from "@/lib/api/facade"

export async function GET(req: Request) {
  return proxyJSON(req, "/api/v1/sessions")
}

export async function POST(req: Request) {
  return proxyJSON(req, "/api/v1/sessions", { method: "POST" })
}
