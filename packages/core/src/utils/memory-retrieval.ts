import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readCurrentStateWithFallback } from "./outline-paths.js";
import {
  ChapterSummariesStateSchema,
  CurrentStateStateSchema,
  HooksStateSchema,
} from "../models/runtime-state.js";
import { MemoryDB, type EntityCard, type Fact, type GraphEntity, type StoredHook, type StoredSummary } from "../state/memory-db.js";
import { bootstrapStructuredStateFromMarkdown } from "../state/state-bootstrap.js";
import { hybridRank } from "./embedding.js";
import {
  filterActiveHooks,
  isFuturePlannedHook,
  isHookWithinChapterWindow,
} from "./hook-lifecycle.js";
import {
  parseChapterSummariesMarkdown,
  parseCurrentStateFacts,
  parsePendingHooksMarkdown,
} from "./story-markdown.js";
export {
  isFuturePlannedHook,
  isHookWithinChapterWindow,
} from "./hook-lifecycle.js";
export {
  parseChapterSummariesMarkdown,
  parseCurrentStateFacts,
  parsePendingHooksMarkdown,
  renderHookSnapshot,
  renderSummarySnapshot,
} from "./story-markdown.js";

export interface MemorySelection {
  readonly summaries: ReadonlyArray<StoredSummary>;
  readonly hooks: ReadonlyArray<StoredHook>;
  readonly activeHooks: ReadonlyArray<StoredHook>;
  /**
   * Hooks with recycling pressure — stale hooks that the planner must
   * advance/resolve/defer (and if deferred, justify). Sorted by staleness DESC
   * (most overdue first). See computeRecyclableHooks for the selection rule.
   */
  readonly recyclableHooks: ReadonlyArray<StoredHook>;
  readonly facts: ReadonlyArray<Fact>;
  readonly volumeSummaries: ReadonlyArray<VolumeSummarySelection>;
  /** 活的故事知识图谱:本章触及实体的卡片(当前状态 + 关系 + 邻居),图遍历注入用,确定性防矛盾。 */
  readonly entityCards: ReadonlyArray<EntityCard>;
  /** 全书已锁定的不可变事实(死亡/血缘/真实身份/永久),注入写手做"绝不能违反"的预防。 */
  readonly canonFacts: ReadonlyArray<{ readonly subject: string; readonly predicate: string; readonly object: string; readonly lockedSinceChapter: number }>;
  readonly dbPath?: string;
}

export interface VolumeSummarySelection {
  readonly heading: string;
  readonly content: string;
  readonly anchor: string;
}

export async function retrieveMemorySelection(params: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly goal: string;
  readonly outlineNode?: string;
  readonly mustKeep?: ReadonlyArray<string>;
  /**
   * 可选语义向量器(批量取 embedding)。配置了 embedding 模型时由 composer 传入,
   * 用于把"词面命中候选池"按语义相似度重排,堵住"换说法漏召回"。
   * 未传 / 抛错 / 返回空向量 → 自动退化为纯词面检索(零行为变化,保护写作主链)。
   */
  readonly embed?: (texts: ReadonlyArray<string>) => Promise<number[][]>;
}): Promise<MemorySelection> {
  const storyDir = join(params.bookDir, "story");
  const stateDir = join(storyDir, "state");
  const fallbackChapter = Math.max(0, params.chapterNumber - 1);

  await bootstrapStructuredStateFromMarkdown({
    bookDir: params.bookDir,
    fallbackChapter,
  }).catch(() => undefined);

  const [
    currentStateMarkdown,
    volumeSummariesMarkdown,
    structuredCurrentState,
    structuredHooks,
    structuredSummaries,
  ] = await Promise.all([
    readCurrentStateWithFallback(params.bookDir),
    readFile(join(storyDir, "volume_summaries.md"), "utf-8").catch(() => ""),
    readStructuredState(join(stateDir, "current_state.json"), CurrentStateStateSchema),
    readStructuredState(join(stateDir, "hooks.json"), HooksStateSchema),
    readStructuredState(join(stateDir, "chapter_summaries.json"), ChapterSummariesStateSchema),
  ]);
  const facts = structuredCurrentState?.facts ?? parseCurrentStateFacts(
    currentStateMarkdown,
    fallbackChapter,
  );
  const narrativeQueryTerms = extractQueryTerms(
    params.goal,
    params.outlineNode,
    [],
  );
  // 语义检索用的自然语言查询(本章意图);仅在传入 embed 时使用。
  const semanticQueryText = [stripNegativeGuidance(params.goal), params.outlineNode ?? ""].join(" ").trim();
  const factQueryTerms = extractQueryTerms(
    params.goal,
    params.outlineNode,
    params.mustKeep ?? [],
  );
  const volumeSummaries = selectRelevantVolumeSummaries(
    parseVolumeSummariesMarkdown(volumeSummariesMarkdown),
    narrativeQueryTerms,
  );

  const memoryDb = openMemoryDB(params.bookDir);
  if (memoryDb) {
    try {
      const summaries = structuredSummaries?.rows ?? parseChapterSummariesMarkdown(
        await readFile(join(storyDir, "chapter_summaries.md"), "utf-8").catch(() => ""),
      );
      if (summaries.length > 0) {
        memoryDb.replaceSummaries(summaries);
      }

      const hooks = structuredHooks?.hooks ?? parsePendingHooksMarkdown(
        await readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
      );
      if (hooks.length > 0) {
        memoryDb.replaceHooks(hooks);
      }

      if (facts.length > 0) {
        memoryDb.replaceCurrentFacts(facts);
      }

      const activeHooks = memoryDb.getActiveHooks();
      const pickedSummaries = await pickSummaries(
        memoryDb.getSummaries(1, Math.max(1, params.chapterNumber - 1)),
        params.chapterNumber,
        narrativeQueryTerms,
        semanticQueryText,
        params.embed,
      );
      const entityCards = selectEntityCards(memoryDb, [semanticQueryText, narrativeQueryTerms.join(" ")].join(" "), params.chapterNumber);

      return {
        summaries: pickedSummaries,
        entityCards,
        canonFacts: memoryDb.getCanonFacts(),
        hooks: selectRelevantHooks(activeHooks, narrativeQueryTerms, params.chapterNumber),
        activeHooks,
        recyclableHooks: computeRecyclableHooks(activeHooks, params.chapterNumber),
        facts: await pickFacts(memoryDb.getCurrentFacts(), factQueryTerms, semanticQueryText, params.embed),
        volumeSummaries,
        dbPath: join(storyDir, "memory.db"),
      };
    } finally {
      memoryDb.close();
    }
  }

  const [summariesMarkdown, hooksMarkdown] = await Promise.all([
    readFile(join(storyDir, "chapter_summaries.md"), "utf-8").catch(() => ""),
    readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
  ]);
  const summaries = structuredSummaries?.rows ?? parseChapterSummariesMarkdown(summariesMarkdown);
  const hooks = structuredHooks?.hooks ?? parsePendingHooksMarkdown(hooksMarkdown);
  const activeHooks = filterActiveHooks(hooks);
  const pickedFallbackSummaries = await pickSummaries(
    summaries,
    params.chapterNumber,
    narrativeQueryTerms,
    semanticQueryText,
    params.embed,
  );

  return {
    summaries: pickedFallbackSummaries,
    entityCards: [], // 无 memory.db(图谱在 SQLite)→ 纯 markdown 回退路径不带实体卡
    canonFacts: [],
    hooks: selectRelevantHooks(activeHooks, narrativeQueryTerms, params.chapterNumber),
    activeHooks,
    recyclableHooks: computeRecyclableHooks(activeHooks, params.chapterNumber),
    facts: await pickFacts(facts, factQueryTerms, semanticQueryText, params.embed),
    volumeSummaries,
  };
}

/**
 * Phase 9-2: Hooks that the planner MUST address this chapter.
 *
 * An active hook is "recyclable" (i.e., stale enough to force an
 * advance/resolve/defer decision) when any of the following holds:
 *
 *   - pressured / near_payoff / progressing: silent for ≥ 5 chapters
 *   - planted / open: silent for ≥ 10 chapters
 *   - coreHook === true:                      silent for ≥ 8 chapters
 *
 * "Silent" = (chapterNumber − max(startChapter, lastAdvancedChapter)).
 * Future-planted hooks are excluded (they aren't overdue yet).
 * Sorted by silence DESC — most overdue first — so the planner sees the
 * worst debt at the top of its prompt slice.
 */
/**
 * 图遍历选卡:从活图谱里挑本章要注入的实体卡。
 * 永远带上"主角代理"(listEntities 按 last_chapter DESC,出场最多者排首=主角),
 * 再加上"名字/别名命中本章意图文本"的实体,封顶 limit。确定性、无相似度、防矛盾。
 */
function selectEntityCards(db: MemoryDB, focusText: string, chapterNumber: number, limit = 6): EntityCard[] {
  let entities: ReadonlyArray<GraphEntity> = [];
  try { entities = db.listEntities(); } catch { return []; }
  if (entities.length === 0) return [];
  const text = focusText.toLowerCase();
  const matched = entities.filter((e) => {
    const names = [e.name, ...String(e.aliases || "").split(",")].map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 2);
    return names.some((n) => text.includes(n));
  });
  const ordered: GraphEntity[] = [];
  const seen = new Set<string>();
  for (const e of [entities[0], ...matched]) {
    if (e && !seen.has(e.id)) { seen.add(e.id); ordered.push(e); }
  }
  return ordered.slice(0, limit)
    .map((e) => { try { return db.getEntityCard(e.id, chapterNumber); } catch { return null; } })
    .filter((c): c is EntityCard => Boolean(c));
}

export function computeRecyclableHooks(
  hooks: ReadonlyArray<StoredHook>,
  chapterNumber: number,
): StoredHook[] {
  return hooks
    .filter((hook) => !isRecycleTerminalStatus(hook.status))
    .filter((hook) => !isFuturePlannedHook(hook, chapterNumber))
    .map((hook) => ({ hook, silence: hookSilence(hook, chapterNumber) }))
    .filter(({ hook, silence }) => silence >= recycleThreshold(hook))
    .sort((a, b) => b.silence - a.silence || a.hook.startChapter - b.hook.startChapter)
    .map(({ hook }) => hook);
}

function isRecycleTerminalStatus(status: string): boolean {
  return /^(resolved|closed|done|已回收|已解决|deferred|paused|hold|延后|延期|搁置|暂缓)$/i.test(status.trim());
}

function hookSilence(hook: StoredHook, chapterNumber: number): number {
  const lastTouch = Math.max(hook.startChapter, hook.lastAdvancedChapter);
  if (lastTouch <= 0) return chapterNumber;
  return Math.max(0, chapterNumber - lastTouch);
}

function recycleThreshold(hook: StoredHook): number {
  const status = hook.status.trim().toLowerCase();
  if (/pressured|near[_\s-]?payoff|progressing|重大推进|持续推进/.test(status)) return 5;
  if (hook.coreHook === true) return 8;
  return 10;
}

export function extractQueryTerms(goal: string, outlineNode: string | undefined, mustKeep: ReadonlyArray<string>): string[] {
  const primaryTerms = uniqueTerms([
    ...extractTermsFromText(stripNegativeGuidance(goal)),
    ...mustKeep.flatMap((item) => extractTermsFromText(item)),
  ]);

  if (primaryTerms.length >= 2) {
    return primaryTerms.slice(0, 12);
  }

  return uniqueTerms([
    ...primaryTerms,
    ...extractTermsFromText(stripNegativeGuidance(outlineNode ?? "")),
  ]).slice(0, 12);
}

let warnedMemoryDbUnavailable = false;
function openMemoryDB(bookDir: string): MemoryDB | null {
  try {
    return new MemoryDB(bookDir);
  } catch (error) {
    // SQLite(node:sqlite,Node 22+)不可用时,canon 锁定/矛盾守门/图谱记忆会整条静默退化到 markdown 兜底。
    // 至少 warn 一次,否则用户完全无法察觉"连续性预防已关闭"(老 Node 环境的高危静默失效)。
    if (!warnedMemoryDbUnavailable) {
      warnedMemoryDbUnavailable = true;
      console.warn(
        `[memory] SQLite 记忆库不可用,canon/矛盾守门/图谱召回已退化到 markdown 兜底(连续性预防能力下降)。原因:${(error as Error)?.message ?? error}`,
      );
    }
    return null;
  }
}

async function readStructuredState<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return schema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function extractTermsFromText(text: string): string[] {
  if (!text.trim()) return [];

  const stopWords = new Set([
    "bring", "focus", "back", "chapter", "clear", "narrative", "before", "opening",
    "track", "the", "with", "from", "that", "this", "into", "still", "cannot",
    "current", "state", "advance", "conflict", "story", "keep", "must", "local",
    "does", "not", "only", "just", "then", "than",
  ]);

  const normalized = text.replace(/第\d+章/g, " ");
  const english = (normalized.match(/[a-z]{4,}/gi) ?? [])
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .filter((term) => !stopWords.has(term.toLowerCase()));

  const chineseSegments = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const chinese = chineseSegments.flatMap((segment) => extractChineseFocusTerms(segment));

  return [...english, ...chinese];
}

function extractChineseFocusTerms(segment: string): string[] {
  const stripped = segment
    .replace(/^(本章|继续|重新|拉回|回到|推进|优先|围绕|聚焦|坚持|保持|把注意力|注意力|将注意力|请把注意力|先把注意力)+/, "")
    .replace(/^(处理|推进|回拉|拉回到)+/, "")
    .trim();

  const target = stripped.length >= 2 ? stripped : segment;
  const terms = new Set<string>();

  if (target.length <= 4) {
    terms.add(target);
  }

  for (let size = 2; size <= 4; size += 1) {
    if (target.length >= size) {
      terms.add(target.slice(-size));
    }
  }

  return [...terms].filter((term) => term.length >= 2);
}

function stripNegativeGuidance(text: string): string {
  if (!text) return "";

  return text
    .replace(/\b(do not|don't|avoid|without|instead of)\b[\s\S]*$/i, " ")
    .replace(/(?:不要|不让|别|禁止|避免|但不允许)[\s\S]*$/u, " ")
    .trim();
}

function uniqueTerms(terms: ReadonlyArray<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const term of terms) {
    const normalized = term.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(term.trim());
  }

  return result;
}

function parseVolumeSummariesMarkdown(markdown: string): VolumeSummarySelection[] {
  if (!markdown.trim()) return [];

  const sections = markdown
    .split(/^##\s+/m)
    .map((section) => section.trim())
    .filter(Boolean);

  return sections.map((section) => {
    const [headingLine, ...bodyLines] = section.split("\n");
    const heading = headingLine?.trim() ?? "";
    const content = bodyLines.join("\n").trim();

    return {
      heading,
      content,
      anchor: slugifyAnchor(heading),
    };
  }).filter((section) => section.heading.length > 0 && section.content.length > 0);
}

function isUnresolvedHook(status: string): boolean {
  return status.trim().length === 0 || /open|待定|推进|active|progressing/i.test(status);
}

/**
 * 选本章要注入的历史章摘要。词面优先(保证有界、确定性、零依赖);
 * 若传入 embed 则在词面候选池上做语义重排,堵住"换说法漏召回"。
 * 任何 embedding 失败/不可用 → 退回纯词面结果(与不传 embed 完全一致)。
 */
async function pickSummaries(
  rawSummaries: ReadonlyArray<StoredSummary>,
  chapterNumber: number,
  queryTerms: ReadonlyArray<string>,
  queryText: string,
  embed?: (texts: ReadonlyArray<string>) => Promise<number[][]>,
): Promise<StoredSummary[]> {
  const lexical = selectRelevantSummaries(rawSummaries, chapterNumber, queryTerms);
  if (!embed || !queryText.trim()) return lexical;
  try {
    const reranked = await semanticRerankSummaries(rawSummaries, chapterNumber, queryTerms, queryText, embed, 4);
    return reranked ?? lexical;
  } catch {
    return lexical; // 语义层任何异常都不许影响写作主链
  }
}

async function semanticRerankSummaries(
  rawSummaries: ReadonlyArray<StoredSummary>,
  chapterNumber: number,
  queryTerms: ReadonlyArray<string>,
  queryText: string,
  embed: (texts: ReadonlyArray<string>) => Promise<number[][]>,
  limit: number,
): Promise<StoredSummary[] | null> {
  // 词面候选池(比最终注入更宽,给语义重排留空间):过去章 + (命中 OR 最近 6 章),按词面分取前 16。
  const pool = rawSummaries
    .filter((summary) => summary.chapter < chapterNumber)
    .map((summary) => {
      const text = [summary.title, summary.characters, summary.events, summary.stateChanges, summary.hookActivity, summary.chapterType]
        .filter(Boolean)
        .join(" ");
      return { summary, lex: scoreSummary(summary, chapterNumber, queryTerms), text, matched: matchesAny(text, queryTerms) };
    })
    .filter((entry) => entry.matched || entry.summary.chapter >= chapterNumber - 6)
    .sort((left, right) => right.lex - left.lex || right.summary.chapter - left.summary.chapter)
    .slice(0, 16);
  if (pool.length <= limit) {
    return pool.slice(0, limit).map((entry) => entry.summary).sort((a, b) => a.chapter - b.chapter);
  }
  const vectors = await embed([queryText, ...pool.map((entry) => entry.text)]);
  const queryVec = vectors[0];
  if (!queryVec || queryVec.length === 0) return null; // embedding 不可用 → 上层退回词面
  const candidateVecs = vectors.slice(1);
  // embedding 服务可能少返向量(超时/部分失败):向量数与候选池不齐时 candidateVecs[i]=undefined,
  // 传进 hybridRank 会让 cosine 的 .length 崩或排序静默错乱。数量不齐就整体退回词面(上层 ?? lexical)。
  if (candidateVecs.length !== pool.length) return null;
  const ranked = hybridRank({
    queryVec,
    candidates: pool.map((entry, index) => ({ lexicalScore: entry.lex, vec: candidateVecs[index] })),
  });
  return ranked.slice(0, limit).map((index) => pool[index]!.summary).sort((a, b) => a.chapter - b.chapter);
}

/**
 * 选当前事实:先词面(selectRelevantFacts),配了 embed 再在候选池上做语义重排,
 * 堵住"本章用词≠事实用词就漏召回"(关键词召回的死穴)。embedding 失败/不可用 → 退回纯词面。
 */
async function pickFacts(
  facts: ReadonlyArray<Fact>,
  queryTerms: ReadonlyArray<string>,
  queryText: string,
  embed?: (texts: ReadonlyArray<string>) => Promise<number[][]>,
): Promise<Fact[]> {
  const lexical = selectRelevantFacts(facts, queryTerms);
  if (!embed || !queryText.trim() || lexical.length <= 1) return lexical;
  try {
    const reranked = await semanticRerankFacts(facts, queryTerms, queryText, embed, lexical.length);
    return reranked ?? lexical;
  } catch {
    return lexical;
  }
}

async function semanticRerankFacts(
  facts: ReadonlyArray<Fact>,
  queryTerms: ReadonlyArray<string>,
  queryText: string,
  embed: (texts: ReadonlyArray<string>) => Promise<number[][]>,
  limit: number,
): Promise<Fact[] | null> {
  // 词面候选池(比最终注入宽,给语义重排留空间):按词面命中分取前 24。
  const pool = facts
    .map((fact) => {
      const text = [fact.subject, fact.predicate, fact.object].join(" ");
      const lex = queryTerms.reduce((s, t) => s + (includesTerm(text, t) ? Math.max(8, t.length * 2) : 0), 1);
      return { fact, lex, text };
    })
    .sort((a, b) => b.lex - a.lex)
    .slice(0, 24);
  if (pool.length <= limit) return pool.slice(0, limit).map((e) => e.fact);
  const vectors = await embed([queryText, ...pool.map((e) => e.text)]);
  const queryVec = vectors[0];
  if (!queryVec || queryVec.length === 0) return null; // embedding 不可用 → 上层退回词面
  const candidateVecs = vectors.slice(1);
  // 同上:向量数与候选池不齐(embedding 少返)就退回词面,避免 undefined 向量进 hybridRank。
  if (candidateVecs.length !== pool.length) return null;
  const ranked = hybridRank({
    queryVec,
    candidates: pool.map((e, i) => ({ lexicalScore: e.lex, vec: candidateVecs[i] })),
  });
  return ranked.slice(0, limit).map((i) => pool[i]!.fact);
}

function selectRelevantSummaries(
  summaries: ReadonlyArray<StoredSummary>,
  chapterNumber: number,
  queryTerms: ReadonlyArray<string>,
): StoredSummary[] {
  return summaries
    .filter((summary) => summary.chapter < chapterNumber)
    .map((summary) => ({
      summary,
      score: scoreSummary(summary, chapterNumber, queryTerms),
      matched: matchesAny([
        summary.title,
        summary.characters,
        summary.events,
        summary.stateChanges,
        summary.hookActivity,
        summary.chapterType,
      ].join(" "), queryTerms),
    }))
    .filter((entry) => entry.matched || entry.summary.chapter >= chapterNumber - 3)
    .sort((left, right) => right.score - left.score || right.summary.chapter - left.summary.chapter)
    .slice(0, 4)
    .map((entry) => entry.summary)
    .sort((left, right) => left.chapter - right.chapter);
}

function selectRelevantHooks(
  hooks: ReadonlyArray<StoredHook>,
  queryTerms: ReadonlyArray<string>,
  chapterNumber: number,
): StoredHook[] {
  const ranked = hooks
    .map((hook) => ({
      hook,
      score: scoreHook(hook, queryTerms, chapterNumber),
      matched: matchesAny(
        [hook.hookId, hook.type, hook.expectedPayoff, hook.payoffTiming ?? "", hook.notes].join(" "),
        queryTerms,
      ),
    }))
    .filter((entry: { hook: StoredHook; score: number; matched: boolean }) =>
      entry.matched || isUnresolvedHook(entry.hook.status),
    );

  const primary = ranked
    .filter((entry: { hook: StoredHook; score: number; matched: boolean }) =>
      entry.matched || isHookWithinChapterWindow(entry.hook, chapterNumber, 5),
    )
    .sort((left, right) => right.score - left.score || right.hook.lastAdvancedChapter - left.hook.lastAdvancedChapter)
    .slice(0, 6);

  const selectedIds = new Set(primary.map((entry: { hook: StoredHook; score: number; matched: boolean }) => entry.hook.hookId));
  const stale = ranked
    .filter((entry: { hook: StoredHook; score: number; matched: boolean }) =>
      !selectedIds.has(entry.hook.hookId)
      && !isFuturePlannedHook(entry.hook, chapterNumber)
      && isUnresolvedHook(entry.hook.status),
    )
    .sort((left, right) => left.hook.lastAdvancedChapter - right.hook.lastAdvancedChapter || right.score - left.score)
    .slice(0, 2);

  return [...primary, ...stale].map((entry: { hook: StoredHook; score: number; matched: boolean }) => entry.hook);
}

function selectRelevantFacts(
  facts: ReadonlyArray<Fact>,
  queryTerms: ReadonlyArray<string>,
): Fact[] {
  const prioritizedPredicates = [
    /^(当前冲突|current conflict)$/i,
    /^(当前目标|current goal)$/i,
    /^(主角状态|protagonist state)$/i,
    /^(当前限制|current constraint)$/i,
    /^(当前位置|current location)$/i,
    /^(当前敌我|current alliances|current relationships)$/i,
  ];

  return facts
    .map((fact) => {
      const text = [fact.subject, fact.predicate, fact.object].join(" ");
      const priority = prioritizedPredicates.findIndex((pattern) => pattern.test(fact.predicate));
      const baseScore = priority === -1 ? 5 : 20 - priority * 2;
      const termScore = queryTerms.reduce(
        (score, term) => score + (includesTerm(text, term) ? Math.max(8, term.length * 2) : 0),
        0,
      );

      return {
        fact,
        score: baseScore + termScore,
        matched: matchesAny(text, queryTerms),
      };
    })
    .filter((entry) => entry.matched || entry.score >= 14)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map((entry) => entry.fact);
}

function selectRelevantVolumeSummaries(
  summaries: ReadonlyArray<VolumeSummarySelection>,
  queryTerms: ReadonlyArray<string>,
): VolumeSummarySelection[] {
  if (summaries.length === 0) return [];

  const ranked = summaries
    .map((summary, index) => {
      const text = `${summary.heading} ${summary.content}`;
      const termScore = queryTerms.reduce(
        (score, term) => score + (includesTerm(text, term) ? Math.max(8, term.length * 2) : 0),
        0,
      );

      return {
        index,
        summary,
        score: termScore + index,
        matched: matchesAny(text, queryTerms),
      };
    })
    .filter((entry, index, all) => entry.matched || index === all.length - 1)
    .sort((left, right) => right.score - left.score)
    .slice(0, 2)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.summary);

  return ranked;
}

function scoreSummary(summary: StoredSummary, chapterNumber: number, queryTerms: ReadonlyArray<string>): number {
  const text = [
    summary.title,
    summary.characters,
    summary.events,
    summary.stateChanges,
    summary.hookActivity,
    summary.chapterType,
  ].join(" ");
  const age = Math.max(0, chapterNumber - summary.chapter);
  const recencyScore = Math.max(0, 12 - age);
  const termScore = queryTerms.reduce((score, term) => score + (includesTerm(text, term) ? Math.max(8, term.length * 2) : 0), 0);
  return recencyScore + termScore;
}

function scoreHook(
  hook: StoredHook,
  queryTerms: ReadonlyArray<string>,
  _chapterNumber: number,
): number {
  const text = [hook.hookId, hook.type, hook.expectedPayoff, hook.payoffTiming ?? "", hook.notes].join(" ");
  const freshness = Math.max(0, hook.lastAdvancedChapter);
  const termScore = queryTerms.reduce((score, term) => score + (includesTerm(text, term) ? Math.max(8, term.length * 2) : 0), 0);
  return termScore + freshness;
}

function matchesAny(text: string, queryTerms: ReadonlyArray<string>): boolean {
  return queryTerms.some((term) => includesTerm(text, term));
}

function includesTerm(text: string, term: string): boolean {
  return text.toLowerCase().includes(term.toLowerCase());
}

function slugifyAnchor(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "volume-summary";
}
