import { jsonOK } from "@/lib/api/route-helpers"
import { testLLMProvider } from "../../providers-adapter"

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    return jsonOK(await testLLMProvider(req, id))
  } catch {
    // 适配层已兜底;这是最后一道,确保这个 Next 路由在任何意外下都不冒 500。
    return jsonOK({
      ok: false,
      error: "测试时服务端出错,请稍后重试;若反复出现,检查 Base URL、模型名与协议类型。",
    })
  }
}
