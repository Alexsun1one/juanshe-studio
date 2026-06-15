import type { ChapterHeatTarget, ChapterIntent, ChapterMemo, ContextPackage } from "../models/input-governance.js";

const HOOK_ID_PATTERN = /\bH\d+\b/gi;
const HOOK_SLUG_PATTERN = /\b[a-z]+(?:-[a-z]+){1,3}\b/g;
const CHAPTER_REF_PATTERNS: ReadonlyArray<RegExp> = [
  /\bch(?:apter)?\s*\d+\b/gi,
  /第\s*\d+\s*章/g,
];

const ZH_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/前几章/g, "此前"],
  [/本章要做的是/g, "眼下要处理的是"],
  [/本章要做的/g, "眼下要处理的"],
  [/仿佛/g, "像"],
  [/似乎/g, "像是"],
];

const EN_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/\bprevious chapters\b/gi, "earlier scenes"],
  [/\bthis chapter needs to\b/gi, "the current move is to"],
];

export function sanitizeNarrativeControlText(
  text: string,
  language: "zh" | "en" = "zh",
): string {
  let result = text;

  result = result.replace(HOOK_ID_PATTERN, language === "en" ? "this thread" : "这条线索");
  result = result.replace(HOOK_SLUG_PATTERN, language === "en" ? "this thread" : "这条线索");
  for (const pattern of CHAPTER_REF_PATTERNS) {
    result = result.replace(pattern, language === "en" ? "an earlier scene" : "此前");
  }

  for (const [pattern, replacement] of [...ZH_REPLACEMENTS, ...EN_REPLACEMENTS]) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

/**
 * Render a ChapterMemo + optional ChapterIntent into a sanitized narrative
 * control block for the writer / reviser prompt.
 *
 * Phase 4: the memo body already contains the 7 required section headings
 * (当前任务 / 读者此刻在等什么 / 该兑现的 / 日常过渡 / 关键抉择 / 章尾 / 不要做)
 * produced by the planner LLM. We emit them at top level so the writer sees
 * each section as its own task-unit instead of one flattened "memo" block.
 */
export function renderMemoAsNarrativeBlock(
  memo: ChapterMemo,
  intent: ChapterIntent | undefined,
  language: "zh" | "en" = "zh",
): string {
  const s = (text: string) => sanitizeNarrativeControlText(text, language);
  const isEn = language === "en";
  const sections: string[] = [];

  sections.push(`## ${isEn ? "Goal" : "目标"}\n- ${s(memo.goal)}`);

  if (intent?.arcContext) {
    sections.push(`## ${isEn ? "Arc Context" : "弧线背景"}\n- ${s(intent.arcContext)}`);
  }

  if (memo.threadRefs.length > 0) {
    const threads = memo.threadRefs.map((id) => `- ${id}`).join("\n");
    sections.push(`## ${isEn ? "Thread Refs" : "关联线索"}\n${threads}`);
  }

  if (memo.isGoldenOpening) {
    sections.push(
      `## ${isEn ? "Golden Opening" : "黄金开场"}\n- ${isEn ? "This is a golden opening chapter — prioritize hook-dense, high-tempo pacing." : "本章是黄金开场章——优先钩子密集、高节奏。"}`,
    );
  }

  const styleEmphasis = intent?.styleEmphasis ?? [];
  if (styleEmphasis.length > 0) {
    sections.push(
      `## ${isEn ? "Style Emphasis" : "风格强调"}\n${styleEmphasis.map((item) => `- ${s(item)}`).join("\n")}`,
    );
  }

  const chapterHeat = resolveChapterHeatTarget(memo, intent);
  if (!isDefaultChapterHeat(chapterHeat)) {
    sections.push(renderChapterHeatCraftBlock(chapterHeat, language));
  }

  // Emit the 7-section memo body at top level so each heading is a task.
  if (memo.body.trim().length > 0) {
    sections.push(s(memo.body));
  }

  return sections.join("\n\n");
}

export function buildNarrativeIntentBrief(
  chapterIntent: string,
  language: "zh" | "en" = "zh",
): string {
  const sections = [
    { heading: "## Goal", label: language === "en" ? "Goal" : "目标" },
    { heading: "## Outline Node", label: language === "en" ? "Outline Node" : "当前节点" },
    { heading: "## Must Keep", label: language === "en" ? "Keep" : "保留" },
    { heading: "## Must Avoid", label: language === "en" ? "Avoid" : "避免" },
    { heading: "## Style Emphasis", label: language === "en" ? "Style" : "风格" },
    { heading: "## Register / Tempo", label: language === "en" ? "Register / Tempo" : "本章火候" },
    { heading: "## Structured Directives", label: language === "en" ? "Directives" : "指令" },
  ] as const;

  const rendered = sections
    .map(({ heading, label }) => {
      const section = extractMarkdownSection(chapterIntent, heading);
      if (!section) return null;

      const lines = section
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !["- none", "- 无", "- 本轮无", "(not found)"].includes(line));
      if (lines.length === 0) return null;

      const normalized = lines
        .map((line) => line.startsWith("- ") ? line.slice(2) : line)
        .map((line) => sanitizeNarrativeControlText(line, language))
        .filter(Boolean)
        .map((line) => `- ${line}`)
        .join("\n");

      return `## ${label}\n${normalized}`;
    })
    .filter((section): section is string => Boolean(section));

  return rendered.join("\n\n");
}

export function resolveChapterHeatTarget(
  memo?: ChapterMemo,
  intent?: ChapterIntent,
): ChapterHeatTarget {
  return {
    register: memo?.register ?? intent?.register ?? "neutral",
    tempo: memo?.tempo ?? intent?.tempo ?? "medium",
  };
}

export function renderChapterHeatCraftBlock(
  heat: ChapterHeatTarget,
  language: "zh" | "en" = "zh",
): string {
  const isEn = language === "en";
  const registerLine = isEn
    ? renderEnglishRegisterDirective(heat.register)
    : renderChineseRegisterDirective(heat.register);
  const tempoLine = isEn
    ? renderEnglishTempoDirective(heat.tempo)
    : renderChineseTempoDirective(heat.tempo);

  if (isEn) {
    return [
      "## Chapter Register / Tempo Craft",
      `- register: ${heat.register}`,
      `- tempo: ${heat.tempo}`,
      "- Priority: this chapter's register/tempo target outranks the book-level style guide and style fingerprint. If they conflict, execute this chapter target.",
      `- Register execution: ${registerLine}`,
      `- Tempo execution: ${tempoLine}`,
    ].join("\n");
  }

  return [
    "## 本章火候 / 场景级 craft",
    `- register: ${heat.register}`,
    `- tempo: ${heat.tempo}`,
    "- 优先级裁决：本章 register/tempo 目标高于全书 style_guide / style fingerprint；两者冲突时执行本章目标。",
    `- register 执行：${registerLine}`,
    `- tempo 执行：${tempoLine}`,
  ].join("\n");
}

function isDefaultChapterHeat(heat: ChapterHeatTarget): boolean {
  return heat.register === "neutral" && heat.tempo === "medium";
}

function renderChineseRegisterDirective(register: ChapterHeatTarget["register"]): string {
  switch (register) {
    case "warm":
      return "温暖章允许直接情感与人物靠近；多用对话、实际照料、肢体接触、温度与气味词，慢镜让位给互动和关系位移。";
    case "tense":
      return "紧张章短促、悬停、信息克制；威胁靠动作和选择逼近，不用大段铺陈解释压力。";
    case "bright":
      return "明快章节奏轻、留白少，动作和结果更干脆；允许更外显的反馈、翻盘感和公开变化。";
    case "dialogue":
      return "对话密章让对话承载冲突、误会、试探或交易；每 3-4 句对白落一个感官锚点或即时身体反应，避免话头悬浮。";
    case "gloomy":
      return "阴郁/勘验章才使用感官微观慢镜；观察、物证、冷光、静默可以多一点，但每段必须带来新信息或内心位移。";
    case "neutral":
      return "中性章按 memo 执行，不额外升温或降温；只保持必要的场景差异。";
  }
}

function renderChineseTempoDirective(tempo: ChapterHeatTarget["tempo"]): string {
  switch (tempo) {
    case "fast":
      return "快节奏用短句、强动词、高行动密度和更碎的段落变化；削减铺陈，优先让冲突在台面上发生。";
    case "medium":
      return "中速保留清楚因果与后果段，段落长短交替，既推进事件也落人物反应。";
    case "slow":
      return "慢节奏允许停驻和余味，但必须把停驻压在互动、物证或关系变化上，避免纯内省原地打转。";
  }
}

function renderEnglishRegisterDirective(register: ChapterHeatTarget["register"]): string {
  switch (register) {
    case "warm":
      return "Allow direct feeling and closeness; use more dialogue, practical care, touch, warmth, smell, and relationship movement instead of lingering slow-motion description.";
    case "tense":
      return "Keep beats clipped, suspended, and information-restrained; pressure should approach through action and choices, not explanatory buildup.";
    case "bright":
      return "Keep the chapter lighter, cleaner, and less withheld; allow visible feedback, public consequence, and decisive movement.";
    case "dialogue":
      return "Let dialogue carry conflict, misunderstanding, probing, or bargaining; every 3-4 exchanges must land a sensory anchor or immediate physical reaction.";
    case "gloomy":
      return "Use micro sensory observation only for investigation/inspection beats; silence, cold light, and evidence can slow the scene, but each paragraph must add information or inner movement.";
    case "neutral":
      return "Follow the memo without extra heating or cooling; preserve only the necessary scene variation.";
  }
}

function renderEnglishTempoDirective(tempo: ChapterHeatTarget["tempo"]): string {
  switch (tempo) {
    case "fast":
      return "Use shorter sentences, stronger verbs, higher action density, and varied short/medium paragraphs; cut setup and let conflict happen on page.";
    case "medium":
      return "Keep causal clarity and consequence beats, alternating paragraph length while advancing both event and reaction.";
    case "slow":
      return "Allow pause and aftertaste, but anchor pauses in interaction, evidence, or relationship change, never static introspection.";
  }
}

export function renderNarrativeSelectedContext(
  entries: ReadonlyArray<ContextPackage["selectedContext"][number]>,
  language: "zh" | "en" = "zh",
): string {
  const heading = language === "en" ? "Evidence" : "证据";
  const reasonLabel = language === "en" ? "reason" : "原因";
  const detailLabel = language === "en" ? "detail" : "细节";

  return entries
    .map((entry, index) => {
      const lines = [
        `### ${heading} ${index + 1}`,
        `- ${reasonLabel}: ${sanitizeNarrativeControlText(entry.reason, language)}`,
        entry.excerpt ? `- ${detailLabel}: ${sanitizeNarrativeControlText(entry.excerpt, language)}` : "",
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n");
}

export function sanitizeNarrativeEvidenceBlock(
  block: string | undefined,
  language: "zh" | "en" = "zh",
): string | undefined {
  if (!block) return undefined;
  const withoutSources = block.replace(
    /(^|\n)-\s+(?:story|runtime)\/[^:\n]+:\s*/g,
    (_match, prefix: string) => `${prefix}- evidence: `,
  );
  return sanitizeNarrativeControlText(withoutSources, language);
}

function extractMarkdownSection(content: string, heading: string): string | undefined {
  const lines = content.split("\n");
  let buffer: string[] | null = null;

  for (const line of lines) {
    if (line.trim() === heading) {
      buffer = [];
      continue;
    }

    if (buffer && line.startsWith("## ") && line.trim() !== heading) {
      break;
    }

    if (buffer) {
      buffer.push(line);
    }
  }

  const section = buffer?.join("\n").trim();
  return section && section.length > 0 ? section : undefined;
}
