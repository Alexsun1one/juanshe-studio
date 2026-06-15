import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoredHook } from "../state/memory-db.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { renderHookSnapshot, parsePendingHooksMarkdown } from "./story-markdown.js";
import { withStoryTruthWriteLock } from "./story-truth-writer.js";

const MIN_ACTIVE_PROMOTED_CORE_HOOKS = 2;
const RENEWAL_HOOK_COUNT = 3;

export async function maybeRenewCoreHooks(params: {
  readonly storyDir: string;
  readonly chapterNumber: number;
  readonly targetChapters: number;
  readonly volumeMap: string;
  readonly activeHooks: ReadonlyArray<StoredHook>;
  readonly currentFocus: string;
  readonly storyFrame: string;
  readonly authorIntent: string;
  readonly language?: "zh" | "en";
}): Promise<number> {
  if (!shouldRenewCoreHooks(params)) return 0;

  const ledgerPath = join(params.storyDir, "pending_hooks.md");
  return withStoryTruthWriteLock(params.storyDir, async () => {
    const raw = await readFile(ledgerPath, "utf-8").catch(() => "");
    const hooks = parsePendingHooksMarkdown(raw);
    if (!hasAnyCoreHook(hooks)) {
      return 0;
    }
    if (hasEnoughActivePromotedCoreHooks(hooks) || hasRecentAutoRenewal(hooks, params.chapterNumber)) {
      return 0;
    }

    const nextHooks = buildRenewalHooks({
      existingHooks: hooks,
      chapterNumber: params.chapterNumber,
      currentFocus: params.currentFocus,
      storyFrame: params.storyFrame,
      authorIntent: params.authorIntent,
      language: params.language ?? "zh",
    });
    if (nextHooks.length === 0) return 0;

    const language = params.language ?? (/[一-龟]/u.test(raw) ? "zh" : "en");
    await atomicWriteFile(ledgerPath, renderHookSnapshot([...hooks, ...nextHooks], language));
    return nextHooks.length;
  });
}

function shouldRenewCoreHooks(params: {
  readonly chapterNumber: number;
  readonly targetChapters: number;
  readonly volumeMap: string;
  readonly activeHooks: ReadonlyArray<StoredHook>;
}): boolean {
  if (params.chapterNumber < 8) return false;
  if (hasEnoughActivePromotedCoreHooks(params.activeHooks)) return false;
  return hasAtLeastTwoUnwrittenVolumes(params.volumeMap, params.chapterNumber, params.targetChapters);
}

function hasEnoughActivePromotedCoreHooks(hooks: ReadonlyArray<StoredHook>): boolean {
  return hooks.filter((hook) =>
    hook.coreHook === true &&
    hook.promoted === true &&
    !isTerminalStatus(hook.status)
  ).length >= MIN_ACTIVE_PROMOTED_CORE_HOOKS;
}

function hasAnyCoreHook(hooks: ReadonlyArray<StoredHook>): boolean {
  return hooks.some((hook) => hook.coreHook === true);
}

function hasRecentAutoRenewal(hooks: ReadonlyArray<StoredHook>, chapterNumber: number): boolean {
  return hooks.some((hook) =>
    /auto-renewal/i.test(hook.notes) &&
    Math.max(hook.startChapter, hook.lastAdvancedChapter) >= chapterNumber - 3
  );
}

function buildRenewalHooks(params: {
  readonly existingHooks: ReadonlyArray<StoredHook>;
  readonly chapterNumber: number;
  readonly currentFocus: string;
  readonly storyFrame: string;
  readonly authorIntent: string;
  readonly language: "zh" | "en";
}): StoredHook[] {
  const anchor = pickAnchor([params.currentFocus, params.storyFrame, params.authorIntent], params.language);
  const nextIds = allocateHookIds(params.existingHooks, RENEWAL_HOOK_COUNT);
  const templates = params.language === "en"
    ? [
        "A new long-range pressure source grows from the current focus and forces the protagonist to pay a visible cost before the next volume turn.",
        "A hidden opponent or institution reacts to the protagonist's recent movement, proving the mainline has a deeper layer than the local case.",
        "A relationship, oath, or debt becomes load-bearing: later victories must either honor it or break it in public.",
      ]
    : [
        "从当前主线压力里长出新的长期代价：主角继续推进前，必须先付出一个能被读者看见的代价。",
        "隐藏对手或制度层反应被主角触发，证明本书主线不只是眼前事件，还有更深一层的压迫源。",
        "一段关系、誓约或旧债变成承重线：后续胜利必须公开兑现它，或公开背叛它。",
      ];

  return nextIds.map((hookId, index) => ({
    hookId,
    startChapter: params.chapterNumber,
    type: "core_hook",
    status: "open",
    lastAdvancedChapter: params.chapterNumber,
    expectedPayoff: `${templates[index] ?? templates[0]} ${anchor}`,
    payoffTiming: index === 0 ? "mid-arc" : "slow-burn",
    notes: `auto-renewal: generated because active promoted core_hook count fell below ${MIN_ACTIVE_PROMOTED_CORE_HOOKS}`,
    dependsOn: [],
    paysOffInArc: params.language === "en" ? "next two volumes" : "后续两卷",
    coreHook: true,
    halfLifeChapters: index === 0 ? 18 : 30,
    promoted: true,
  }));
}

function allocateHookIds(hooks: ReadonlyArray<StoredHook>, count: number): string[] {
  const used = new Set(hooks.map((hook) => hook.hookId));
  const max = hooks.reduce((highest, hook) => {
    const n = hook.hookId.match(/^H0*(\d+)$/i)?.[1];
    return n ? Math.max(highest, Number(n)) : highest;
  }, 0);
  const ids: string[] = [];
  let cursor = Math.max(1, max + 1);
  while (ids.length < count) {
    const id = `H${String(cursor).padStart(3, "0")}`;
    if (!used.has(id)) ids.push(id);
    cursor += 1;
  }
  return ids;
}

function pickAnchor(sources: ReadonlyArray<string>, language: "zh" | "en"): string {
  const fallback = language === "en"
    ? "Anchor: current protagonist conflict."
    : "锚点：当前主角冲突。";
  for (const source of sources) {
    const line = source
      .split("\n")
      .map((item) => item.trim().replace(/^[-*#>\s]+/, ""))
      .find((item) => item.length >= 8 && !/^```/.test(item));
    if (line) return language === "en" ? `Anchor: ${line.slice(0, 180)}` : `锚点：${line.slice(0, 90)}`;
  }
  return fallback;
}

function hasAtLeastTwoUnwrittenVolumes(volumeMap: string, chapterNumber: number, targetChapters: number): boolean {
  const ranges = parseVolumeRanges(volumeMap);
  if (ranges.length >= 2) {
    return ranges.filter((range) => range.startCh > chapterNumber).length >= 2;
  }
  const remaining = Math.max(0, targetChapters - chapterNumber);
  const inferredVolumeSpan = Math.max(20, Math.ceil(Math.max(targetChapters, 1) / inferVolumeCount(targetChapters)));
  return remaining >= inferredVolumeSpan * 2;
}

function parseVolumeRanges(volumeMap: string): Array<{ readonly startCh: number; readonly endCh: number }> {
  const ranges: Array<{ startCh: number; endCh: number }> = [];
  for (const rawLine of volumeMap.split("\n")) {
    const line = rawLine.trim();
    const match = line.match(/(?:第\s*[一二三四五六七八九十百千万零〇\d]+\s*卷|Volume\s+\d+|范围|range)?[^0-9\n]*(?:第|Ch\.?|Chapter)?\s*(\d+)\s*[-~–—]\s*(\d+)\s*章?/i);
    if (!match) continue;
    const startCh = Number(match[1]);
    const endCh = Number(match[2]);
    if (!Number.isFinite(startCh) || !Number.isFinite(endCh)) continue;
    ranges.push({ startCh: Math.min(startCh, endCh), endCh: Math.max(startCh, endCh) });
  }
  return ranges.sort((left, right) => left.startCh - right.startCh);
}

function inferVolumeCount(targetChapters: number): number {
  if (targetChapters >= 160) return 6;
  if (targetChapters >= 100) return 4;
  if (targetChapters >= 60) return 3;
  return 2;
}

function isTerminalStatus(status: string): boolean {
  return /^(resolved|closed|done|已回收|已解决|deferred|paused|hold|延后|延期|搁置|暂缓)$/i.test(status.trim());
}
