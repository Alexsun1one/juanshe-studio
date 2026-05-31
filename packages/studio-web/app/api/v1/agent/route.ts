import { proxyJSON } from "@/lib/api/facade"

// AI 助手(编辑部的猫)是 agentic 对话:读上下文 + 多轮 LLM + 可能委托 auditor/reviser 子智能体,
// 动辄一两分钟,默认 20s 远不够。给 5 分钟。
export async function POST(req: Request) {
  return proxyJSON(req, "/api/v1/agent", { method: "POST", timeoutMs: 300_000 })
}
