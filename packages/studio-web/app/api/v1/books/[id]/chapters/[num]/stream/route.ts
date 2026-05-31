import { proxySSE } from "@/lib/api/facade"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await params
  return proxySSE(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/chapters/${encodeURIComponent(num)}/stream`,
  )
}
