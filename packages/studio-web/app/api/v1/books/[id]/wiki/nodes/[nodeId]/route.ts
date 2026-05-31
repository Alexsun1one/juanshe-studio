import { NextResponse } from "next/server"
import { updateWikiNode } from "@/lib/studio-store"

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  const { id, nodeId } = await params
  const body = await req.json().catch(() => ({}))
  const node = updateWikiNode(id, nodeId, body)
  if (!node) return NextResponse.json({ error: "not found" }, { status: 404 })
  return NextResponse.json(node)
}
