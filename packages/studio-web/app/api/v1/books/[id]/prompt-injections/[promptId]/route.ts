import { proxyJSON } from "@/lib/api/facade"

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; promptId: string }> },
) {
  const { id, promptId } = await params
  return proxyJSON(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/prompt-injections/${encodeURIComponent(promptId)}`,
    { method: "PATCH" },
  )
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; promptId: string }> },
) {
  const { id, promptId } = await params
  return proxyJSON(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/prompt-injections/${encodeURIComponent(promptId)}`,
    { method: "DELETE" },
  )
}
