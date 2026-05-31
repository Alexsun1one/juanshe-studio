import { NextResponse } from "next/server"

import { backendUnavailable } from "@/lib/api/facade"
import { jsonOK } from "@/lib/api/route-helpers"
import { loadLLMProvider, updateLLMProvider } from "../providers-adapter"

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    const provider = await loadLLMProvider(req, id)
    if (!provider) {
      return NextResponse.json({ error: "not found" }, { status: 404 })
    }
    return jsonOK(provider)
  } catch (error) {
    return backendUnavailable(error)
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    return jsonOK(await updateLLMProvider(req, id))
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    )
  }
}
