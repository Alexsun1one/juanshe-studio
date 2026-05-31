/**
 * 账号风格画像 + 自我进化(editorial/)。
 *
 * 长期定义:每个账号/内容类型有一份可持久化的风格画像(定位/语气/招牌模式/禁忌 + 学到的规则)。
 * 自我进化:每次成稿的评审反复命中的问题 → 归一化成"学到的规则"(learnedRules),累加命中、去重、按命中排序,
 *   下次写作把这些规则注入 accountVoice。久而久之,这个账号"老犯什么、该强化什么"会沉淀下来。
 *
 * 纯函数,不读盘 / 不调 LLM(持久化由 studio 端做)。
 */

import type { CritiqueReport, CritiqueIssue } from "./article-pipeline.js";

export interface LearnedRule {
  /** 可执行的规避/强化规则(给写手看)。 */
  readonly rule: string;
  /** 来源证据(评审反复命中的问题)。 */
  readonly evidence: string;
  /** 累积命中次数(越高越该重视)。 */
  readonly hits: number;
  readonly updatedAt: string;
}

export interface AccountStyleProfile {
  readonly id: string;
  /** 一句话定位/语气(用户可手写)。 */
  readonly voice: string;
  readonly tone: string;
  /** 招牌模式(可执行,如"开头用一个具体场景")。 */
  readonly signaturePatterns: readonly string[];
  /** 禁忌(明确反例)。 */
  readonly forbidden: readonly string[];
  /** 自我进化沉淀的规则(由评审反馈累积)。 */
  readonly learnedRules: readonly LearnedRule[];
  readonly version: number;
  readonly updatedAt: string;
}

export function emptyAccountStyle(id: string): AccountStyleProfile {
  return { id, voice: "", tone: "", signaturePatterns: [], forbidden: [], learnedRules: [], version: 0, updatedAt: "" };
}

/** 归一化问题为去重 key(用于把"同一类反复出现的问题"合并)。 */
function issueKey(issue: Pick<CritiqueIssue, "problem">): string {
  return (issue.problem || "")
    .toLowerCase()
    .replace(/[，。、；;,.\s"'「」()（）]/g, "")
    .slice(0, 24);
}

/**
 * 自我进化:把本次评审中 critical/significant 的问题并进画像的 learnedRules
 * (同类累加 hits、刷新规则文案;新类新增),按 hits 降序保留前 maxRules 条,version+1。
 */
export function evolveStyleProfile(
  profile: AccountStyleProfile,
  critique: CritiqueReport,
  options?: { readonly now?: string; readonly maxRules?: number },
): AccountStyleProfile {
  if (!critique || !critique.parsed) return profile;
  const now = options?.now ?? new Date().toISOString();
  const maxRules = options?.maxRules ?? 12;
  const significant = critique.issues.filter((i) => i.severity === "critical" || i.severity === "significant");
  if (significant.length === 0) return profile;

  const byKey = new Map<string, LearnedRule>();
  for (const r of profile.learnedRules) byKey.set(issueKey({ problem: r.evidence }), r);

  for (const issue of significant) {
    const key = issueKey(issue);
    if (!key) continue;
    const rule = issue.fix?.trim()
      ? `规避「${truncate(issue.problem, 40)}」——${truncate(issue.fix, 60)}`
      : `规避「${truncate(issue.problem, 50)}」`;
    const prev = byKey.get(key);
    byKey.set(key, {
      rule,
      evidence: issue.problem || prev?.evidence || "",
      hits: (prev?.hits ?? 0) + 1,
      updatedAt: now,
    });
  }

  const learnedRules = [...byKey.values()]
    .sort((a, b) => b.hits - a.hits)
    .slice(0, maxRules);

  return { ...profile, learnedRules, version: profile.version + 1, updatedAt: now };
}

/** 把画像拼成可注入 buildWritingSystemPrompt 的 accountVoice 文本(含进化出的规则)。 */
export function buildAccountVoicePrompt(profile: AccountStyleProfile): string {
  const parts: string[] = [];
  if (profile.voice) parts.push(`定位/语气:${profile.voice}`);
  if (profile.tone) parts.push(`基调:${profile.tone}`);
  if (profile.signaturePatterns.length) parts.push(`招牌模式(沿用):${profile.signaturePatterns.join(";")}`);
  if (profile.forbidden.length) parts.push(`禁忌(不要):${profile.forbidden.join(";")}`);
  const top = profile.learnedRules.filter((r) => r.hits >= 2).slice(0, 8);
  if (top.length) {
    parts.push(
      "本账号历史反复出现的问题(务必避免):",
      ...top.map((r) => `- ${r.rule}（已累计 ${r.hits} 次）`),
    );
  }
  return parts.join("\n");
}

function truncate(s: string, n: number): string {
  const t = (s || "").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}
