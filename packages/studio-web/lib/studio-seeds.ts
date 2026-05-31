// 各页面的 mock seed（仅用于前端独立运行；真实数据从 codex 后端拉）

import type {
  LLMProvider,
  ProjectPrefs,
  WikiNode,
  WikiResponse,
  WorkflowContract,
} from "@/lib/api/types"
import { AGENT_PROFILES_SEED } from "@/lib/agent-prompts-seed"

// ----------------------------------------------------------------------
// LLM Providers
// ----------------------------------------------------------------------
export const LLM_PROVIDERS_SEED: LLMProvider[] = [
  {
    id: "vercel-gateway",
    name: "Vercel AI Gateway",
    kind: "openai",
    baseUrl: "https://gateway.ai.vercel.com",
    hasKey: true,
    enabled: true,
    lastTestedAt: Date.now() - 1000 * 60 * 8,
    lastTestOk: true,
    models: [
      "openai/gpt-5-mini",
      "openai/gpt-5",
      "anthropic/claude-opus-4.6",
      "anthropic/claude-sonnet-4.6",
      "google/gemini-3-flash",
      "google/gemini-3-pro",
    ],
  },
  {
    id: "openai-direct",
    name: "OpenAI Direct",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    hasKey: false,
    enabled: false,
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1"],
  },
  {
    id: "anthropic-direct",
    name: "Anthropic Direct",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    hasKey: true,
    enabled: true,
    lastTestedAt: Date.now() - 1000 * 60 * 32,
    lastTestOk: true,
    models: ["claude-opus-4.6", "claude-sonnet-4.6", "claude-haiku-4"],
  },
  {
    id: "groq",
    name: "Groq (fast inference)",
    kind: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    hasKey: false,
    enabled: false,
    models: ["llama-3.3-70b", "kimi-k2-32b"],
  },
  {
    id: "local-ollama",
    name: "本地 Ollama",
    kind: "custom",
    baseUrl: "http://localhost:11434/v1",
    hasKey: false,
    enabled: false,
    lastTestedAt: Date.now() - 1000 * 60 * 60 * 6,
    lastTestOk: false,
    models: ["llama3.1:70b", "qwen2.5:72b", "deepseek-coder-v2:16b"],
  },
]

// ----------------------------------------------------------------------
// Workflow Contract
// ----------------------------------------------------------------------
export const WORKFLOW_CONTRACT_SEED: WorkflowContract = {
  steps: AGENT_PROFILES_SEED.map((a, i) => ({
    id: `step-${i + 1}`,
    agentId: a.id,
    inputs:
      i === 0
        ? ["user.theme", "vault.existing"]
        : [`step-${i}.output`, "wiki.read"],
    outputs: [`${a.id}.product`],
    fallback: i > 4 ? `step-${i}` : undefined,
    optional: ["chapter-analyst", "state-verifier"].includes(a.id) && i > 9,
  })),
}

// ----------------------------------------------------------------------
// Project Prefs
// ----------------------------------------------------------------------
export const PROJECT_PREFS_SEED: ProjectPrefs = {
  locale: "zh-CN",
  theme: "dark",
  defaultRun: {
    targetWordsPerChapter: 3000,
    targetQuality: 85,
    maxRewritesPerChapter: 3,
  },
  notify: {
    onChapterDone: true,
    onRunFailed: true,
    onLowQuality: true,
  },
}

// ----------------------------------------------------------------------
// Wiki seed（章节、人物、伏笔、约束、agent、笔记 各示例）
// 仅 demo 用，真实数据从 codex /wiki 拉
// ----------------------------------------------------------------------
function makeWikiNodes(bookId: string): WikiNode[] {
  // 章节节点（Ch.1 ~ Ch.10）
  const chapters: WikiNode[] = Array.from({ length: 10 }).map((_, i) => ({
    id: `${bookId}-ch-${i + 1}`,
    kind: "chapter",
    chapterNum: i + 1,
    title: {
      zh: `第 ${i + 1} 章 · 草稿`,
      en: `Chapter ${i + 1}`,
    },
    tags: ["chapter", `act-${Math.floor(i / 4) + 1}`],
    backlinks: [],
    links: [],
  }))

  // 角色节点
  const chars: WikiNode[] = [
    {
      id: `${bookId}-char-luna`,
      kind: "character",
      title: { zh: "卢娜·维克斯", en: "Luna Vex" },
      body: "主角。语言学家。能「听见」裂隙的低语。",
      tags: ["protagonist", "linguist"],
      backlinks: [],
      links: [],
    },
    {
      id: `${bookId}-char-orin`,
      kind: "character",
      title: { zh: "奥林·凯恩", en: "Orin Kane" },
      body: "军方观测员。亦敌亦友。",
      tags: ["antagonist", "military"],
      backlinks: [],
      links: [],
    },
    {
      id: `${bookId}-char-mira`,
      kind: "character",
      title: { zh: "米拉博士", en: "Dr. Mira" },
      body: "科学顾问。理性之锚。",
      tags: ["mentor"],
      backlinks: [],
      links: [],
    },
  ]

  // 伏笔节点
  const setups: WikiNode[] = [
    {
      id: `${bookId}-setup-rift`,
      kind: "setpoint",
      title: { zh: "裂隙的低语", en: "Whisper of the Rift" },
      body: "Ch.2 种植：卢娜在地下听到非人类语言。Ch.8 回收：发现这是未来自己的信号。",
      tags: ["foreshadow", "act-1", "payoff-act-2"],
      backlinks: [],
      links: [],
    },
    {
      id: `${bookId}-setup-coin`,
      kind: "setpoint",
      title: { zh: "奥林的银币", en: "Orin's Coin" },
      body: "Ch.3 种植：奥林总在掂量一枚银币。Ch.7 回收：是亡兄遗物。",
      tags: ["foreshadow", "character-bond"],
      backlinks: [],
      links: [],
    },
  ]

  // 工程约束
  const constraints: WikiNode[] = [
    {
      id: `${bookId}-c-pov`,
      kind: "constraint",
      title: { zh: "视角约束", en: "POV Rule" },
      body: "全篇仅卢娜与奥林两个 POV 交替，每章不混。",
      tags: ["hard-constraint"],
      backlinks: [],
      links: [],
    },
    {
      id: `${bookId}-c-words`,
      kind: "constraint",
      title: { zh: "字数约束", en: "Wordcount Rule" },
      body: "每章 3000 字 ±5%。",
      tags: ["hard-constraint", "wordcount"],
      backlinks: [],
      links: [],
    },
    {
      id: `${bookId}-c-tone`,
      kind: "constraint",
      title: { zh: "调性约束", en: "Tone Rule" },
      body: "硬科幻 + 亲密关系，不写血腥与露骨。",
      tags: ["hard-constraint", "tone"],
      backlinks: [],
      links: [],
    },
  ]

  // Agent 节点（每个 agent 一个，关联到 atelier profile）
  const agents: WikiNode[] = AGENT_PROFILES_SEED.map((a) => ({
    id: `${bookId}-agent-${a.id}`,
    kind: "agent",
    title: a.name,
    body: a.systemPrompt.split("\n").slice(0, 3).join("\n"),
    tags: ["agent", `step-${a.step}`],
    agentProfileId: a.id,
    backlinks: [],
    links: [],
  }))

  // 笔记
  const notes: WikiNode[] = [
    {
      id: `${bookId}-note-tone`,
      kind: "note",
      title: { zh: "作者笔记 · 关于第二幕节奏", en: "Author Notes · Act 2 pacing" },
      body: "第 8 章后半段需要给主角一个真正的「低谷时刻」，不是情节低谷而是信念低谷。",
      tags: ["author-note", "pacing"],
      backlinks: [],
      links: [],
    },
  ]

  // 链接关系（chapter ↔ char/setup/agent）
  const all = [...chapters, ...chars, ...setups, ...constraints, ...agents, ...notes]
  const byId = new Map(all.map((n) => [n.id, n]))

  function link(srcId: string, dstId: string) {
    const s = byId.get(srcId)
    const d = byId.get(dstId)
    if (!s || !d) return
    s.links.push({ id: d.id, title: d.title })
    d.backlinks.push({ id: s.id, title: s.title })
  }

  // 章节 → 角色
  link(`${bookId}-ch-1`, `${bookId}-char-luna`)
  link(`${bookId}-ch-2`, `${bookId}-char-luna`)
  link(`${bookId}-ch-2`, `${bookId}-setup-rift`)
  link(`${bookId}-ch-3`, `${bookId}-char-orin`)
  link(`${bookId}-ch-3`, `${bookId}-setup-coin`)
  link(`${bookId}-ch-5`, `${bookId}-char-luna`)
  link(`${bookId}-ch-5`, `${bookId}-char-orin`)
  link(`${bookId}-ch-5`, `${bookId}-char-mira`)
  link(`${bookId}-ch-7`, `${bookId}-setup-coin`)
  link(`${bookId}-ch-8`, `${bookId}-setup-rift`)
  link(`${bookId}-ch-8`, `${bookId}-note-tone`)

  // 章节 → 约束
  for (const ch of chapters) {
    link(ch.id, `${bookId}-c-pov`)
    link(ch.id, `${bookId}-c-words`)
    link(ch.id, `${bookId}-c-tone`)
  }

  // agent ↔ 章节（写手 / 审稿官 / 修稿师 触达每章）
  for (const ch of chapters) {
    link(`${bookId}-agent-writer`, ch.id)
    link(`${bookId}-agent-reviewer`, ch.id)
  }

  return all
}

export function buildWikiSeed(bookId: string): WikiResponse {
  const nodes = makeWikiNodes(bookId)
  // 简单分层布局：按 kind 分组，每组一行
  const kindOrder: WikiNode["kind"][] = [
    "chapter",
    "character",
    "setpoint",
    "constraint",
    "agent",
    "note",
  ]
  const layout: Record<string, { x: number; y: number }> = {}
  const rowGap = 220
  const colGap = 200
  for (const kind of kindOrder) {
    const row = nodes.filter((n) => n.kind === kind)
    const y = kindOrder.indexOf(kind) * rowGap + 120
    row.forEach((n, i) => {
      layout[n.id] = { x: i * colGap + 120, y }
    })
  }
  return { nodes, layout }
}
