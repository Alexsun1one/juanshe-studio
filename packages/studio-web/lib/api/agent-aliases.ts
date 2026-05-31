export const FRONTEND_AGENT_IDS = [
  "market-radar",
  "architect",
  "setup-auditor",
  "planner",
  "writer",
  "editor",
  "reviser",
  "word-steward",
  "polisher",
  "chapter-analyst",
  "state-verifier",
  "style-fingerprint",
  "reader-critic",
  "quality-report",
  "prompt-steward",
] as const

export type FrontendAgentId = (typeof FRONTEND_AGENT_IDS)[number]

const FRONTEND_AGENT_ID_SET = new Set<string>(FRONTEND_AGENT_IDS)

const TO_FRONTEND_AGENT_ID: Record<string, FrontendAgentId> = {
  radar: "market-radar",

  "foundation-reviewer": "setup-auditor",
  "book-foundation-reviewer": "setup-auditor",

  auditor: "editor",
  reviewer: "editor",

  rewriter: "reviser",

  "length-normalizer": "word-steward",
  "wordcount-governor": "word-steward",

  "chapter-analyzer": "chapter-analyst",

  "state-validator": "state-verifier",
  consistency: "state-verifier",
  "memory-keeper": "chapter-analyst",

  "style-governor": "style-fingerprint",
  stylist: "style-fingerprint",

  "reader-judge": "reader-critic",

  "quality-reporter": "quality-report",

  "prompt-governor": "prompt-steward",
  "prompt-keeper": "prompt-steward",

  outliner: "planner",
  "world-builder": "architect",
  "character-designer": "architect",
  factcheck: "editor",
  "tension-tuner": "polisher",
  publisher: "quality-report",
}

const TO_BACKEND_AGENT_ID: Record<FrontendAgentId, string> = {
  "market-radar": "radar",
  architect: "architect",
  "setup-auditor": "foundation-reviewer",
  planner: "planner",
  writer: "writer",
  editor: "auditor",
  reviser: "reviser",
  "word-steward": "length-normalizer",
  polisher: "polisher",
  "chapter-analyst": "chapter-analyzer",
  "state-verifier": "state-validator",
  "style-fingerprint": "style-governor",
  "reader-critic": "reader-critic",
  "quality-report": "quality-reporter",
  "prompt-steward": "prompt-governor",
}

export function toFrontendAgentId(id: string): string {
  const raw = normalizeRawAgentId(id)
  if (FRONTEND_AGENT_ID_SET.has(raw)) return raw
  return TO_FRONTEND_AGENT_ID[raw] ?? raw
}

export function toBackendAgentId(id: string): string {
  const frontendId = toFrontendAgentId(id)
  return isFrontendAgentId(frontendId)
    ? TO_BACKEND_AGENT_ID[frontendId]
    : normalizeRawAgentId(id)
}

export function sameAgentId(left: string, right: string): boolean {
  return toFrontendAgentId(left) === toFrontendAgentId(right)
}

function isFrontendAgentId(id: string): id is FrontendAgentId {
  return FRONTEND_AGENT_ID_SET.has(id)
}

function normalizeRawAgentId(id: string): string {
  return String(id || "").trim().replace(/^book-/, "")
}
