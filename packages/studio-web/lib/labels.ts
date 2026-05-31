/**
 * 把后端的原始枚举 / 键名翻成友好中文,绝不在 UI 里直接暴露
 * note_1 / Current Goal / HIGH / openai-compatible / persist 之类。
 * 跨页面复用;页面专属、只用一次的标签就近放各自文件。
 * 约定:命中字典→中文;未命中→原样返回(可能本来就是中文/自然语言)。
 */
import { toFrontendAgentId } from "@/lib/api/agent-aliases"

// —— Agent 友好中文名(给实时流/日志/裁决等处用,绝不暴露 writer-001 这种内部 id)——
const AGENT_NAME: Record<string, string> = {
  "market-radar": "市场雷达",
  radar: "市场雷达",
  architect: "架构师",
  "setup-auditor": "建书复审官",
  "foundation-reviewer": "建书复审官",
  planner: "规划师",
  writer: "写手",
  composer: "写手",
  editor: "审稿官",
  auditor: "审稿官",
  reviser: "修稿师",
  "word-steward": "字数治理官",
  "length-normalizer": "字数治理官",
  polisher: "润色师",
  "chapter-analyst": "章节分析官",
  "chapter-analyzer": "章节分析官",
  "state-verifier": "状态校验员",
  "state-validator": "状态校验员",
  "style-fingerprint": "风格指纹官",
  "style-governor": "风格指纹官",
  "reader-critic": "读者评审官",
  "quality-report": "质量报告官",
  "quality-reporter": "质量报告官",
  "prompt-steward": "提示词治理官",
  "prompt-governor": "提示词治理官",
  "editor-in-chief": "总编",
  "executive-editor": "执行主编",
  "managing-editor": "执行主编",
}
export function agentDisplayName(id: string | undefined | null, fallback = "智能体"): string {
  const raw = String(id ?? "").trim()
  if (!raw) return fallback
  return AGENT_NAME[raw] ?? AGENT_NAME[toFrontendAgentId(raw)] ?? fallback
}

// —— 故事图谱:状态 / 关系谓词 ——
const PREDICATE_LABEL: Record<string, string> = {
  "current goal": "当前目标",
  goal: "目标",
  location: "所在位置",
  position: "所在位置",
  status: "状态",
  state: "状态",
  condition: "状态",
  relationship: "关系",
  affiliation: "所属阵营",
  faction: "阵营",
  occupation: "身份",
  identity: "身份",
  alias: "别名",
  mood: "心境",
  emotion: "心境",
  title: "称号",
  ability: "能力",
  skill: "能力",
  // 关系型谓词(英文键 → 中文)
  ally: "盟友",
  allies: "盟友",
  enemy: "敌对",
  enemies: "敌对",
  friend: "朋友",
  mentor: "师傅",
  master: "师傅",
  teacher: "师傅",
  student: "弟子",
  disciple: "弟子",
  apprentice: "弟子",
  parent: "亲长",
  child: "晚辈",
  sibling: "手足",
  spouse: "配偶",
  lover: "恋人",
  rival: "对手",
  colleague: "同僚",
  subordinate: "下属",
  superior: "上级",
  knows: "认识",
  owns: "拥有",
  located_in: "位于",
  member_of: "隶属",
}

export function predicateLabel(input: string | undefined | null): string {
  const raw = String(input ?? "").trim()
  if (!raw) return ""
  const note = raw.match(/^note[_-]?(\d+)$/i)
  if (note) return `备注 ${note[1]}`
  if (/^note$/i.test(raw)) return "备注"
  return PREDICATE_LABEL[raw.toLowerCase()] ?? raw
}

// —— 问题严重度 ——
const SEVERITY_LABEL: Record<string, string> = {
  critical: "严重",
  block: "阻断",
  blocker: "阻断",
  high: "高",
  error: "错误",
  med: "中",
  medium: "中",
  warning: "警告",
  warn: "警告",
  low: "低",
  minor: "轻微",
  info: "提示",
  note: "提示",
}
export function severityLabel(input: string | undefined | null): string {
  const raw = String(input ?? "").trim()
  if (!raw) return ""
  return SEVERITY_LABEL[raw.toLowerCase()] ?? raw
}

// —— 质量分档(band)——
const BAND_LABEL: Record<string, string> = {
  excellent: "优秀",
  great: "优秀",
  good: "良好",
  fair: "中等",
  ok: "中等",
  pass: "及格",
  weak: "偏弱",
  poor: "薄弱",
  fail: "未达标",
  a: "优秀",
  b: "良好",
  c: "中等",
  d: "偏弱",
  e: "薄弱",
}
export function bandLabel(input: string | undefined | null): string {
  const raw = String(input ?? "").trim()
  if (!raw) return ""
  return BAND_LABEL[raw.toLowerCase()] ?? raw
}

// —— LLM 服务类型 ——
const PROVIDER_KIND_LABEL: Record<string, string> = {
  "openai-compatible": "OpenAI 兼容",
  openai: "OpenAI",
  anthropic: "Anthropic",
  claude: "Anthropic",
  google: "Google",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  ollama: "Ollama",
  custom: "自定义",
}
export function providerKindLabel(input: string | undefined | null): string {
  const raw = String(input ?? "").trim()
  if (!raw) return ""
  return PROVIDER_KIND_LABEL[raw.toLowerCase()] ?? raw
}

// —— 裁决 / 评审结论 ——
const VERDICT_LABEL: Record<string, string> = {
  pass: "通过",
  passed: "通过",
  approve: "通过",
  approved: "已签发",
  ok: "通过",
  rework: "建议返工",
  revise: "建议返工",
  fail: "未通过",
  failed: "未通过",
  reject: "驳回",
  hold: "观望",
  recommend: "推荐",
  strong: "强力推荐",
  weak: "偏弱",
}
export function verdictLabel(input: string | undefined | null): string {
  const raw = String(input ?? "").trim()
  if (!raw) return ""
  return VERDICT_LABEL[raw.toLowerCase()] ?? raw
}

// —— 管线阶段 ——
const STAGE_LABEL: Record<string, string> = {
  prepare: "规划",
  plan: "规划",
  generate: "生成",
  write: "撰写",
  review: "审校",
  audit: "审校",
  revise: "修订",
  polish: "润色",
  persist: "落库",
  publish: "发布",
  analyze: "分析",
  validate: "校验",
  idle: "待命",
  done: "完成",
  error: "失败",
}
export function stageLabel(input: string | undefined | null): string {
  const raw = String(input ?? "").trim()
  if (!raw) return ""
  return STAGE_LABEL[raw.toLowerCase()] ?? raw
}

// —— 生命周期事件 → 角色 + 人话动作 ——
// 后端发的是 `<阶段>:<状态>`(write:start / quality-batch:needs-repair / audit:start …)。
// 把它翻成"谁在做什么"(开始撰写 / 质量校验需返修),并推断出该署名给哪个角色,
// 让"编辑部接力"显示真实步骤,而不是泄漏 write:start / "状态更新" 这种原始键。
// 未命中的阶段一律返回空文本 → 调用方据此抑制(绝不把 raw key 推到前台)。
const PHASE_ROLE: Record<string, { agent: string; verb: string }> = {
  plan: { agent: "planner", verb: "规划" },
  prepare: { agent: "planner", verb: "准备上下文" },
  write: { agent: "writer", verb: "撰写" },
  rewrite: { agent: "reviser", verb: "改写" },
  revise: { agent: "reviser", verb: "修订" },
  polish: { agent: "polisher", verb: "润色" },
  audit: { agent: "auditor", verb: "连续性审校" },
  review: { agent: "auditor", verb: "审校" },
  quality: { agent: "quality-report", verb: "质量校验" },
  "quality-batch": { agent: "quality-report", verb: "质量校验" },
  style: { agent: "style-fingerprint", verb: "风格处理" },
  state: { agent: "state-verifier", verb: "状态校验" },
  "state-repair": { agent: "state-verifier", verb: "状态修复" },
  chapter: { agent: "chapter-analyst", verb: "章节分析" },
  batch: { agent: "managing-editor", verb: "批量写作" },
  workflow: { agent: "managing-editor", verb: "流水线" },
}
function composeAction(verb: string, status: string): string {
  switch (status) {
    case "start": case "begin": return `开始${verb}`
    case "complete": case "done": case "end": case "ok": return `${verb}完成`
    case "running": case "progress": return `${verb}中`
    case "needs-repair": case "quality-repair": return `${verb}需返修`
    case "repair": return `${verb}返修中`
    case "error": case "failed": return `${verb}出错`
    case "blocked-quality-gate": return "卡在质量线下"
    case "blocked-foundation": return "卡在地基缺失"
    case "stale": return "疑似停滞"
    case "stopped": return "已停止"
    case "status": case "update": return verb
    default: return verb
  }
}
export function describeStage(input: string | undefined | null): { text: string; agentId?: string } {
  const raw = String(input ?? "").trim()
  if (!raw || raw === "状态更新") return { text: "" }
  // 复合串 "a · b · c":逐段解析,取第一个有意义的
  if (raw.includes(" · ")) {
    for (const seg of raw.split(" · ").map((s) => s.trim())) {
      const d = describeStage(seg)
      if (d.text) return d
    }
    return { text: "" }
  }
  // `<阶段>:<状态>`
  const m = raw.match(/^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)$/i)
  if (m) {
    const role = PHASE_ROLE[m[1].toLowerCase()]
    if (role) return { text: composeAction(role.verb, m[2].toLowerCase()), agentId: role.agent }
    return { text: "" }
  }
  // 纯阶段枚举:命中字典才显示,否则抑制(不泄漏未知 raw key)
  const low = raw.toLowerCase()
  if (STAGE_LABEL[low]) return { text: STAGE_LABEL[low] }
  if (PHASE_ROLE[low]) return { text: PHASE_ROLE[low].verb, agentId: PHASE_ROLE[low].agent }
  return { text: "" }
}

// —— 章节号格式化:"Ch.4" / 4 / "4" → "第 4 章" ——
export function formatChapter(input: string | number | undefined | null): string {
  if (input == null || input === "") return ""
  const n = typeof input === "number" ? String(input) : String(input).match(/\d+/)?.[0]
  return n ? `第 ${n} 章` : String(input)
}
