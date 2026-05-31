import { NextResponse } from "next/server"

import {
  backendJSON,
  backendUnavailable,
  bilingual,
  isRecord,
  readJsonBody,
  standardError,
} from "@/lib/api/facade"
import { toBackendAgentId } from "@/lib/api/agent-aliases"

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = await readJsonBody(req)
  if (!isRecord(body)) {
    return NextResponse.json(standardError("INVALID_BODY", "Body must be a JSON object"), {
      status: 400,
    })
  }

  const bookId = typeof body.bookId === "string" ? body.bookId.trim() : ""
  if (!bookId) {
    return NextResponse.json(standardError("MISSING_BOOK_ID", "bookId is required"), {
      status: 400,
    })
  }

  const node = isRecord(body.node) ? body.node : {}
  const titleText = bilingual(body.title ?? node.title ?? node.id, String(node.id ?? "wiki node"))
  const nodeBody = typeof node.body === "string" ? node.body.trim() : ""
  const bodyText = typeof body.text === "string" ? body.text.trim() : ""
  const agent = toBackendAgentId(id)
  const chapterNumber = Number(body.chapterNumber ?? node.chapterNum ?? 0) || undefined
  const nodeId = typeof node.id === "string" ? node.id : undefined
  const nodeKind = typeof node.kind === "string" ? node.kind : undefined
  const text = bodyText || [
    `Wiki: ${titleText.zh}`,
    titleText.en && titleText.en !== titleText.zh ? `EN: ${titleText.en}` : "",
    nodeKind ? `Kind: ${nodeKind}` : "",
    nodeId ? `Node: ${nodeId}` : "",
    nodeBody,
  ].filter(Boolean).join("\n\n")

  if (!text.trim()) {
    return NextResponse.json(standardError("EMPTY_FEED", "Wiki feed text is empty"), {
      status: 400,
    })
  }

  const payload = {
    title: `Wiki -> ${agent}: ${titleText.zh}`.slice(0, 120),
    text,
    scope: "agent",
    agent,
    chapterNumber,
    priority: Number(body.priority ?? 80),
    expiresInMinutes: Number(body.expiresInMinutes ?? 240),
    reason: typeof body.reason === "string" ? body.reason : "Fed from Studio Web Wiki",
    target: {
      agent,
      source: "studio-web-wiki",
      nodeId,
      nodeKind,
      title: titleText.zh,
    },
  }

  try {
    const { response, data } = await backendJSON(
      `/api/v1/books/${encodeURIComponent(bookId)}/prompt-injections`,
      undefined,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    )

    return NextResponse.json(
      response.ok ? { ok: true, agentId: agent, bookId, result: data } : data,
      { status: response.status },
    )
  } catch (error) {
    return backendUnavailable(error)
  }
}
