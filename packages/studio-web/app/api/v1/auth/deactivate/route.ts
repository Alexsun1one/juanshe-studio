import { proxyJSON } from "@/lib/api/facade"

/** POST /api/v1/auth/deactivate — 注销当前激活(后端把 .autow/activation.json 置 unlocked=false)。
    前端「退出登录 / 切换激活码」走这里;再清本地 cj.* 身份并跳回 /login。 */
export async function POST(req: Request) {
  return proxyJSON(req, "/api/v1/auth/deactivate", { method: "POST", timeoutMs: 8_000 })
}
