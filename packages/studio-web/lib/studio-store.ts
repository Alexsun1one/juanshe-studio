// 进程内可写的 mock store，仅用于前端独立运行
// 真实数据来源：codex 后端

import type {
  AgentProfile,
  ConnectivityResult,
  LLMProvider,
  ProjectPrefs,
  WikiNode,
  WikiResponse,
} from "@/lib/api/types"
import { AGENT_PROFILES_SEED } from "@/lib/agent-prompts-seed"
import {
  LLM_PROVIDERS_SEED,
  PROJECT_PREFS_SEED,
  buildWikiSeed,
} from "@/lib/studio-seeds"

declare global {
  var __studioStore: {
    profiles: Map<string, AgentProfile>
    providers: Map<string, LLMProvider>
    prefs: ProjectPrefs
    wikis: Map<string, WikiResponse>
  } | undefined
}

function init() {
  if (globalThis.__studioStore) return globalThis.__studioStore
  const profiles = new Map<string, AgentProfile>()
  for (const p of AGENT_PROFILES_SEED) profiles.set(p.id, structuredClone(p))
  const providers = new Map<string, LLMProvider>()
  for (const p of LLM_PROVIDERS_SEED) providers.set(p.id, structuredClone(p))
  globalThis.__studioStore = {
    profiles,
    providers,
    prefs: structuredClone(PROJECT_PREFS_SEED),
    wikis: new Map(),
  }
  return globalThis.__studioStore
}

// ---- Agent profiles ----
export function listProfiles(): AgentProfile[] {
  return [...init().profiles.values()].sort((a, b) => a.step - b.step)
}
export function getProfile(id: string): AgentProfile | undefined {
  return init().profiles.get(id)
}
export function updateProfile(
  id: string,
  patch: Partial<Omit<AgentProfile, "id" | "versions">>,
  note?: string,
): AgentProfile | undefined {
  const cur = init().profiles.get(id)
  if (!cur) return undefined
  // 系统提示词改动 → 保存版本快照
  if (patch.systemPrompt && patch.systemPrompt !== cur.systemPrompt) {
    cur.versions.unshift({
      id: `v-${Date.now()}`,
      ts: Date.now(),
      note,
      systemPrompt: cur.systemPrompt,
      author: "user",
    })
    if (cur.versions.length > 20) cur.versions.length = 20
  }
  Object.assign(cur, patch)
  return cur
}

export function restoreProfileVersion(
  id: string,
  versionId: string,
): AgentProfile | undefined {
  const cur = init().profiles.get(id)
  if (!cur) return undefined
  const ver = cur.versions.find((v) => v.id === versionId)
  if (!ver) return undefined
  // 当前版本入栈
  cur.versions.unshift({
    id: `v-${Date.now()}`,
    ts: Date.now(),
    note: `restore from ${ver.id}`,
    systemPrompt: cur.systemPrompt,
    author: "user",
  })
  cur.systemPrompt = ver.systemPrompt
  return cur
}

// ---- Connectivity (mock：随机延迟 + 偶尔失败) ----
export function testConnectivity(profileId: string): ConnectivityResult {
  const p = getProfile(profileId)
  if (!p) {
    return {
      agentId: profileId,
      ok: false,
      latencyMs: 0,
      model: "",
      testedAt: Date.now(),
      error: "agent not found",
    }
  }
  // 90% 成功
  const ok = Math.random() > 0.1
  const latency = 200 + Math.floor(Math.random() * 1500)
  return {
    agentId: profileId,
    ok,
    latencyMs: latency,
    model: p.model,
    testedAt: Date.now(),
    error: ok ? undefined : "rate limit / network unstable",
    sample: ok ? "ok · " + p.name.zh + " · ping" : undefined,
  }
}

// ---- Providers ----
export function listProviders(): LLMProvider[] {
  return [...init().providers.values()]
}
export function getProvider(id: string): LLMProvider | undefined {
  return init().providers.get(id)
}
export function updateProvider(
  id: string,
  patch: Partial<LLMProvider>,
): LLMProvider | undefined {
  const cur = init().providers.get(id)
  if (!cur) return undefined
  Object.assign(cur, patch)
  return cur
}
export function testProvider(id: string): {
  ok: boolean
  latencyMs: number
  error?: string
} {
  const p = init().providers.get(id)
  if (!p) return { ok: false, latencyMs: 0, error: "not found" }
  const ok = p.hasKey && Math.random() > 0.15
  const latency = 150 + Math.floor(Math.random() * 1000)
  p.lastTestedAt = Date.now()
  p.lastTestOk = ok
  return {
    ok,
    latencyMs: latency,
    error: ok ? undefined : p.hasKey ? "endpoint unreachable" : "no api key",
  }
}

// ---- Prefs ----
export function getPrefs(): ProjectPrefs {
  return init().prefs
}
export function updatePrefs(patch: Partial<ProjectPrefs>): ProjectPrefs {
  Object.assign(init().prefs, patch)
  return init().prefs
}

// ---- Wiki ----
export function getWiki(bookId: string): WikiResponse {
  const s = init()
  if (!s.wikis.has(bookId)) s.wikis.set(bookId, buildWikiSeed(bookId))
  return s.wikis.get(bookId)!
}
export function updateWikiNode(
  bookId: string,
  nodeId: string,
  patch: Partial<Pick<WikiNode, "body" | "title" | "tags">>,
): WikiNode | undefined {
  const wiki = getWiki(bookId)
  const node = wiki.nodes.find((n) => n.id === nodeId)
  if (!node) return undefined
  Object.assign(node, patch)
  return node
}
