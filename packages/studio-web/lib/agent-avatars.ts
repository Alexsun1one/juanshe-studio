/**
 * 17 位编辑部 agent 的精致像素头像。
 * 资产: public/agent-avatars-imagined/<num>-<id>.png(512x512 transparent)。
 *
 * key 用 frontend agent id(toFrontendAgentId 归一后的规范 id)。
 * AgentPixel 优先用这里的头像;没有的角色 fallback 到程序画 SVG。
 */
export const AGENT_AVATARS: Record<string, string> = {
  "market-radar": "/agent-avatars-imagined/01-market-radar.png",
  architect: "/agent-avatars-imagined/02-architect.png",
  "setup-auditor": "/agent-avatars-imagined/03-setup-auditor.png",
  planner: "/agent-avatars-imagined/04-planner.png",
  writer: "/agent-avatars-imagined/05-writer.png",
  editor: "/agent-avatars-imagined/06-editor.png",
  reviser: "/agent-avatars-imagined/07-reviser.png",
  "word-steward": "/agent-avatars-imagined/08-word-steward.png",
  polisher: "/agent-avatars-imagined/09-polisher.png",
  "chapter-analyst": "/agent-avatars-imagined/10-chapter-analyst.png",
  "state-verifier": "/agent-avatars-imagined/11-state-verifier.png",
  "style-fingerprint": "/agent-avatars-imagined/12-style-fingerprint.png",
  "reader-critic": "/agent-avatars-imagined/13-reader-critic.png",
  "quality-report": "/agent-avatars-imagined/14-quality-report.png",
  "prompt-steward": "/agent-avatars-imagined/15-prompt-steward.png",
  "managing-editor": "/agent-avatars-imagined/16-managing-editor.png",
  "editor-in-chief": "/agent-avatars-imagined/17-editor-in-chief.png",
}

/** 取 agent 头像路径(frontend id);无对应头像返回 undefined → 调用方 fallback。 */
export function agentAvatar(id: string | undefined | null): string | undefined {
  if (!id) return undefined
  return AGENT_AVATARS[id]
}

/** 是否所有角色都有头像(用于断言/调试)。 */
export const AGENT_AVATAR_COUNT = Object.keys(AGENT_AVATARS).length
