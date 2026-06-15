import { readFile, readdir, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BaseAgent } from "./base.js";
import type { BookConfig } from "../models/book.js";
import {
  ContextPackageSchema,
  type ChapterTrace,
  type ContextPackage,
  type RuleStack,
} from "../models/input-governance.js";
import type { PlanChapterOutput } from "./planner.js";
import {
  parseChapterSummariesMarkdown,
  retrieveMemorySelection,
} from "../utils/memory-retrieval.js";
import type { EntityCard } from "../state/memory-db.js";
import {
  buildGovernedRuleStack,
  buildGovernedTrace,
} from "../utils/context-assembly.js";
import { writeGovernedRuntimeArtifacts } from "../utils/runtime-writer.js";
import { readCharacterContext, readCurrentStateWithFallback } from "../utils/outline-paths.js";
import { DEFAULT_CHAPTER_CADENCE_WINDOW } from "../utils/chapter-cadence.js";
import { buildOpeningLedgerBrief } from "../utils/opening-ledger.js";

const DEFAULT_CONTEXT_EXCERPT_CHARS = 1600;

export interface ComposeChapterInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly plan: PlanChapterOutput;
  /** 可选语义向量器(配了 embedding 模型时由 runner 传入);缺省 → 纯词面检索。 */
  readonly embed?: (texts: ReadonlyArray<string>) => Promise<number[][]>;
}

export interface ComposeChapterOutput {
  readonly contextPackage: ContextPackage;
  readonly ruleStack: RuleStack;
  readonly trace: ChapterTrace;
  readonly contextPath: string;
  readonly ruleStackPath: string;
  readonly tracePath: string;
}

export async function composeGovernedChapter(input: ComposeChapterInput): Promise<ComposeChapterOutput> {
  const storyDir = join(input.bookDir, "story");
  const runtimeDir = join(storyDir, "runtime");
  await mkdir(runtimeDir, { recursive: true });

  const selectedContext = await collectSelectedContext(
    storyDir,
    input.plan,
    input.book.language ?? "zh",
    input.embed,
  );
  const contextPackage = ContextPackageSchema.parse({
    chapter: input.chapterNumber,
    selectedContext,
  });

  const ruleStack = buildGovernedRuleStack(input.plan, input.chapterNumber);
  const trace = buildGovernedTrace({
    chapterNumber: input.chapterNumber,
    plan: input.plan,
    contextPackage,
    composerInputs: [input.plan.runtimePath],
  });
  const {
    contextPath,
    ruleStackPath,
    tracePath,
  } = await writeGovernedRuntimeArtifacts({
    runtimeDir,
    chapterNumber: input.chapterNumber,
    contextPackage,
    ruleStack,
    trace,
  });

  return {
    contextPackage,
    ruleStack,
    trace,
    contextPath,
    ruleStackPath,
    tracePath,
  };
}

export class ComposerAgent extends BaseAgent {
  get name(): string {
    return "composer";
  }

  async composeChapter(input: ComposeChapterInput): Promise<ComposeChapterOutput> {
    return composeGovernedChapter(input);
  }
}

/** 把一张实体卡压成一行紧凑注入文本:名字(类型):摘要 状态[…] 关系[…] 邻居[…]。 */
function formatEntityCardExcerpt(card: EntityCard): string {
  const state = card.state.slice(0, 6).map((s) => `${s.predicate}=${s.object}`).join("; ");
  const rels = card.relations.slice(0, 8).map((r) => `${r.predicate}→${r.object}`).join("; ");
  const neighbors = card.neighbors.slice(0, 8).map((n) => n.name).join("、");
  const head = `${card.entity.name}${card.entity.type ? `(${card.entity.type})` : ""}${card.entity.summary ? `:${card.entity.summary}` : ""}`;
  return [head, state ? `状态[${state}]` : "", rels ? `关系[${rels}]` : "", neighbors ? `邻居[${neighbors}]` : ""].filter(Boolean).join(" ");
}

async function collectSelectedContext(
  storyDir: string,
  plan: PlanChapterOutput,
  language: "zh" | "en",
  embed?: (texts: ReadonlyArray<string>) => Promise<number[][]>,
): Promise<ContextPackage["selectedContext"]> {
    const retrievalHints = deriveRetrievalHints(plan);
    const memoBodyExcerpt = plan.memo.body.trim();
    const chapterMemoEntry = memoBodyExcerpt.length > 0
      ? [{
          source: "runtime/chapter_memo",
          reason: "Carry the planner's chapter memo into governed writing.",
          excerpt: [
            `goal=${plan.memo.goal}`,
            plan.memo.isGoldenOpening ? "golden-opening=true" : undefined,
            memoBodyExcerpt,
          ].filter(Boolean).join(" | "),
        }]
      : [{
          source: "runtime/chapter_memo",
          reason: "Carry the planner's chapter memo into governed writing.",
          excerpt: `goal=${plan.memo.goal}`,
        }];

    const entries = await Promise.all([
      maybeContextSource(
        storyDir,
        "author_intent.md",
        "Preserve long-horizon author intent and the book's core promise for premise fidelity.",
      ),
      maybeContextSource(storyDir, "current_focus.md", "Current task focus for this chapter."),
      maybeContextSource(
        storyDir,
        "audit_drift.md",
        "Carry forward audit drift guidance from the previous chapter without polluting hard state facts.",
      ),
      maybeContextSource(
        storyDir,
        "current_state.md",
        "Preserve hard state facts referenced by the active chapter brief or hard constraints.",
        retrievalHints,
      ),
      maybeContextSource(
        storyDir,
        "outline/story_frame.md",
        "Preserve canon constraints referenced by the active chapter brief or hard constraints.",
        retrievalHints,
      ),
      maybeContextSource(
        storyDir,
        "outline/volume_map.md",
        "Anchor the default planning node for this chapter.",
        plan.intent.outlineNode ? [plan.intent.outlineNode] : [],
      ),
      maybeCharacterContextSource(
        storyDir,
        "Preserve role cards / character relationships for governed writing.",
        retrievalHints,
      ),
      maybeContextSource(
        storyDir,
        "parent_canon.md",
        "Preserve parent canon constraints for governed continuation or fanfic writing.",
      ),
      maybeContextSource(
        storyDir,
        "fanfic_canon.md",
        "Preserve extracted fanfic canon constraints for governed writing.",
      ),
    ]);
    const trailEntries = await buildRecentChapterTrailEntries(storyDir, plan.intent.chapter);
    const openingLedgerEntry = await buildOpeningLedgerContextEntry(storyDir, plan.intent.chapter, language);

    const memorySelection = await retrieveMemorySelection({
      bookDir: dirname(storyDir),
      chapterNumber: plan.intent.chapter,
      goal: plan.intent.goal,
      outlineNode: plan.intent.outlineNode,
      mustKeep: retrievalHints,
      embed,
    });
    const hookDebtEntries = await buildHookDebtEntries(
      storyDir,
      plan,
      memorySelection.activeHooks,
      language,
    );

    const summaryEntries = memorySelection.summaries.map((summary) => ({
      source: `story/chapter_summaries.md#${summary.chapter}`,
      reason: "Relevant episodic memory retrieved for the current chapter goal.",
      excerpt: [summary.title, summary.events, summary.stateChanges, summary.hookActivity]
        .filter(Boolean)
        .join(" | "),
    }));
    const factEntries = memorySelection.facts.map((fact) => ({
      source: `story/current_state.md#${toFactAnchor(fact.predicate)}`,
      reason: "Relevant current-state fact retrieved for the current chapter goal.",
      excerpt: `${fact.predicate} | ${fact.object}`,
    }));
    const hookEntries = memorySelection.hooks.map((hook) => ({
      source: `story/pending_hooks.md#${hook.hookId}`,
      reason: "Carry forward unresolved hooks that match the chapter focus.",
      excerpt: [hook.type, hook.status, hook.expectedPayoff, hook.payoffTiming, hook.notes]
        .filter(Boolean)
        .join(" | "),
    }));
    const volumeSummaryEntries = memorySelection.volumeSummaries.map((summary) => ({
      source: `story/volume_summaries.md#${summary.anchor}`,
      reason: "Carry forward long-span arc memory compressed from earlier volumes.",
      excerpt: `${summary.heading} | ${summary.content}`,
    }));
    // Phase 3 · 活的故事知识图谱:把本章触及实体的"当前状态+关系+邻居"按图遍历注入。
    // 确定性、防矛盾(单值状态已自纠错)、防漂移——替代"换说法漏召回"的模糊检索。
    const entityCardEntries = memorySelection.entityCards.map((card) => ({
      source: `story/graph#${card.entity.name}`,
      reason: "活的故事知识图谱:本章相关实体的当前状态/关系(确定性,防矛盾、防漂移)。",
      excerpt: formatEntityCardExcerpt(card),
    }));
    // ② canon 预防:全书已锁定的不可变事实(死亡/血缘/真实身份/永久)——最高优先注入,写手绝不能违反/推翻。
    // 防御性上限:canon 是最高优先级"绝不违反"块,但若病态地累积上百条,无界注入会挤爆 prompt。
    // 取最近锁定的 120 条(现实里 canon 远小于此,不会丢事实;只挡住失控膨胀)。
    const canonForInjection = memorySelection.canonFacts.slice(-120);
    const canonEntries = canonForInjection.length > 0 ? [{
      source: "story/graph#canon",
      reason: "全书已锁定的不可变事实(canon)——绝对不能违反、不能推翻。",
      excerpt: "【锁定事实·绝不能违反】\n" + canonForInjection.map((f) => `- ${f.subject}·${f.predicate} = ${f.object}（第${f.lockedSinceChapter}章锁定,不可逆）`).join("\n"),
    }] : [];

    return [
      ...canonEntries,
      ...chapterMemoEntry,
      ...entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
      ...trailEntries,
      ...openingLedgerEntry,
      ...hookDebtEntries,
      ...entityCardEntries,
      ...factEntries,
      ...summaryEntries,
      ...volumeSummaryEntries,
      ...hookEntries,
    ];
}

async function buildOpeningLedgerContextEntry(
  storyDir: string,
  chapterNumber: number,
  language: "zh" | "en",
): Promise<ContextPackage["selectedContext"]> {
    const brief = await buildOpeningLedgerBrief({
      storyDir,
      currentChapter: chapterNumber,
      keepRecent: DEFAULT_CHAPTER_CADENCE_WINDOW,
      language,
    });
    if (!brief) return [];
    return [{
      source: "story/opening_ledger.md#recent_openings",
      reason: language === "en"
        ? "Keep used opening types and imagery visible so the writer changes the next opening."
        : "把已用开篇类型和招牌意象显式喂给写手，避免下一章复刻开场。",
      excerpt: brief,
    }];
}

function deriveRetrievalHints(plan: PlanChapterOutput): string[] {
  return [
    plan.intent.goal,
    plan.intent.outlineNode,
    ...plan.memo.threadRefs,
  ].filter((value): value is string => Boolean(value));
}

async function buildRecentChapterTrailEntries(
  storyDir: string,
  chapterNumber: number,
): Promise<ContextPackage["selectedContext"]> {
    const content = await readFileOrDefault(join(storyDir, "chapter_summaries.md"));
    if (!content || content === "(文件尚未创建)") {
      return [];
    }

    const recentSummaries = parseChapterSummariesMarkdown(content)
      .filter((summary) => summary.chapter < chapterNumber)
      .sort((left, right) => right.chapter - left.chapter)
      .slice(0, 5);
    if (recentSummaries.length === 0) {
      return [];
    }

    const entries: ContextPackage["selectedContext"] = [];
    const recentTitles = recentSummaries
      .map((summary) => [summary.chapter, summary.title].filter(Boolean).join(": "))
      .filter(Boolean)
      .join(" | ");
    if (recentTitles) {
      entries.push({
        source: "story/chapter_summaries.md#recent_titles",
        reason: "Keep recent title history visible to avoid repetitive chapter naming.",
        excerpt: recentTitles,
      });
    }

    const moodTrail = recentSummaries
      .filter((summary) => summary.mood || summary.chapterType)
      .map((summary) => `${summary.chapter}: ${summary.mood || "(none)"} / ${summary.chapterType || "(none)"}`)
      .join(" | ");
    if (moodTrail) {
      entries.push({
        source: "story/chapter_summaries.md#recent_mood_type_trail",
        reason: "Keep recent mood and chapter-type cadence visible before writing the next chapter.",
        excerpt: moodTrail,
      });
    }

    const endingTrail = await buildRecentEndingTrail(storyDir, chapterNumber);
    if (endingTrail) {
      entries.push({
        source: "story/chapters#recent_endings",
        reason: "Show how recent chapters ended so the writer avoids structural repetition (e.g. 3 consecutive collapse endings).",
        excerpt: endingTrail,
      });
    }

    return entries;
}

async function buildRecentEndingTrail(
  storyDir: string,
  chapterNumber: number,
): Promise<string | undefined> {
    const chaptersDir = join(dirname(storyDir), "chapters");
    try {
      const files = await readdir(chaptersDir);
      const chapterFiles = files
        .filter((file) => file.endsWith(".md"))
        .map((file) => ({ file, num: parseInt(file.slice(0, 4), 10) }))
        .filter((entry) => Number.isFinite(entry.num) && entry.num < chapterNumber)
        .sort((a, b) => b.num - a.num)
        .slice(0, 3);

      const endings: string[] = [];
      for (const entry of chapterFiles.reverse()) {
        const content = await readFile(join(chaptersDir, entry.file), "utf-8");
        const lastLine = extractLastMeaningfulSentence(content);
        if (lastLine) {
          endings.push(`ch${entry.num}: ${lastLine}`);
        }
      }
      return endings.length >= 2 ? endings.join(" | ") : undefined;
    } catch {
      return undefined;
    }
}

function extractLastMeaningfulSentence(content: string): string | undefined {
    const lines = content.split("\n").map((line) => line.trim()).filter((line) =>
      line.length > 5 && !line.startsWith("#") && !line.startsWith("|") && !line.startsWith("==="),
    );
    const last = lines.at(-1);
    if (!last) return undefined;
    return last.length > 60 ? last.slice(0, 57) + "..." : last;
}

async function buildHookDebtEntries(
  storyDir: string,
  plan: PlanChapterOutput,
  activeHooks: ReadonlyArray<{
      readonly hookId: string;
      readonly startChapter: number;
      readonly type: string;
      readonly status: string;
      readonly lastAdvancedChapter: number;
      readonly expectedPayoff: string;
      readonly payoffTiming?: string;
      readonly notes: string;
    }>,
  language: "zh" | "en",
): Promise<ContextPackage["selectedContext"]> {
    const targetHookIds = [...new Set(plan.memo.threadRefs)];
    if (targetHookIds.length === 0) {
      return [];
    }

    const summaries = parseChapterSummariesMarkdown(
      await readFileOrDefault(join(storyDir, "chapter_summaries.md")),
    );

    return targetHookIds.flatMap((hookId) => {
      const hook = activeHooks.find((entry) => entry.hookId === hookId);
      if (!hook) {
        return [];
      }

      const seedSummary = findHookSummary(summaries, hook.hookId, hook.startChapter, "seed");
      const latestSummary = findHookSummary(summaries, hook.hookId, hook.lastAdvancedChapter, "latest");
      const role = language === "en" ? "memo-referenced debt" : "备忘引用旧债";
      const promise = hook.expectedPayoff || (language === "en" ? "(unspecified)" : "（未写明）");
      const seedBeat = seedSummary
        ? renderHookDebtBeat(seedSummary)
        : (hook.notes || promise);
      const latestBeat = latestSummary && latestSummary !== seedSummary
        ? renderHookDebtBeat(latestSummary)
        : undefined;
      const age = Math.max(0, plan.intent.chapter - Math.max(1, hook.startChapter));

      return [{
        source: `runtime/hook_debt#${hook.hookId}`,
        reason: language === "en"
          ? "Narrative debt brief with original seed text for this hook agenda target."
          : "含原始种子文本的叙事债务简报。",
        excerpt: language === "en"
          ? [
              `${hook.hookId} (${hook.type}, ${role}, open ${age} chapters)`,
              `reader promise: ${promise}`,
              `original seed (ch${hook.startChapter}): ${seedBeat}`,
              latestBeat ? `latest turn (ch${hook.lastAdvancedChapter}): ${latestBeat}` : undefined,
            ].filter(Boolean).join(" | ")
          : [
              `${hook.hookId}（${hook.type}，${role}，已开${age}章）`,
              `读者承诺：${promise}`,
              `种于第${hook.startChapter}章：${seedBeat}`,
              latestBeat ? `推进于第${hook.lastAdvancedChapter}章：${latestBeat}` : undefined,
            ].filter(Boolean).join(" | "),
      }];
    });
}

async function maybeContextSource(
  storyDir: string,
  fileName: string,
  reason: string,
  preferredExcerpts: ReadonlyArray<string> = [],
): Promise<ContextPackage["selectedContext"][number] | null> {
    const path = join(storyDir, fileName);
    let content = fileName === "current_state.md"
      ? await readCurrentStateWithFallback(dirname(storyDir), "(文件尚未创建)")
      : await readFileOrDefault(path);
    let resolvedFileName = fileName;

    if ((!content || content === "(文件尚未创建)")) {
      // Phase 5 back-compat: the new outline/ files may be absent on legacy
      // books. Fall back to the deprecated paths transparently.
      const legacyFallback = outlineFallback(fileName);
      if (legacyFallback) {
        const legacyPath = join(storyDir, legacyFallback);
        const legacyContent = await readFileOrDefault(legacyPath);
        if (legacyContent && legacyContent !== "(文件尚未创建)") {
          content = legacyContent;
          resolvedFileName = legacyFallback;
        }
      }
    }

    if (!content || content === "(文件尚未创建)") return null;

    return {
      source: `story/${resolvedFileName}`,
      reason,
      excerpt: pickExcerpt(content, preferredExcerpts),
    };
}

async function maybeCharacterContextSource(
  storyDir: string,
  reason: string,
  preferredExcerpts: ReadonlyArray<string> = [],
): Promise<ContextPackage["selectedContext"][number] | null> {
    const content = await readCharacterContext(dirname(storyDir), "");
    if (!content.trim()) return null;

    return {
      source: "story/roles",
      reason,
      excerpt: pickExcerpt(content, preferredExcerpts),
    };
}

function outlineFallback(fileName: string): string | null {
    if (fileName === "outline/story_frame.md") return "story_bible.md";
    if (fileName === "outline/volume_map.md") return "volume_outline.md";
    return null;
}

function pickExcerpt(content: string, preferredExcerpts: ReadonlyArray<string>): string | undefined {
    for (const preferred of preferredExcerpts) {
      if (preferred && content.includes(preferred)) return preferred;
    }

    const withoutFrontmatter = stripLeadingFrontmatter(content);
    const tableExcerpt = pickTableExcerpt(withoutFrontmatter);
    if (tableExcerpt) return tableExcerpt;

    const meaningful = withoutFrontmatter
      .split("\n")
      .map((line) => line.trim())
      .filter((line) =>
        line.length > 0
        && !line.startsWith("#")
        && line !== "---"
        && !line.startsWith(">")
        && !/^[-*]\s*(outline\/|roles\/|权威来源|Authoritative source)/i.test(line)
        && line !== "显示代码",
      )
      .join("\n")
      .trim();

    return clipExcerpt(meaningful || withoutFrontmatter.trim());
}

function stripLeadingFrontmatter(content: string): string {
    const lines = content.split("\n");
    if (lines[0]?.trim() !== "---") return content;

    const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (closingIndex < 0) return content;
    return lines.slice(closingIndex + 1).join("\n");
}

function pickTableExcerpt(content: string): string | undefined {
    const dataRows = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) =>
        line.startsWith("|")
        && line.endsWith("|")
        && !/^\|\s*-+/.test(line)
        && !/^\|\s*(字段|field|chapter|章节)\s*\|/i.test(line),
      );

    if (dataRows.length === 0) return undefined;
    return clipExcerpt(dataRows.slice(0, 8).join("\n"));
}

function clipExcerpt(excerpt: string): string | undefined {
    const trimmed = excerpt.trim();
    if (!trimmed) return undefined;
    return trimmed.length > DEFAULT_CONTEXT_EXCERPT_CHARS
      ? `${trimmed.slice(0, DEFAULT_CONTEXT_EXCERPT_CHARS - 1)}…`
      : trimmed;
}

function toFactAnchor(predicate: string): string {
    return predicate
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      || "fact";
}

async function readFileOrDefault(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "(文件尚未创建)";
  }
}

function findHookSummary(
  summaries: ReadonlyArray<ReturnType<typeof parseChapterSummariesMarkdown>[number]>,
  hookId: string,
  chapter: number,
  mode: "seed" | "latest",
) {
  const directChapterHit = summaries.find((summary) => summary.chapter === chapter);
  const hookMentions = summaries.filter((summary) => summaryMentionsHook(summary, hookId));
  if (mode === "seed") {
    return hookMentions.find((summary) => summary.chapter === chapter)
      ?? hookMentions.at(0)
      ?? directChapterHit;
  }

  return [...hookMentions].reverse().find((summary) => summary.chapter === chapter)
    ?? hookMentions.at(-1)
    ?? directChapterHit;
}

function summaryMentionsHook(
  summary: ReturnType<typeof parseChapterSummariesMarkdown>[number],
  hookId: string,
): boolean {
  return [
    summary.title,
    summary.events,
    summary.stateChanges,
    summary.hookActivity,
  ].some((text) => text.includes(hookId));
}

function renderHookDebtBeat(
  summary: ReturnType<typeof parseChapterSummariesMarkdown>[number],
): string {
  return `ch${summary.chapter} ${summary.title} - ${summary.events || summary.hookActivity || summary.stateChanges || "(none)"}`;
}
