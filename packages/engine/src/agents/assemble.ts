/**
 * 卷舍 · 系统提示词组装器
 *
 * 把三样东西拼成某个角色当次调用的完整 system prompt:
 *   ① 角色提示词(ROLE_PROMPTS,工作流产出的全新原创版)
 *   ② 去AI味组件(antiSlopDirective)—— 写作/改稿/润色类角色强制追加,确保输出像真人
 *   ③ 题材/平台写作档案(GENRE_PROFILES / PLATFORM_PROFILES)—— 给相关角色注入"这本书该怎么写"
 *
 * 这是"提示词 + 知识库 + 去AI味"三层在运行时合一的地方:
 * 提示词不写死,而是按当次作品的题材/平台动态组装。
 */
import { ROLE_PROMPTS } from "./prompts.js"
import { antiSlopDirective } from "./anti-slop.js"
import { GENRE_PROFILES, PLATFORM_PROFILES, type GenreProfile, type PlatformProfile } from "../knowledge/index.js"
import { renderStyleProfile } from "../style/apply.js"
import type { StyleProfile } from "../style/profile.js"
import type { AccountRule } from "../memory/types.js"

export interface AssembleContext {
  readonly genreId?: string
  readonly platformId?: string
  readonly lang?: "zh" | "en"
  /** 本作文风指纹(架构/写作/改稿/润色注入)*/
  readonly styleProfile?: StyleProfile
  /** 账号级跨书经验规则(去AI味/风格/避坑;写作类角色注入)*/
  readonly accountRules?: AccountRule[]
  /** 已渲染好的经验回灌块(learnings 模块产出,planner 注入)*/
  readonly learnings?: string
}

// 哪些角色要追加去AI味组件(直接产出/改动正文的)
const ANTI_SLOP_ROLES = new Set(["architect", "writer", "reviser", "polisher", "length-governor"])
// 哪些角色要题材知识(写作/规划/审稿/读者视角)
const GENRE_ROLES = new Set(["architect", "planner", "writer", "reviser", "reader-critic", "continuity-reviewer", "market-radar"])
// 哪些角色要平台知识(适配/排版/选题)
const PLATFORM_ROLES = new Set(["architect", "planner", "writer", "polisher", "market-radar"])
// 哪些角色注入文风指纹(架构 + 直接产出/改动正文的)
const STYLE_ROLES = new Set(["architect", "writer", "reviser", "polisher"])
// 哪些角色注入账号经验规则
const ACCOUNT_ROLES = new Set(["writer", "reviser", "polisher"])

function renderGenre(g: GenreProfile): string {
  const lines = [
    `## 本作题材:${g.name}`,
    `核心爽点:${g.coreAppeal}`,
    `读者预期:${g.readerExpectations.join(";")}`,
    g.pacingNotes ? `节奏:${g.pacingNotes}` : "",
    `该用的:${g.mustHaveTropes.join(";")}`,
    `要避的烂套路:${g.avoidCliches.join(";")}`,
    `开篇策略:${g.openingStrategy}`,
    g.deAiNotes && g.deAiNotes.length ? `本题材去AI味要点:${g.deAiNotes.join(";")}` : "",
  ]
  return lines.filter(Boolean).join("\n")
}

function renderPlatform(p: PlatformProfile): string {
  const lines = [
    `## 目标平台:${p.name}`,
    `建议篇幅:${p.lengthRange.join("–")} 字`,
    `结构:${p.structurePattern}`,
    `语气:${p.toneVoice}`,
    `标题公式:${p.titleFormula.join(" / ")}`,
    `开头钩子:${p.openingHook}`,
    `排版规则:${p.formatRules.join(";")}`,
    p.dosDonts && p.dosDonts.length ? `宜忌:${p.dosDonts.join(";")}` : "",
  ]
  return lines.filter(Boolean).join("\n")
}

function renderAccountRules(rules: AccountRule[], lang: "zh" | "en"): string {
  const top = rules.slice(0, 5)
  if (!top.length) return ""
  const head = lang === "en" ? "## Your accumulated high-hit writing rules (follow these)" : "## 你沉淀的高命中经验(请遵循)"
  return [head, ...top.map((r) => `· ${r.rule}`)].join("\n")
}

/**
 * 组装某角色当次调用的完整 system prompt。
 * 注入顺序(刻意):角色提示词 → 去AI味(地板,强制)→ 题材/平台 → 文风指纹(个性,贴合)→ 账号经验 → 经验回灌。
 * 去AI味是地板、风格是个性,冲突时去AI味优先(renderStyleProfile 文案已显式声明)。
 */
export function buildSystemPrompt(role: string, ctx: AssembleContext = {}): string {
  const parts: string[] = []
  const rp = ROLE_PROMPTS[role]
  if (rp?.systemPrompt) parts.push(rp.systemPrompt)

  if (ANTI_SLOP_ROLES.has(role)) parts.push(antiSlopDirective(ctx.lang ?? "zh"))

  if (ctx.genreId && GENRE_ROLES.has(role)) {
    const g = GENRE_PROFILES[ctx.genreId]
    if (g) parts.push(renderGenre(g))
  }
  if (ctx.platformId && PLATFORM_ROLES.has(role)) {
    const p = PLATFORM_PROFILES[ctx.platformId]
    if (p) parts.push(renderPlatform(p))
  }
  if (ctx.styleProfile && STYLE_ROLES.has(role)) parts.push(renderStyleProfile(ctx.styleProfile))
  if (ctx.accountRules?.length && ACCOUNT_ROLES.has(role)) parts.push(renderAccountRules(ctx.accountRules, ctx.lang ?? "zh"))
  if (ctx.learnings && role === "planner") parts.push(ctx.learnings)

  return parts.filter(Boolean).join("\n\n")
}
