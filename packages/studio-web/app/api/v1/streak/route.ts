import { proxyJSON } from "@/lib/api/facade"

/**
 * GET /api/v1/streak —— 写作打卡热力图(GitHub 贡献图风格)+ 连更里程碑。
 * 桌面与 SaaS 登录用户都能用:读当前工作区聚合 calendar/currentStreak/longestStreak/todayWords。
 * SaaS 命中 3/7/14/30 连更里程碑且未领过 → 后端 withBillingLock 内发软配额,返回 newlyRewarded 供前端庆祝。
 * 桌面 saas:false,只返回热力图数据,不送 credits。门禁/发放/幂等全在后端。
 */
export async function GET(req: Request) {
  return proxyJSON(req, "/api/v1/streak")
}
