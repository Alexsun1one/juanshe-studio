import { NextResponse } from "next/server"

import { backendUnavailable } from "@/lib/api/facade"
import { jsonOK } from "@/lib/api/route-helpers"
import { createLLMProvider, loadLLMProviders } from "./providers-adapter"

export async function GET(req: Request) {
  try {
    return jsonOK(await loadLLMProviders(req))
  } catch (error) {
    return backendUnavailable(error)
  }
}

export async function POST(req: Request) {
  try {
    return NextResponse.json(await createLLMProvider(req), {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    })
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
