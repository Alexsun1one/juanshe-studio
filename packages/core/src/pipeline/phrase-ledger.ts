/**
 * 全书复读账本(phrase-ledger)——零 LLM 的跨章 n-gram 复读统计。
 *
 * 单章查重(4-gram/6-gram)对「每章各出现一次」的口头禅完全失明:
 * 『手指悬在屏幕上方』在 14 章里出现 12 次、每章只 1 次,任何单章检测都看不见。
 * 账本随书持久化在 story/runtime/phrase-ledger.json,按章存计数 → 同章重写/复修幂等;
 * 任一短语全书累计 ≥4 次即进「已用滥表达」清单,两路下发:
 *   ① 复修闭环(chapter-review-cycle)对新稿命中逐条出 warning,reviser 拿原句定点换写,
 *      并经 audit_drift.md 注入下一章写手的「上一章审计纠偏」块;
 *   ② engine runBook 路径由 engine-bridge 把清单并入下一章 priorContext。
 * 人名/地名/物件用与 story-graph 同源的实体字典(character_matrix)过滤,不进账本。
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { atomicWriteFile } from "../utils/fs-atomic.js";
import { parseCharacterMatrix } from "../knowledge/character-matrix.js";
import type { AuditIssue } from "../agents/continuity.js";

export interface OverusedPhrase {
  readonly phrase: string;
  /** 全书累计出现次数。 */
  readonly count: number;
  /** 出现过该短语的章数。 */
  readonly chapters: number;
}

/** 账本文件:phrase → { 章号: 该章出现次数 }。按章存使同章重写可整章替换,幂等。 */
interface PhraseLedgerFile {
  readonly version: 1;
  readonly updatedAt: string;
  readonly phrases: Record<string, Record<string, number>>;
}

const LEDGER_RELATIVE_PATH = join("story", "runtime", "phrase-ledger.json");
const MIN_N = 3;
const MAX_N = 6;
/** 全书累计达到该次数即视为「已用滥」。 */
const OVERUSE_THRESHOLD = 4;
/** 清单上限:注入写手上下文/issues 的条数,避免占用过多 token。 */
const REPORT_LIMIT = 10;
/** 只出现 1 次的孤例保留窗口(章):窗口内等待第二次命中,过期即剪枝控制账本体积。 */
const SINGLETON_RETENTION_CHAPTERS = 3;
/** 账本条目硬上限:超过按(总次数升序、最近章升序)淘汰,防止 JSON 失控。 */
const MAX_LEDGER_ENTRIES = 30000;

// 结构性虚词:n-gram 以这些字开头/结尾、或实义字不足时不收——
// 否则『的时候』『了一下』这类中性碎片会淹没真正的口头禅(审计 risk note 点名)。
const STOP_CHARS = new Set(
  "的了着是在有和与就都也又再很还更被把对从向于会能要去来到上下中里外个这那他她它我你您们一不没此其之所如同被让向着过道说",
);
const EDGE_STOP_CHARS = new Set("的了着是在和与就都也又把被对从向于到中里个这那之所其");
/** 高频中性短语白名单:确定不是文风 tic,直接豁免。 */
const NEUTRAL_PHRASES = new Set([
  "的时候", "了一下", "一下子", "怎么回事", "什么时候", "没什么", "的样子",
  "的地方", "这时候", "那时候", "有点儿", "差不多", "不知道", "为什么",
]);

function countNonStopChars(gram: string): number {
  let n = 0;
  for (const ch of gram) {
    if (!STOP_CHARS.has(ch)) n++;
  }
  return n;
}

function isCandidatePhrase(gram: string, entityNames: ReadonlyArray<string>): boolean {
  if (NEUTRAL_PHRASES.has(gram)) return false;
  const first = gram[0]!;
  const last = gram[gram.length - 1]!;
  if (EDGE_STOP_CHARS.has(first) || EDGE_STOP_CHARS.has(last)) return false;
  if (countNonStopChars(gram) < 2) return false;
  for (const name of entityNames) {
    if (gram.includes(name)) return false;
  }
  return true;
}

/**
 * 提取一章正文的 3-6 字 n-gram 候选计数。
 * 以非汉字(标点/引号/换行/数字)为子句边界,n-gram 不跨子句;实体名过滤在此处完成。
 */
export function extractPhraseCounts(
  content: string,
  entityNames: Iterable<string> = [],
): Map<string, number> {
  const counts = new Map<string, number>();
  const entities = [...entityNames].filter((name) => name.length >= 2);
  const clauses = content.split(/[^一-鿿]+/);
  for (const clause of clauses) {
    if (clause.length < MIN_N) continue;
    for (let n = MIN_N; n <= MAX_N; n++) {
      for (let i = 0; i + n <= clause.length; i++) {
        const gram = clause.slice(i, i + n);
        if (!isCandidatePhrase(gram, entities)) continue;
        counts.set(gram, (counts.get(gram) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function ledgerPath(bookDir: string): string {
  return join(bookDir, LEDGER_RELATIVE_PATH);
}

async function loadLedgerFile(bookDir: string): Promise<PhraseLedgerFile> {
  const empty: PhraseLedgerFile = { version: 1, updatedAt: "", phrases: {} };
  try {
    const parsed = JSON.parse(await readFile(ledgerPath(bookDir), "utf-8"));
    if (parsed && typeof parsed === "object" && parsed.phrases && typeof parsed.phrases === "object") {
      return { version: 1, updatedAt: String(parsed.updatedAt ?? ""), phrases: parsed.phrases };
    }
  } catch {
    /* 缺失/损坏 → 空账本,绝不阻断写作主链 */
  }
  return empty;
}

/** 实体字典:与 story-graph 同源(story/character_matrix.md 的角色名 + 关系对象名)。 */
async function loadEntityDictionary(bookDir: string): Promise<string[]> {
  const md = await readFile(join(bookDir, "story", "character_matrix.md"), "utf-8").catch(() => "");
  if (!md.trim()) return [];
  const names = new Set<string>();
  for (const entry of parseCharacterMatrix(md)) {
    const main = entry.name.replace(/[（(].*$/, "").trim();
    if (main.length >= 2) names.add(main);
    for (const rel of entry.relations) {
      const target = rel.target.replace(/[（(].*$/, "").trim();
      if (target.length >= 2) names.add(target);
    }
  }
  return [...names];
}

/**
 * 落盘时记账:用本章正文整章替换该章在账本里的旧计数(幂等),再剪枝过期孤例 + 体积上限。
 * 任何 IO/解析异常由调用方吞掉(best-effort,绝不阻断落盘)。
 */
export async function updatePhraseLedger(params: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly content: string;
}): Promise<void> {
  const ledger = await loadLedgerFile(params.bookDir);
  const entityNames = await loadEntityDictionary(params.bookDir);
  const counts = extractPhraseCounts(params.content, entityNames);
  const chapterKey = String(params.chapterNumber);

  const phrases: Record<string, Record<string, number>> = {};
  // 1) 既有条目:剔除本章旧计数;剪枝「窗口外仍只命中 1 次」的孤例
  for (const [phrase, byChapter] of Object.entries(ledger.phrases)) {
    const next: Record<string, number> = {};
    let total = 0;
    let maxChapter = 0;
    for (const [ch, count] of Object.entries(byChapter)) {
      if (ch === chapterKey) continue;
      const c = Math.max(0, Math.floor(Number(count)) || 0);
      if (c <= 0) continue;
      next[ch] = c;
      total += c;
      maxChapter = Math.max(maxChapter, Number(ch) || 0);
    }
    if (total === 0) continue;
    if (total < 2 && maxChapter <= params.chapterNumber - SINGLETON_RETENTION_CHAPTERS) continue;
    phrases[phrase] = next;
  }
  // 2) 合入本章计数
  for (const [phrase, count] of counts) {
    const entry = phrases[phrase] ?? {};
    entry[chapterKey] = count;
    phrases[phrase] = entry;
  }
  // 3) 体积上限:超出按(总次数升序 → 最近章升序)淘汰最不可能成 tic 的条目
  const keys = Object.keys(phrases);
  if (keys.length > MAX_LEDGER_ENTRIES) {
    const ranked = keys
      .map((phrase) => {
        let total = 0;
        let maxChapter = 0;
        for (const [ch, c] of Object.entries(phrases[phrase]!)) {
          total += c;
          maxChapter = Math.max(maxChapter, Number(ch) || 0);
        }
        return { phrase, total, maxChapter };
      })
      .sort((a, b) => a.total - b.total || a.maxChapter - b.maxChapter);
    for (let i = 0; i < keys.length - MAX_LEDGER_ENTRIES; i++) {
      delete phrases[ranked[i]!.phrase];
    }
  }

  const next: PhraseLedgerFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    phrases,
  };
  const file = ledgerPath(params.bookDir);
  await mkdir(dirname(file), { recursive: true });
  await atomicWriteFile(file, JSON.stringify(next));
}

interface RankedPhrase {
  readonly phrase: string;
  readonly count: number;
  readonly chapters: number;
}

/** 同一 tic 的滑窗 n-gram(『手指悬在屏幕』vs『悬在屏幕上方』)共享 ≥4 字核心,只报一条。 */
function sharesPhraseCore(a: string, b: string): boolean {
  const k = 4;
  if (a.length < k || b.length < k) return a.includes(b) || b.includes(a);
  for (let i = 0; i + k <= b.length; i++) {
    if (a.includes(b.slice(i, i + k))) return true;
  }
  return false;
}

/** 排序 + 滑窗去重:优先高频、其次长串,同核心短语只保留最先入选的一条。 */
function rankAndDedup(
  rows: ReadonlyArray<RankedPhrase>,
  threshold: number,
  limit: number,
): OverusedPhrase[] {
  const sorted = rows
    .filter((row) => row.count >= threshold)
    .sort((a, b) => b.count - a.count || b.phrase.length - a.phrase.length);
  const selected: OverusedPhrase[] = [];
  for (const row of sorted) {
    if (selected.length >= limit) break;
    if (selected.some((s) => sharesPhraseCore(s.phrase, row.phrase))) continue;
    selected.push(row);
  }
  return selected;
}

/** 读取账本并产出「已用滥表达」清单(账本缺失/损坏 → 空清单)。 */
export async function loadOverusedPhrases(
  bookDir: string,
  opts?: { readonly threshold?: number; readonly limit?: number },
): Promise<OverusedPhrase[]> {
  const ledger = await loadLedgerFile(bookDir);
  const rows: RankedPhrase[] = Object.entries(ledger.phrases).map(([phrase, byChapter]) => {
    let count = 0;
    let chapters = 0;
    for (const c of Object.values(byChapter)) {
      count += c;
      chapters++;
    }
    return { phrase, count, chapters };
  });
  return rankAndDedup(rows, opts?.threshold ?? OVERUSE_THRESHOLD, opts?.limit ?? REPORT_LIMIT);
}

/**
 * 内存版累计(engine runBook 路径用,不落账本文件):对已完成各章成稿做同一套统计。
 * 没有实体字典时启用「疑似实体」守卫:单章平均出现 ≥4 次的串多为人名/称谓,不当 tic 报。
 */
export function collectOverusedPhrases(
  texts: ReadonlyArray<string>,
  opts?: {
    readonly threshold?: number;
    readonly limit?: number;
    readonly minN?: number;
    readonly entityNames?: Iterable<string>;
  },
): OverusedPhrase[] {
  const minN = Math.max(MIN_N, opts?.minN ?? MIN_N);
  const entityNames = [...(opts?.entityNames ?? [])];
  const hasEntityDict = entityNames.length > 0;
  const totals = new Map<string, { count: number; chapters: number }>();
  for (const text of texts) {
    if (!text || !text.trim()) continue;
    for (const [phrase, count] of extractPhraseCounts(text, entityNames)) {
      if (phrase.length < minN) continue;
      const entry = totals.get(phrase) ?? { count: 0, chapters: 0 };
      entry.count += count;
      entry.chapters += 1;
      totals.set(phrase, entry);
    }
  }
  const rows: RankedPhrase[] = [];
  for (const [phrase, entry] of totals) {
    // 疑似实体守卫:tic 的典型形态是「章章都来一两次」;单章均次过高的串大概率是名字/称谓
    if (!hasEntityDict && entry.chapters > 0 && entry.count / entry.chapters >= 4) continue;
    rows.push({ phrase, count: entry.count, chapters: entry.chapters });
  }
  return rankAndDedup(rows, opts?.threshold ?? OVERUSE_THRESHOLD, opts?.limit ?? REPORT_LIMIT);
}

/** 渲染「已用滥表达」清单(注入写手上下文用)。 */
export function renderOverusedPhraseNotice(
  phrases: ReadonlyArray<OverusedPhrase>,
  language: "zh" | "en" = "zh",
): string {
  if (phrases.length === 0) return "";
  if (language === "en") {
    const lines = phrases.map((p) => `- "${p.phrase}" (used ${p.count} times across ${p.chapters} chapters)`);
    return ["[Overused expressions — banned this chapter, rewrite with scene-specific wording]", ...lines].join("\n");
  }
  const lines = phrases.map((p) => `- 「${p.phrase}」(全书已出现 ${p.count} 次,跨 ${p.chapters} 章)`);
  return ["【本书已用滥的表达】以下短语全书已反复出现,本章一律禁用,换成此人此景特有的写法:", ...lines].join("\n");
}

/**
 * 新稿对「已用滥表达」的命中 → 确定性 issues(reviser 定点换写;经 audit_drift 注入下一章写手)。
 * warning 级:不单独卡死门禁,但每条都带原句与累计次数,复修可直接执行。
 */
export function buildPhraseLedgerIssues(
  content: string,
  overused: ReadonlyArray<OverusedPhrase>,
  language: "zh" | "en" = "zh",
): AuditIssue[] {
  if (!content || overused.length === 0) return [];
  const issues: AuditIssue[] = [];
  for (const item of overused) {
    if (issues.length >= REPORT_LIMIT) break;
    let hits = 0;
    let idx = content.indexOf(item.phrase);
    while (idx >= 0) {
      hits++;
      idx = content.indexOf(item.phrase, idx + item.phrase.length);
    }
    if (hits === 0) continue;
    issues.push(
      language === "en"
        ? {
            severity: "warning",
            category: "phrase-ledger",
            description: `Book-level overused expression "${item.phrase}" (already used ${item.count} times) appears ${hits} more time(s) in this chapter.`,
            suggestion: `Replace every "${item.phrase}" with wording specific to this character and scene; the phrase is on the book-wide ban list.`,
          }
        : {
            severity: "warning",
            category: "复读账本",
            description: `全书已用滥的表达「${item.phrase}」(累计 ${item.count} 次)在本章又出现 ${hits} 次。`,
            suggestion: `把本章的「${item.phrase}」逐处换成此人此景特有的动作/感官写法;该表达已进入全书禁用清单,后续章节不得再用。`,
          },
    );
  }
  return issues;
}
