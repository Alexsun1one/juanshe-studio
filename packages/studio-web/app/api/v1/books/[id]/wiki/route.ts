import { NextResponse } from "next/server"
import { normalizeWikiResponse } from "@/lib/api/backend-transforms"
import { backendJSON } from "@/lib/api/facade"
import { findBookSummary } from "@/lib/books"
import { getWiki } from "@/lib/studio-store"

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { response, data } = await backendJSON(
    `/api/v1/books/${encodeURIComponent(id)}/wiki`,
    req,
  )

  if (!response.ok) {
    if (findBookSummary(id)) return NextResponse.json(getWiki(id))
    return NextResponse.json(data ?? {}, { status: response.status })
  }

  return NextResponse.json(normalizeWikiResponse(data))
}
