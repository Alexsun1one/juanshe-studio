import { jsonOK } from "@/lib/api/route-helpers"
import { testLLMProvider } from "../../providers-adapter"

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  return jsonOK(await testLLMProvider(req, id))
}
