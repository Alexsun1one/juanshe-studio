// ----------------------------------------------------------------------
// 长卷写作台 — 假数据集中处（前端开发期使用，正式环境通过 API 拉取）
// 真实接口契约见 lib/api/types.ts 与 docs/API.md
// ----------------------------------------------------------------------

export type AgentStatus =
  | "running"
  | "idle"
  | "done"
  | "error"
  | "warning"
  | "paused"
  | "queued"

export type WorkflowStage =
  | "prepare"
  | "generate"
  | "review"
  | "revise"
  | "persist"
  | "publish"

export type Agent = {
  /** 后端唯一标识，与 API 对齐 */
  id: string
  /** 调度顺序号 1..15 */
  num: number
  name: { zh: string; en: string }
  role: { zh: string; en: string }
  /** 长描述（hover 显示） */
  desc: { zh: string; en: string }
  status: AgentStatus
  /** 0..1，心跳条幅度 / 当前负载 */
  load: number
  /** 所属工作流阶段 */
  stage: WorkflowStage
  /** 当前任务（可空） */
  currentTask?: { zh: string; en: string } | null
  /** 用于路由的模型 hint */
  modelHint: string
}

// ----------------------------------------------------------------------
// 15 位 agents — 严格按用户指定的调度链条
// 市场雷达 → 架构师 → 建书复审官 → 规划师 → 写手 → 审稿官 → 修稿师
// → 字数治理官 → 润色师 → 章节分析官 → 状态校验员 → 风格指纹官
// → 读者评审官 → 质量报告官 → 提示词治理官
// ----------------------------------------------------------------------
export const AGENTS: Agent[] = [
  {
    id: "market-radar",
    num: 1,
    name: { zh: "市场雷达", en: "Market Radar" },
    role: { zh: "趋势 · 拥挤度 · 题材洞察", en: "Trends · Saturation" },
    desc: { zh: "在立项前扫描热点与拥挤度，给出题材机会建议。", en: "Scans market trends before kickoff." },
    status: "done",
    load: 0.22,
    stage: "prepare",
    currentTask: { zh: "扫描赛博修仙赛道拥挤度", en: "Scanning genre saturation" },
    modelHint: "mimo-v2.5-pro",
  },
  {
    id: "architect",
    num: 2,
    name: { zh: "架构师", en: "Architect" },
    role: { zh: "世界观 · 大纲 · 设定骨架", en: "World · Outline" },
    desc: { zh: "构建世界观骨架、能力体系与主线脉络。", en: "Builds the macro structure of the book." },
    status: "running",
    load: 0.78,
    stage: "prepare",
    currentTask: { zh: "构建第 5 章场景骨架", en: "Building Ch.5 scaffold" },
    modelHint: "mimo-v2.5-pro",
  },
  {
    id: "setup-auditor",
    num: 3,
    name: { zh: "建书复审官", en: "Setup Auditor" },
    role: { zh: "立项风险 · 设定一致性", en: "Setup risk audit" },
    desc: { zh: "对架构师产出进行复审，发现立项早期的隐患。", en: "Audits the setup before drafting." },
    status: "done",
    load: 0.2,
    stage: "prepare",
    currentTask: null,
    modelHint: "mimo-v2.5-pro",
  },
  {
    id: "planner",
    num: 4,
    name: { zh: "规划师", en: "Planner" },
    role: { zh: "节奏 · 高潮 · 章节切分", en: "Pacing & Beats" },
    desc: { zh: "把大纲拆为章节级 beats，决定节奏与高潮分布。", en: "Pacing decisions per chapter." },
    status: "running",
    load: 0.55,
    stage: "generate",
    currentTask: { zh: "为第 5 章生成 7 个 beats", en: "Beats for Ch.5" },
    modelHint: "mimo-v2.5-pro",
  },
  {
    id: "writer",
    num: 5,
    name: { zh: "写手", en: "Writer" },
    role: { zh: "正文创作 · 流式生成", en: "Drafting · Streaming" },
    desc: { zh: "以规划师 beats 为输入，逐段流式产出正文。", en: "Streams prose paragraph by paragraph." },
    status: "running",
    load: 0.92,
    stage: "generate",
    currentTask: { zh: "续写第 5 章 · 拼图谜题段落", en: "Drafting Ch.5 puzzle scene" },
    modelHint: "mimo-v2.5-pro",
  },
  {
    id: "editor",
    num: 6,
    name: { zh: "审稿官", en: "Editor" },
    role: { zh: "逻辑连贯 · 章节打分", en: "Continuity & Score" },
    desc: { zh: "对写手段落做逻辑、连贯性、伏笔回收审查。", en: "Reviews logic & continuity." },
    status: "running",
    load: 0.45,
    stage: "review",
    currentTask: { zh: "校对第 5 章前 4 段连贯性", en: "Continuity for first 4 paras" },
    modelHint: "mimo-v2.5-pro",
  },
  {
    id: "reviser",
    num: 7,
    name: { zh: "修稿师", en: "Reviser" },
    role: { zh: "按审稿建议改稿", en: "Revise per editor notes" },
    desc: { zh: "依据审稿官输出，对正文做局部重写或微调。", en: "Applies editor patches." },
    status: "queued",
    load: 0.1,
    stage: "review",
    currentTask: null,
    modelHint: "mimo-v2.5-pro",
  },
  {
    id: "word-steward",
    num: 8,
    name: { zh: "字数治理官", en: "Word Steward" },
    role: { zh: "篇幅控制 · 节奏管理", en: "Length & Rhythm" },
    desc: { zh: "确保章节字数贴合目标，避免水文或过密。", en: "Keeps length on target." },
    status: "running",
    load: 0.3,
    stage: "revise",
    currentTask: { zh: "监控第 5 章篇幅 1284 / 5000", en: "Watching Ch.5 length" },
    modelHint: "mimo-v2.5-pro",
  },
  {
    id: "polisher",
    num: 9,
    name: { zh: "润色师", en: "Polisher" },
    role: { zh: "语感 · 韵律 · 修辞", en: "Prose polish" },
    desc: { zh: "做语感与韵律的微调，处理啰嗦或机械感。", en: "Refines prose rhythm." },
    status: "queued",
    load: 0.05,
    stage: "revise",
    currentTask: null,
    modelHint: "mimo-v2.5-pro",
  },
  {
    id: "chapter-analyst",
    num: 10,
    name: { zh: "章节分析官", en: "Chapter Analyst" },
    role: { zh: "结构 · 钩子 · 节奏分析", en: "Hooks & Beats" },
    desc: { zh: "完稿后做章节级结构与钩子分析。", en: "Post-write structural analysis." },
    status: "warning",
    load: 0.4,
    stage: "revise",
    currentTask: { zh: "检测到本章高潮不足", en: "Climax weak warning" },
    modelHint: "mimo-v2.5-pro",
  },
  {
    id: "state-verifier",
    num: 11,
    name: { zh: "状态校验员", en: "State Verifier" },
    role: { zh: "设定一致性 · 状态校验", en: "Lore consistency" },
    desc: { zh: "查验角色状态、设定、世界规则是否前后一致。", en: "Cross-checks lore." },
    status: "idle",
    load: 0.12,
    stage: "persist",
    currentTask: null,
    modelHint: "mimo-v2.5-pro",
  },
  {
    id: "style-fingerprint",
    num: 12,
    name: { zh: "风格指纹官", en: "Style Fingerprint" },
    role: { zh: "文风一致性 · 指纹比对", en: "Style fingerprint" },
    desc: { zh: "用作者风格指纹比对当前章节，发现风格漂移。", en: "Detects style drift." },
    status: "idle",
    load: 0.08,
    stage: "persist",
    currentTask: null,
    modelHint: "mimo-v2.5-pro",
  },
  {
    id: "reader-critic",
    num: 13,
    name: { zh: "读者评审官", en: "Reader Critic" },
    role: { zh: "读者代入感 · 拐点感受", en: "Reader pulse" },
    desc: { zh: "模拟目标读者群的阅读反馈。", en: "Simulates reader response." },
    status: "idle",
    load: 0.1,
    stage: "publish",
    currentTask: null,
    modelHint: "mimo-v2.5-pro",
  },
  {
    id: "quality-report",
    num: 14,
    name: { zh: "质量报告官", en: "Quality Report" },
    role: { zh: "综合评分 · 落库报告", en: "Final QA report" },
    desc: { zh: "汇总各 agent 输出，给出最终落库评分。", en: "Aggregates QA scores." },
    status: "idle",
    load: 0.5,
    stage: "publish",
    currentTask: null,
    modelHint: "mimo-v2.5-pro",
  },
  {
    id: "prompt-steward",
    num: 15,
    name: { zh: "提示词治理官", en: "Prompt Steward" },
    role: { zh: "提示词审计 · 在线优化", en: "Prompt audit" },
    desc: { zh: "对前 14 位 agent 的提示词做版本化审计。", en: "Audits prompt versions." },
    status: "idle",
    load: 0.05,
    stage: "publish",
    currentTask: null,
    modelHint: "mimo-v2.5-pro",
  },
  {
    id: "managing-editor",
    num: 16,
    name: { zh: "执行主编", en: "Managing Editor" },
    role: { zh: "编排 · 调度 · 返工循环", en: "Orchestration · Routing" },
    desc: { zh: "决定下一步调哪个 agent、追踪稿件状态、管理返工循环与人审节点。", en: "Conducts the workflow: routing, status, rework loops." },
    status: "idle",
    load: 0.3,
    stage: "prepare",
    currentTask: null,
    modelHint: "确定性编排",
  },
  {
    id: "editor-in-chief",
    num: 17,
    name: { zh: "总编", en: "Editor-in-Chief" },
    role: { zh: "整章裁决 · 总编批语 · 方向", en: "Verdict · Note · Direction" },
    desc: { zh: "读全部专家信号做通过/返工裁决,写总编批语并给规划师下一程方向。", en: "Reads all signals to give a pass/rework verdict, note, and next direction." },
    status: "idle",
    load: 0.4,
    stage: "publish",
    currentTask: null,
    modelHint: "deepseek-v4-pro",
  },
]

// ----------------------------------------------------------------------
// 工作流 6 阶段（与 config.yaml 一致）
// ----------------------------------------------------------------------
export type Stage = {
  id: WorkflowStage
  name: { zh: string; en: string }
  /** 此阶段动态参与的 agent ids（顺序即上场顺序） */
  agentIds: string[]
}

export const WORKFLOW_STAGES: Stage[] = [
  { id: "prepare", name: { zh: "准备", en: "Prepare" }, agentIds: ["market-radar", "architect", "setup-auditor"] },
  { id: "generate", name: { zh: "生成", en: "Generate" }, agentIds: ["planner", "writer"] },
  { id: "review", name: { zh: "审稿", en: "Review" }, agentIds: ["editor", "reviser"] },
  { id: "revise", name: { zh: "修订", en: "Revise" }, agentIds: ["word-steward", "polisher", "chapter-analyst"] },
  { id: "persist", name: { zh: "落库", en: "Persist" }, agentIds: ["state-verifier", "style-fingerprint"] },
  { id: "publish", name: { zh: "发布", en: "Publish" }, agentIds: ["reader-critic", "quality-report", "prompt-steward"] },
]

export type WorkflowVariant = "foundation" | "continuation"

const FOUNDATION_ONLY_AGENT_IDS = new Set([
  "market-radar",
  "architect",
  "setup-auditor",
])

const CONTINUATION_PREPARE_AGENT_IDS = ["planner"]

export function isFoundationOnlyAgent(agentId?: string | null) {
  return Boolean(agentId && FOUNDATION_ONLY_AGENT_IDS.has(agentId))
}

export function workflowStagesForVariant(variant: WorkflowVariant): Stage[] {
  if (variant === "foundation") return WORKFLOW_STAGES

  return WORKFLOW_STAGES.map((stage) =>
    stage.id === "prepare"
      ? { ...stage, agentIds: CONTINUATION_PREPARE_AGENT_IDS }
      : stage,
  )
}

export function agentsForWorkflowVariant(variant: WorkflowVariant): Agent[] {
  const agentsById = new Map(AGENTS.map((agent) => [agent.id, agent]))

  return workflowStagesForVariant(variant)
    .flatMap((stage) => stage.agentIds)
    .map((id) => agentsById.get(id))
    .filter((agent): agent is Agent => Boolean(agent))
}

// ----------------------------------------------------------------------
// 章节
// ----------------------------------------------------------------------
export type Chapter = {
  id: string
  num: number
  title: { zh: string; en: string }
  words: number
  /** audit-failed:复修预算耗尽仍带硬违规落盘(core 落盘门禁判的「待修硬伤」章),前端必须可见 */
  status: "draft" | "writing" | "done" | "queued" | "review" | "published" | "audit-failed"
  active?: boolean
  /** 本章累计 LLM token 消耗(写作+审稿+修订全链),后端 tokenUsage.totalTokens */
  tokens?: number
}

export const CHAPTERS: Chapter[] = [
  { id: "c1", num: 1, title: { zh: "副本降临", en: "The Instance Arrives" }, words: 3210, status: "done" },
  { id: "c2", num: 2, title: { zh: "地图即力量", en: "Maps as Power" }, words: 2890, status: "done" },
  { id: "c3", num: 3, title: { zh: "新手副本", en: "The Beginner Dungeon" }, words: 3104, status: "done" },
  { id: "c4", num: 4, title: { zh: "手绘地图", en: "The Hand-Drawn Map" }, words: 2679, status: "done" },
  { id: "c5", num: 5, title: { zh: "裂隙回音初现", en: "Echoes of the Rift" }, words: 1284, status: "writing", active: true },
  { id: "c6", num: 6, title: { zh: "藏山河", en: "Hidden Rivers" }, words: 0, status: "draft" },
  { id: "c7", num: 7, title: { zh: "拼图者的低语", en: "The Puzzler's Whisper" }, words: 0, status: "draft" },
]

// ----------------------------------------------------------------------
// 派系（Faction）+ 角色（Cast）+ 关系图谱
// ----------------------------------------------------------------------
export type FactionId =
  | "order"
  | "black-tower"
  | "abyss"
  | "xuanmen"
  | "ash-mercs"
  | "free"

export type Faction = {
  id: FactionId
  name: { zh: string; en: string }
  /** 派系主色 — CSS 色值字符串 */
  color: string
  desc: { zh: string; en: string }
}

export const FACTIONS: Faction[] = [
  {
    id: "order",
    name: { zh: "守序方", en: "Order" },
    color: "var(--chart-1)",
    desc: { zh: "主角阵营，致力维持现有秩序", en: "Protagonist side." },
  },
  {
    id: "black-tower",
    name: { zh: "黑塔学会", en: "Black Tower" },
    color: "var(--chart-3)",
    desc: { zh: "知识与古老 AI 的研究学会", en: "Scholars of arcane AI." },
  },
  {
    id: "abyss",
    name: { zh: "深渊教团", en: "Abyss Cult" },
    color: "var(--chart-4)",
    desc: { zh: "信仰深渊回响的隐秘教团", en: "Cult of the abyssal echo." },
  },
  {
    id: "xuanmen",
    name: { zh: "玄门", en: "Xuanmen" },
    color: "var(--chart-5)",
    desc: { zh: "古老玄学一脉，立场中立", en: "Neutral mystic clan." },
  },
  {
    id: "ash-mercs",
    name: { zh: "灰烬佣兵", en: "Ash Mercs" },
    color: "var(--chart-2)",
    desc: { zh: "废土雇佣兵团，受雇深渊", en: "Hired by Abyss." },
  },
  {
    id: "free",
    name: { zh: "自由方", en: "Independents" },
    color: "var(--muted-foreground)",
    desc: { zh: "无固定阵营的浪人", en: "Unaligned." },
  },
]

export type Cast = {
  id: string
  name: { zh: string; en: string }
  role: { zh: string; en: string }
  arc: number
  /** 主导色，用于图谱节点（fallback to faction color） */
  color: string
  /** 重要度 1..5 */
  importance: number
  /** 所属派系（决定派系晕环 + 默认色） */
  factionId?: FactionId
  /** 副标题（hover 卡片用） */
  tagline?: { zh: string; en: string }
}

export const CAST: Cast[] = [
  {
    id: "lin",
    name: { zh: "林墨", en: "Lin Mo" },
    role: { zh: "主角 · 制图师", en: "Protagonist · Cartographer" },
    arc: 0.92,
    color: "var(--chart-1)",
    importance: 5,
    factionId: "order",
    tagline: { zh: "副本世界唯一拥有「地图编辑器」能力者", en: "Sole holder of the Map Editor." },
  },
  {
    id: "su",
    name: { zh: "苏璃", en: "Su Li" },
    role: { zh: "重要配角 · 黑塔学会", en: "Key ally · Black Tower" },
    arc: 0.71,
    color: "var(--chart-3)",
    importance: 4,
    factionId: "black-tower",
    tagline: { zh: "黑塔学会年轻执笔者，古典学派传人", en: "Young scribe of Black Tower." },
  },
  {
    id: "bai",
    name: { zh: "白夜", en: "Bai Ye" },
    role: { zh: "关键反派 · 深渊教团", en: "Antagonist · Abyss Cult" },
    arc: 0.55,
    color: "var(--chart-4)",
    importance: 5,
    factionId: "abyss",
    tagline: { zh: "曾是林墨同门，转投深渊", en: "Once an ally; turned to the Abyss." },
  },
  {
    id: "chen",
    name: { zh: "陈灼", en: "Chen Zhuo" },
    role: { zh: "配角 · 同伴", en: "Companion" },
    arc: 0.48,
    color: "var(--chart-2)",
    importance: 3,
    factionId: "free",
    tagline: { zh: "废土幸存者，林墨最早的同伴", en: "Wasteland survivor, earliest companion." },
  },
  {
    id: "akasha",
    name: { zh: "阿卡莎", en: "Akasha" },
    role: { zh: "重要配角 · AI 残影", en: "Key ally · AI echo" },
    arc: 0.42,
    color: "var(--chart-5)",
    importance: 4,
    factionId: "black-tower",
    tagline: { zh: "古老 AI 残影，疑似陈灼妹妹的数字遗存", en: "AI echo, possibly Chen's late sister." },
  },
  {
    id: "moxuan",
    name: { zh: "墨玄", en: "Mo Xuan" },
    role: { zh: "配角 · 玄门长老", en: "Elder · Xuanmen" },
    arc: 0.34,
    color: "var(--chart-3)",
    importance: 3,
    factionId: "xuanmen",
    tagline: { zh: "玄门长老，立场存疑", en: "Xuanmen elder; uncertain alignment." },
  },
  {
    id: "yiwan",
    name: { zh: "伊万", en: "Yiwan" },
    role: { zh: "配角 · 灰烬佣兵", en: "Ash mercenary" },
    arc: 0.28,
    color: "var(--chart-4)",
    importance: 3,
    factionId: "ash-mercs",
    tagline: { zh: "受雇于白夜的灰烬佣兵首领", en: "Ash merc captain hired by Bai." },
  },
]

export type RelationKind =
  | "ally"
  | "neutral"
  | "rival"
  | "subord"
  | "mentor"
  | "family"

export type Relation = {
  source: string
  target: string
  kind: RelationKind
  /** 强度 0..1，决定线宽与节点收缩距离 */
  strength: number
  label?: { zh: string; en: string }
  /** 来自书中的证据片段（章节 + 引文），供 hover 展示 */
  evidence?: {
    chapter: number
    quote?: { zh: string; en: string }
  }
  /** 关系是否经历过演变（如盟友→敌对） */
  evolved?: boolean
  /** 是否为最近活跃关系（用于流光动画） */
  active?: boolean
  /** 涉及到的章节（时间线用） */
  episodes?: number[]
  /** 关系建立 / 翻转的章节 */
  since?: number
}

export const RELATIONS: Relation[] = [
  {
    source: "lin",
    target: "su",
    kind: "ally",
    strength: 0.85,
    label: { zh: "盟友", en: "Ally" },
    evidence: {
      chapter: 3,
      quote: { zh: "林墨为苏璃挡下深渊触手", en: "Lin shields Su from the abyssal tendril." },
    },
    episodes: [3, 4, 5],
    since: 3,
    active: true,
  },
  {
    source: "lin",
    target: "akasha",
    kind: "ally",
    strength: 0.72,
    label: { zh: "合作", en: "Coop" },
    evidence: {
      chapter: 2,
      quote: { zh: "阿卡莎为林墨指引第一块地图碎片", en: "Akasha leads Lin to the first map shard." },
    },
    episodes: [2, 4, 5],
    since: 2,
  },
  {
    source: "lin",
    target: "chen",
    kind: "ally",
    strength: 0.6,
    label: { zh: "伙伴", en: "Partner" },
    evidence: { chapter: 1 },
    episodes: [1, 2, 3],
    since: 1,
  },
  {
    source: "lin",
    target: "moxuan",
    kind: "neutral",
    strength: 0.42,
    label: { zh: "中立", en: "Neutral" },
    evidence: {
      chapter: 4,
      quote: { zh: "墨玄拒绝林墨入门玄门", en: "Mo Xuan turns Lin away from Xuanmen." },
    },
    episodes: [4],
    since: 4,
  },
  {
    source: "lin",
    target: "bai",
    kind: "rival",
    strength: 0.92,
    label: { zh: "宿敌", en: "Nemesis" },
    evidence: {
      chapter: 5,
      quote: { zh: "白夜揭穿了林墨「地图编辑器」的来源", en: "Bai exposes the origin of Lin's Map Editor." },
    },
    episodes: [2, 5],
    since: 2,
    evolved: true,
    active: true,
  },
  {
    source: "lin",
    target: "yiwan",
    kind: "rival",
    strength: 0.68,
    label: { zh: "敌对", en: "Hostile" },
    evidence: { chapter: 5 },
    episodes: [5],
    since: 5,
  },
  // 派系内 / 配角间关系
  {
    source: "bai",
    target: "yiwan",
    kind: "subord",
    strength: 0.55,
    label: { zh: "雇佣", en: "Employs" },
    evidence: { chapter: 5 },
    episodes: [5],
    since: 5,
  },
  {
    source: "su",
    target: "akasha",
    kind: "ally",
    strength: 0.6,
    label: { zh: "盟友", en: "Ally" },
    episodes: [2, 4],
    since: 2,
  },
  {
    source: "moxuan",
    target: "chen",
    kind: "mentor",
    strength: 0.52,
    label: { zh: "师徒", en: "Mentor" },
    evidence: {
      chapter: 2,
      quote: { zh: "墨玄曾教陈灼一招护身术", en: "Mo Xuan once taught Chen a guarding stance." },
    },
    episodes: [2],
    since: 2,
  },
  {
    source: "akasha",
    target: "chen",
    kind: "family",
    strength: 0.7,
    label: { zh: "亲人(残影)", en: "Family (echo)" },
    evidence: {
      chapter: 2,
      quote: { zh: "阿卡莎是陈灼妹妹的 AI 数字残影", en: "Akasha is the digital echo of Chen's late sister." },
    },
    episodes: [2, 5],
    since: 2,
    evolved: true,
    active: true,
  },
]

// ----------------------------------------------------------------------
// 世界观节点 / 资产
// ----------------------------------------------------------------------
export type WorldNode = {
  id: string
  title: { zh: string; en: string }
  count: number
}

export const WORLD: WorldNode[] = [
  { id: "lore", title: { zh: "核心设定", en: "Core lore" }, count: 128 },
  { id: "events", title: { zh: "关键事件", en: "Key events" }, count: 312 },
  { id: "rels", title: { zh: "角色关系", en: "Relations" }, count: 86 },
  { id: "world", title: { zh: "世界观", en: "World" }, count: 234 },
]

export const ASSETS = [
  { id: "a1", name: { zh: "世界观主线.md", en: "world-main.md" }, type: "doc" },
  { id: "a2", name: { zh: "副本分级体系.md", en: "instance-tiers.md" }, type: "doc" },
  { id: "a3", name: { zh: "能量体系_源能与规则.md", en: "energy.md" }, type: "doc" },
  { id: "a4", name: { zh: "副本地图_雾海.png", en: "fog-sea-map.png" }, type: "image" },
  { id: "a5", name: { zh: "战斗节奏样本.md", en: "combat-pace.md" }, type: "doc" },
]

// ----------------------------------------------------------------------
// 记忆
// ----------------------------------------------------------------------
export type MemoryItem = {
  id: string
  text: { zh: string; en: string }
  chapter: number
  kind: "long" | "current" | "world"
}

export const MEMORIES: MemoryItem[] = [
  { id: "m1", text: { zh: "林墨已获得「地图编辑器」核心能力", en: "Lin gained the Map Editor ability" }, chapter: 1, kind: "long" },
  { id: "m2", text: { zh: "相遇的神秘少女身份未明，疑似关键人物", en: "Mystic girl identity unknown, likely key" }, chapter: 2, kind: "long" },
  { id: "m3", text: { zh: "「方寸之间，藏山河」可能与上古文明有关", en: "'Mountains within inches' may link to ancient lore" }, chapter: 5, kind: "current" },
  { id: "m4", text: { zh: "地图碎片的来源与世界本质相关", en: "Map shard source ties to world nature" }, chapter: 4, kind: "long" },
  { id: "m5", text: { zh: "磁感探测器在金属物附近会异常震动", en: "Magnetic detector reacts to metal" }, chapter: 5, kind: "current" },
  { id: "m6", text: { zh: "副本通道入口需要拼图状石片对齐", en: "Instance entry needs aligned puzzle stones" }, chapter: 5, kind: "world" },
  { id: "m7", text: { zh: "蓝星出现异变区域，开始浮现副本", en: "Blue Star anomaly zones spawn instances" }, chapter: 1, kind: "world" },
]

// ----------------------------------------------------------------------
// 流式手稿样本
// ----------------------------------------------------------------------
export const MANUSCRIPT_PARAGRAPHS: { zh: string; en: string; quote?: boolean }[] = [
  { zh: "林墨深吸一口气，指尖在冰冷的石壁上缓缓滑动。", en: "Lin Mo drew a slow breath, fingertips tracing the cold stone wall." },
  { zh: "「这通道……是拼图？」", en: "\"This passage… is a puzzle?\"", quote: true },
  { zh: "石壁上镶嵌着无数块形状各异的石片，边缘处隐约有凹槽与凸起，拼合处散发着极其微弱的光。", en: "Countless oddly shaped fragments lay embedded in the wall, edges hinting at notches, joints faintly glowing." },
  { zh: "他取出背包里的自制磁力探测器，靠近石片——仪器瞬间疯狂震动。", en: "He pulled out his hand-built detector, brought it close, and the needle went wild." },
  { zh: "「金属？」林墨皱眉，敲了敲石片。清脆的回响传来，像是空腔。", en: "\"Metal?\" he frowned and tapped — a hollow ring answered." },
  { zh: "他顺着石缝伸手探入，指尖触到一枚冰冷的金属圆环。拉出后，借着手电光一看，圆环上刻着一行极小的字：", en: "He reached into the crack and felt a cold ring. By flashlight he read tiny inscribed words:" },
  { zh: "方寸之间，藏山河。", en: "Mountains and rivers, hidden within inches.", quote: true },
  { zh: "「这谜题……有点意思了。」林墨勾起嘴角。", en: "\"Now this riddle… is interesting.\" A smile curled at his mouth." },
  { zh: "他将圆环收好，开始尝试移动其中一块石片。", en: "He pocketed the ring and tried sliding one of the fragments." },
  { zh: "石片没有想象中沉重，反而像被某种看不见的轨道托住，随着他的力道发出低低的摩擦声。", en: "The fragment was lighter than expected, as if held by an unseen rail, grinding softly under his hand." },
  { zh: "第一块归位时，整面石壁微微一震，雾气从缝隙里渗出来，带着潮湿的铁锈味。", en: "When the first piece clicked into place, the wall trembled and mist seeped through the seams, damp with rust." },
  { zh: "林墨没有急着继续。他退后半步，把手电压低，让斜光从石片边缘掠过去。", en: "Lin Mo did not rush. He stepped back and lowered the flashlight, letting the angled beam rake across the edges." },
  { zh: "在光影交界处，所有凸起都变成了细小的山脊，所有凹槽都像被水流切出的河道。", en: "At the border of light and shadow, every raised edge became a ridge, every notch a riverbed cut by water." },
  { zh: "「不是普通拼图。」他低声说，「这是地形。」", en: "\"Not a normal puzzle,\" he whispered. \"It's terrain.\"", quote: true },
  { zh: "阿卡莎的声音在耳机里断断续续地响起，像隔着一层厚厚的水面。", en: "Akasha's voice crackled through the earpiece, as if speaking from beneath a thick sheet of water." },
  { zh: "「检测到空间折叠痕迹。林墨，别用蛮力。」", en: "\"Spatial folding detected. Lin Mo, do not force it.\"", quote: true },
  { zh: "他抬头看向石壁最上方。那里有一块缺口，形状像倒扣的山峰，正好对应圆环上的第一枚刻痕。", en: "He looked to the top of the wall. A gap there resembled an inverted mountain, matching the first mark on the ring." },
  { zh: "圆环并不是钥匙，而是索引。每一道刻痕，都在告诉他先移动哪一块。", en: "The ring was not a key, but an index. Each mark told him which fragment should move next." },
  { zh: "第二块、第三块、第四块。石片依次滑入新的位置，墙后的震动也越来越清晰。", en: "The second, third, and fourth fragments slid into new positions, and the vibration behind the wall grew clearer." },
  { zh: "那不是机关声，而像远处有一座城市正在苏醒。", en: "It was not the sound of machinery. It was like a distant city waking up." },
  { zh: "林墨的呼吸慢了下来。地图编辑器的界面在视野边缘自动展开，一条条虚线开始贴合石壁轮廓。", en: "Lin Mo's breathing slowed. The Map Editor opened at the edge of his vision, dashed lines snapping to the wall's outline." },
  { zh: "系统没有给出答案，只给出一组不断变化的坐标。坐标每跳动一次，石壁上的某个缝隙便亮一下。", en: "The system gave no answer, only shifting coordinates. Each flicker matched a seam flashing on the wall." },
  { zh: "「原来如此。」他把圆环转到第二圈，「它不是让我拼出门，是让我拼出一条路。」", en: "\"I see.\" He turned the ring to its second band. \"It doesn't want a door. It wants a route.\"", quote: true },
  { zh: "当第七块石片归位，脚下的地面忽然倾斜。林墨一手撑住墙面，另一手按住背包。", en: "When the seventh fragment settled, the ground tilted. Lin Mo braced one hand against the wall and clutched his pack with the other." },
  { zh: "一条细窄的黑线从墙根裂开，像墨水浸入宣纸，迅速向两侧延伸。", en: "A narrow black line split from the base of the wall, spreading sideways like ink soaking into paper." },
  { zh: "黑线之内，石壁消失了。取而代之的是一片悬空的山河微缩景，江流倒挂，城池如棋。", en: "Inside the line, the stone vanished. In its place hung a miniature landscape, rivers inverted and cities arranged like pieces." },
  { zh: "他终于明白那句话的真正含义。方寸之间，藏的不是图案，而是一整个被折叠起来的副本入口。", en: "He finally understood the inscription. Within inches lay not a pattern, but an entire folded instance entrance." },
  { zh: "雾气翻涌，一枚新的坐标从地图编辑器里弹出，红得像刚刚凝固的血。", en: "Mist churned, and a new coordinate surfaced in the Map Editor, red as freshly clotted blood." },
  { zh: "林墨伸手点下确认。下一秒，整条通道向内坍缩，风声从四面八方灌进耳膜。", en: "Lin Mo tapped confirm. The next second, the corridor collapsed inward, wind roaring into his ears from every direction." },
  { zh: "「阿卡莎，记录路径。」", en: "\"Akasha, record the route.\"", quote: true },
  { zh: "「已记录。但我必须提醒你，回程路径正在被重写。」", en: "\"Recorded. But I must warn you: the return path is being rewritten.\"", quote: true },
  { zh: "林墨笑了一下，迈进那片悬空山河。身后的石片重新合拢，像从未被任何人移动过。", en: "Lin Mo smiled and stepped into the suspended landscape. Behind him, the fragments sealed as if no hand had ever moved them." },
]

export const MANUSCRIPT_PARAGRAPH_COUNT = MANUSCRIPT_PARAGRAPHS.length

export type ReviewIssue = {
  id: string
  severity: "high" | "med" | "low"
  excerpt: { zh: string; en: string }
  note: { zh: string; en: string }
  agent: { zh: string; en: string }
}

export const REVIEW_ISSUES: ReviewIssue[] = [
  {
    id: "r1",
    severity: "high",
    excerpt: { zh: "「方寸之间，藏山河。」", en: "\"Mountains and rivers, hidden within inches.\"" },
    note: { zh: "与第 2 章「方寸界」设定可能矛盾，建议补一句过渡。", en: "Possible contradiction with Ch.2 'inch realm'; add a transition." },
    agent: { zh: "审稿官", en: "Editor" },
  },
  {
    id: "r2",
    severity: "med",
    excerpt: { zh: "他取出背包里的自制磁力探测器", en: "He pulled out his hand-built detector" },
    note: { zh: "未交代探测器何时制成，建议在第 4 章末铺垫。", en: "When was it built? Plant in Ch.4 ending." },
    agent: { zh: "状态校验员", en: "State Verifier" },
  },
  {
    id: "r3",
    severity: "low",
    excerpt: { zh: "林墨勾起嘴角", en: "A smile curled at his mouth" },
    note: { zh: "本章已出现两次相似动作，可换为「轻轻吐气」。", en: "Same gesture used twice; consider 'a quiet exhale'." },
    agent: { zh: "润色师", en: "Polisher" },
  },
]

export const REWRITE_SAMPLE = {
  original: {
    zh: "石壁上镶嵌着无数块形状各异的石片，边缘处隐约有凹槽与凸起，拼合处散发着极其微弱的光。",
    en: "Countless oddly shaped fragments lay embedded in the wall, edges hinting at notches, joints faintly glowing.",
  },
  revised: {
    zh: "他凑近，借着手电的光看清了——石壁不是石壁。无数指甲盖大小的石片错落咬合，缝隙细如发丝，缝隙深处有光，淡得像将熄的烛火。",
    en: "He leaned closer; the flashlight revealed the truth — not a wall, but a mosaic of nail-sized fragments locked together, hairline seams glowing like dying candles.",
  },
}

// ----------------------------------------------------------------------
// 大纲 + 剧情推进
// ----------------------------------------------------------------------
export const OUTLINE = [
  {
    actId: "a1",
    actTitle: { zh: "第一卷 · 副本降临", en: "Act I · The Arrival" },
    chapters: [
      { id: "c1", num: 1, title: { zh: "副本降临", en: "The Instance Arrives" }, beats: 5, words: 3210, status: "done" },
      { id: "c2", num: 2, title: { zh: "地图即力量", en: "Maps as Power" }, beats: 4, words: 2890, status: "done" },
      { id: "c3", num: 3, title: { zh: "新手副本", en: "The Beginner Dungeon" }, beats: 6, words: 3104, status: "done" },
    ],
  },
  {
    actId: "a2",
    actTitle: { zh: "第二卷 · 裂隙之书", en: "Act II · The Rift Archive" },
    chapters: [
      { id: "c4", num: 4, title: { zh: "手绘地图", en: "The Hand-Drawn Map" }, beats: 5, words: 2679, status: "done" },
      { id: "c5", num: 5, title: { zh: "裂隙回音初现", en: "Echoes of the Rift" }, beats: 7, words: 1284, status: "writing" },
      { id: "c6", num: 6, title: { zh: "藏山河", en: "Hidden Rivers" }, beats: 5, words: 0, status: "draft" },
      { id: "c7", num: 7, title: { zh: "拼图者的低语", en: "The Puzzler's Whisper" }, beats: 6, words: 0, status: "draft" },
    ],
  },
]

export type PlotMilestone = {
  id: string
  label: { zh: string; en: string }
  /** 0..1 整本书进度 */
  progress: number
  status: "done" | "current" | "todo"
}

export const PLOT_MILESTONES: PlotMilestone[] = [
  { id: "p1", label: { zh: "开篇", en: "Opening" }, progress: 0.05, status: "done" },
  { id: "p2", label: { zh: "发展", en: "Rising" }, progress: 0.23, status: "current" },
  { id: "p3", label: { zh: "高潮", en: "Climax" }, progress: 0.6, status: "todo" },
  { id: "p4", label: { zh: "结局", en: "Ending" }, progress: 0.95, status: "todo" },
]

// ----------------------------------------------------------------------
// 发布渠道
// ----------------------------------------------------------------------
export const PUBLISH_CHANNELS = [
  { id: "p1", name: { zh: "起点中文网", en: "Qidian" }, status: "published", chapter: "Ch.4", lastSync: "今天 10:30" },
  { id: "p2", name: { zh: "番茄小说", en: "Tomato" }, status: "released", chapter: "Ch.4", lastSync: "今天 10:32" },
  { id: "p3", name: { zh: "微信读书", en: "WeRead" }, status: "queue", chapter: "Ch.4", lastSync: "—" },
  { id: "p4", name: { zh: "Royal Road", en: "Royal Road" }, status: "draft", chapter: "Ch.4", lastSync: "—" },
]

// ----------------------------------------------------------------------
// 市场 / 风格 / Dock
// ----------------------------------------------------------------------
export const HOT_OPPS = [
  { id: "o1", title: { zh: "赛博修仙", en: "Cyber-cultivation" }, score: 89, trend: "up", change: "+35%" },
  { id: "o2", title: { zh: "代号黎明", en: "Code Dawn" }, score: 82, trend: "up", change: "+18%" },
  { id: "o3", title: { zh: "时间代理人", en: "Time Agent" }, score: 76, trend: "flat", change: "+6%" },
  { id: "o4", title: { zh: "古籍修复师", en: "Archive Restorer" }, score: 71, trend: "up", change: "+14%" },
]

export const STYLE_RADAR = [
  { axis: { zh: "节奏感", en: "Pace" }, value: 0.78 },
  { axis: { zh: "情感浓度", en: "Emotion" }, value: 0.66 },
  { axis: { zh: "语言风格", en: "Diction" }, value: 0.82 },
  { axis: { zh: "创新度", en: "Novelty" }, value: 0.59 },
  { axis: { zh: "画面感", en: "Imagery" }, value: 0.86 },
]

export const DOCK_METRICS = {
  speed: 1284,
  speedTrend: "+8.2%",
  quality: 84,
  consistency: 86,
  adopted: 3214,
  tokens: 18320,
  remaining: 1845,
  remainingPct: 23,
  etaMinutes: 18,
}

export const CHAPTER_STATS = {
  currentWords: 132847,
  todayMinutes: 12,
  todaySeconds: 48,
  chapterTarget: 5000,
  thisRunWords: 1284,
  chapterPct: 23,
}

// ----------------------------------------------------------------------
// 实时事件流（agent 日志）
// ----------------------------------------------------------------------
export type AgentLog = {
  id: string
  ts: string
  agentId: string
  level: "info" | "warn" | "error" | "ok"
  text: { zh: string; en: string }
}

export const AGENT_LOGS: AgentLog[] = [
  { id: "l1", ts: "10:28:31", agentId: "writer", level: "ok", text: { zh: "写手 · 完成段落 4，共 142 字", en: "writer · paragraph 4 done, 142 words" } },
  { id: "l2", ts: "10:27:18", agentId: "editor", level: "info", text: { zh: "审稿官 · 校对前 3 段连贯性", en: "editor · checked first 3 paragraphs" } },
  { id: "l3", ts: "10:25:44", agentId: "chapter-analyst", level: "warn", text: { zh: "章节分析官 · 节奏偏慢 +12%", en: "chapter-analyst · pacing slow +12%" } },
  { id: "l4", ts: "10:24:09", agentId: "architect", level: "ok", text: { zh: "架构师 · 推送场景骨架 v3", en: "architect · pushed scaffold v3" } },
  { id: "l5", ts: "10:22:10", agentId: "planner", level: "info", text: { zh: "规划师 · 重排 beats 4-7", en: "planner · re-ordered beats 4-7" } },
  { id: "l6", ts: "10:21:03", agentId: "word-steward", level: "warn", text: { zh: "字数治理官 · 段落 3 偏长 +28%", en: "word-steward · para 3 overlong +28%" } },
  { id: "l7", ts: "10:19:37", agentId: "style-fingerprint", level: "ok", text: { zh: "风格指纹官 · 风格匹配 92.4%", en: "style-fingerprint · match 92.4%" } },
  { id: "l8", ts: "10:18:12", agentId: "prompt-steward", level: "info", text: { zh: "提示词治理官 · 提示词版本升级 v3.4.1", en: "prompt-steward · prompt v3.4.1" } },
]
