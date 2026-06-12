// ============================================================================
// agent-identity — 全站统一的「每个 agent 一个颜色」身份
// 一处定义,评审室 / 工作流连线 / 运行日志 / 实时流 全部复用,扫一眼就知道是谁在说话、动作到哪。
// 用黄金角相位轮转生成 15 个区分度高的色相 + 固定 oklch 明度/彩度 → 浅色/深色主题都清晰。
// alias-aware:后端 id(auditor/editor 等)经 toFrontendAgentId 归一后再取色,保证同一 agent 同色。
// ============================================================================
import { FRONTEND_AGENT_IDS, toFrontendAgentId } from "@/lib/api/agent-aliases"

// ── 编辑部人数的单一事实源(由 agent 清单 length 派生,严禁在文案里手写数字)──
// 调度链泳道 agent 数(15):工作流泳道/接力链等「链路」语境用它。
export const PIPELINE_AGENT_COUNT = FRONTEND_AGENT_IDS.length
// 编辑部对外口径(17 = 调度链 15 + 执行主编 + 总编):一切「编辑部几位编辑」的文案用它。
export const EDITORIAL_STAFF_COUNT = PIPELINE_AGENT_COUNT + 2

const GOLDEN_ANGLE = 137.508

// 规范 15 agent 按链路顺序取色:相邻 agent 用黄金角拉开色相,彼此最不易混。
const AGENT_HUE: Record<string, number> = {}
FRONTEND_AGENT_IDS.forEach((id, i) => {
  AGENT_HUE[id] = (i * GOLDEN_ANGLE) % 360
})

function hashHue(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return h % 360
}

function hueFor(rawId: string): number {
  const id = toFrontendAgentId(rawId)
  return AGENT_HUE[id] ?? hashHue(rawId)
}

/** 该 agent 的主色(用于头像、色点、连线、强调描边)。 */
export function agentColor(rawId: string): string {
  return `oklch(0.68 0.15 ${hueFor(rawId).toFixed(1)})`
}

/** 该 agent 的浅色底(用于消息气泡 / chip 背景),与主色同源,低饱和。 */
export function agentSoftBg(rawId: string, pct = 16): string {
  return `color-mix(in oklab, ${agentColor(rawId)} ${pct}%, transparent)`
}

/** 该 agent 的描边色(主色与边框混合,弱化但仍可辨识)。 */
export function agentBorder(rawId: string, pct = 40): string {
  return `color-mix(in oklab, ${agentColor(rawId)} ${pct}%, var(--border))`
}

/** 该来源是否是 15 个规范 agent 之一(用于决定是否上色;studio/system/model 等非 agent 来源走中性色)。 */
export function isAgentId(rawId: string): boolean {
  return (FRONTEND_AGENT_IDS as readonly string[]).includes(toFrontendAgentId(rawId))
}
