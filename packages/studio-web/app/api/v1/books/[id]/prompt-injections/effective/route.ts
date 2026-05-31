import { proxyJSON } from "@/lib/api/facade"

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  return proxyJSON(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/prompt-injections/effective`,
  )
}
