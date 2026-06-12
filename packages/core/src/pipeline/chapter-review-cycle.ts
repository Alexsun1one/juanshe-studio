import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { ReviseMode, ReviseOutput } from "../agents/reviser.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { ChapterIntent, ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";
import { countChapterLength, isOutsideHardRange } from "../utils/length-metrics.js";
import { buildPhraseLedgerIssues, loadOverusedPhrases } from "./phrase-ledger.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ChapterReviewCycleUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterReviewCycleControlInput {
  readonly chapterIntent: string;
  readonly chapterMemo?: ChapterMemo;
  readonly chapterIntentData?: ChapterIntent;
  readonly contextPackage: ContextPackage;
  readonly ruleStack: RuleStack;
}

export interface ChapterReviewCycleResult {
  readonly finalContent: string;
  readonly finalWordCount: number;
  readonly preAuditNormalizedWordCount: number;
  readonly revised: boolean;
  readonly auditResult: AuditResult;
  readonly totalUsage: ChapterReviewCycleUsage;
  readonly postReviseCount: number;
  readonly normalizeApplied: boolean;
}

const MAX_REVIEW_ITERATIONS = 3;
const PASS_SCORE_THRESHOLD = 85;
const NET_IMPROVEMENT_EPSILON = 3;

// ---------------------------------------------------------------------------
// 设计修复：让 auto-repair 在"主设定保真(叙事漂移)"被卡住时能自我重锚，
// 而不是每次都靠人工把剧情拉回。检测到 premise-fidelity critical 时：
//  1) 把复修模式从 auto 升级到 rework（结构重写，不改大事件结果）；
//  2) 直接从 story/author_intent.md(+story_frame) 读本书真实核心承诺，
//     合成一条高优先级、可执行的"结构重锚"issue 注入 reviser，
//     使其针对"这本书"重锚，而不是泛化地"显化某个设定信号"。
// 这样漂移会被系统在复修闭环内收敛，无需人工每次拉回。
// ---------------------------------------------------------------------------
const PREMISE_DIMENSION_RE = /主设定保真|premise\s*fidelity/i;

export function hasPremiseFidelityBlocker(
  issues: ReadonlyArray<AuditIssue>,
): boolean {
  return issues.some(
    (issue) =>
      issue.severity === "critical" &&
      (PREMISE_DIMENSION_RE.test(issue.category ?? "") ||
        PREMISE_DIMENSION_RE.test(issue.description ?? "")),
  );
}

function condensePremiseSource(raw: string, maxChars = 900): string {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !/^#{1,6}\s*$/.test(l) &&
        !/^[-=]{3,}$/.test(l) &&
        !/^<!--/.test(l),
    );
  // 优先保留含核心承诺关键词的行，再按顺序补齐
  const KEY =
    /承诺|核心|主角|身份|能力|限制|谜团|长线|世界规则|代价|爽点|反差|intent|promise|premise|protagonist|core|mystery/i;
  const prioritized = [
    ...lines.filter((l) => KEY.test(l)),
    ...lines.filter((l) => !KEY.test(l)),
  ];
  let out = "";
  for (const l of prioritized) {
    if (out.length + l.length + 1 > maxChars) break;
    out += (out ? "\n" : "") + l;
  }
  return out;
}

export async function loadPremiseAnchor(bookDir: string): Promise<string> {
  const parts: string[] = [];
  for (const rel of [
    "story/author_intent.md",
    "story/outline/story_frame.md",
  ]) {
    try {
      const txt = await readFile(join(bookDir, rel), "utf-8");
      if (txt && txt.trim()) {
        parts.push(condensePremiseSource(txt, rel.includes("author") ? 900 : 500));
      }
    } catch {
      // 真相文件缺失/不可读时静默降级：不阻断复修闭环
    }
  }
  return parts.join("\n---\n").slice(0, 1400);
}

export function buildPremiseReanchorIssue(
  anchor: string,
  isEnglish: boolean,
): AuditIssue {
  return {
    severity: "critical",
    category: isEnglish ? "Premise Fidelity Check" : "主设定保真",
    description: isEnglish
      ? "The chapter has drifted away from the book's defining premise (structural narrative drift, not a wording problem). A local issue patch will NOT fix this — it must be structurally re-anchored."
      : "本章已偏离全书核心设定（结构性叙事漂移，不是措辞问题）。局部补丁无法解决，必须做结构性重锚。",
    suggestion: isEnglish
      ? `Without changing major event outcomes, restructure this chapter's scene progression and causal chain so that at least one of THIS BOOK'S concrete core promises is clearly visible on the page:\n${anchor}\nDo not abstractly "add a setting signal" — re-anchor to the specific premise above. If a local incident is disconnected from these promises, rearrange the scene so the core promise is naturally present.`
      : `在不改变重大事件结果的前提下，重构本章的场景推进与因果链，使下列"本书"具体核心承诺中至少一条在页面上明确可见：\n${anchor}\n不要泛化地"补一个设定信号"——必须针对上面这本书的具体设定重锚。若某个局部事件与这些承诺脱节，调整场景安排让核心承诺自然在场。`,
  };
}

// ---------------------------------------------------------------------------
// 缺陷5 修复：沉浸塌方（talking-heads / 碎句 / 感官稀薄）是 style/immersion
// 数值门槛触底却 criticals:0 的头号成因——auditor 不判 critical、复修按
// 泛化局部修永远抬不动，89 平台靠人工。这里自包含地从正文算"可测签名"
// （高对话占比 + 高碎句比 + 感官稀薄，三者同时成立才触发，阈值取自
// ch48 通过 / ch49 卡死的实测分离值，保守避免误伤好章），命中则与
// premise 重锚同机制：升 rework + 注入结构性"沉浸补强"指令。
// ---------------------------------------------------------------------------
const SENSORY_LEXICON =
  /[声響响嗅闻嗅味腥香臭馊气息凉冷热烫暖潮湿濕干燥痛疼酸麻痒刺粗糙光滑黏滑触摸抚指尖掌心耳畔鼻尖舌尖喉咙皮肤汗血腥光影明暗刺眼昏暗朦胧轰嗡咔嗒哗噼啪滴答呼吸喘]/g;

export function detectImmersionCollapse(content: string): boolean {
  const text = (content ?? "").trim();
  if (text.length < 600) return false; // 太短不判，避免噪声
  const paras = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const total = paras.length;
  if (total < 12) return false; // 不是成形章节不判
  const isDialogue = (p: string) =>
    /^["“「『'']/.test(p) || /[""」』]\s*$/.test(p);
  const dialogueRatio =
    paras.filter(isDialogue).length / total;
  const shortRatio =
    paras.filter((p) => p.replace(/\s/g, "").length < 40).length / total;
  const chars = text.replace(/\s/g, "").length;
  const sensoryHits = (text.match(SENSORY_LEXICON) || []).length;
  const sensoryPerK = sensoryHits / Math.max(1, chars / 1000);
  // 三条件同时成立 = 典型话头悬浮塌方（ch49: 对话密集 + 碎句 0.47 + 感官稀薄）
  return dialogueRatio >= 0.5 && shortRatio >= 0.4 && sensoryPerK < 6;
}

export function buildImmersionReanchorIssue(isEnglish: boolean): AuditIssue {
  return {
    severity: "critical",
    category: isEnglish ? "Immersion Grounding" : "沉浸接地",
    description: isEnglish
      ? "The chapter has collapsed into talking-heads: dialogue-dominated, fragmented short paragraphs, thin sensory grounding and almost no emotional movement. This is structural — a local wording patch will NOT lift immersion/style."
      : "本章已塌成话头悬浮：对话连珠、碎句、感官稀薄、几乎没有情绪推进。这是结构性问题——局部措辞补丁抬不动 immersion / style。",
    suggestion: isEnglish
      ? "Without changing plot, dialogue content, or major event outcomes, restructure for grounding: every 3-4 exchanges land one concrete sensory anchor (sound/smell/touch/temperature) or an immediate physical/emotional reaction; consolidate fragmented one-line paragraphs into grounded narrative beats; add real emotional turns so the scene moves inwardly, not just informationally. Keep what happens; change how present it feels."
      : "在不改剧情、不改对话内容、不改重大事件结果的前提下，做结构性接地：每 3-4 句对话之内必须落一个具体感官锚点（听/嗅/触/温度）或人物即时身体/情绪反应；把碎成一句一段的连排短段并回有落地的叙事节拍；补真实的情绪推进，让场景有内在位移而不只是信息交换。发生的事不变，改的是「在场感」。",
  };
}

interface ReviewSnapshot {
  readonly content: string;
  readonly wordCount: number;
  readonly auditResult: AuditResult;
  readonly score: number;
}

export async function runChapterReviewCycle(params: {
  readonly book: Pick<{ genre: string }, "genre">;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly initialOutput: Pick<WriteChapterOutput, "content" | "wordCount" | "postWriteErrors">;
  readonly reducedControlInput?: ChapterReviewCycleControlInput;
  readonly lengthSpec: LengthSpec;
  /** 评分/修复循环的最大轮次；缺省时回退到 MAX_REVIEW_ITERATIONS（3）。 */
  readonly reviewRetries?: number;
  /** 单章时间预算截止时刻(epoch ms)。超过后修复循环在下一轮开始前优雅停止,取最佳稿。 */
  readonly deadlineAt?: number;
  readonly initialUsage: ChapterReviewCycleUsage;
  readonly createReviser: () => {
    reviseChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      issues: ReadonlyArray<AuditIssue>,
      mode?: ReviseMode,
      genre?: string,
      options?: {
        chapterIntent?: string;
        chapterMemo?: ChapterMemo;
        chapterIntentData?: ChapterIntent;
        contextPackage?: ContextPackage;
        ruleStack?: RuleStack;
        lengthSpec?: LengthSpec;
      },
    ) => Promise<ReviseOutput>;
  };
  readonly auditor: {
    auditChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      genre?: string,
      options?: {
        temperature?: number;
        chapterIntent?: string;
        chapterMemo?: ChapterMemo;
        contextPackage?: ContextPackage;
        ruleStack?: RuleStack;
      },
    ) => Promise<AuditResult>;
  };
  readonly normalizeDraftLengthIfNeeded: (chapterContent: string) => Promise<{
    content: string;
    wordCount: number;
    applied: boolean;
    tokenUsage?: ChapterReviewCycleUsage;
  }>;
  /** 表面规整(破折号→逗号、模型备注行剥除)。必填:续写/恢复等任何走本闭环的路径都不得跳过。 */
  readonly normalizePostWriteSurface: (chapterContent: string) => string;
  readonly assertChapterContentNotEmpty: (content: string, stage: string) => void;
  readonly addUsage: (
    left: ChapterReviewCycleUsage,
    right?: ChapterReviewCycleUsage,
  ) => ChapterReviewCycleUsage;
  readonly analyzeAITells: (content: string) => { issues: ReadonlyArray<AuditIssue> };
  readonly analyzeSensitiveWords: (content: string) => {
    found: ReadonlyArray<{ severity: string }>;
    issues: ReadonlyArray<AuditIssue>;
  };
  /** Re-run deterministic post-write checks (chapter-ref, paragraph shape, etc.) on any content. */
  readonly runPostWriteChecks?: (content: string) => ReadonlyArray<AuditIssue>;
  readonly logWarn: (message: { zh: string; en: string }) => void;
  readonly logStage: (message: { zh: string; en: string }) => void;
}): Promise<ChapterReviewCycleResult> {
  let totalUsage = params.initialUsage;
  let normalizeApplied = false;
  let finalContent = params.initialOutput.content;
  let finalWordCount = params.initialOutput.wordCount;

  // Convert initial postWriteErrors into AuditIssues as fallback when runPostWriteChecks isn't provided.
  const initialPostWriteIssues: ReadonlyArray<AuditIssue> = params.initialOutput.postWriteErrors.map((violation) => ({
    severity: "critical" as const,
    category: violation.rule,
    description: violation.description,
    suggestion: violation.suggestion,
  }));

  // ---------------------------------------------------------------------------
  // Length normalization: dedicated step, only runs for clear hard-range drift.
  // Length is NOT mixed into the reviser's issues — normalize handles it.
  // 提速：不再为软区间反复归一，仅在硬区间漂移时做一次（与 reviewRetries 一起降低单章 LLM 轮次）。
  // ---------------------------------------------------------------------------
  const normalizeIfHardDrift = async (content: string): Promise<{
    content: string;
    wordCount: number;
    applied: boolean;
  }> => {
    const wordCount = countChapterLength(content, params.lengthSpec.countingMode);
    if (!isOutsideHardRange(wordCount, params.lengthSpec)) {
      return { content, wordCount, applied: false };
    }
    const result = await params.normalizeDraftLengthIfNeeded(content);
    totalUsage = params.addUsage(totalUsage, result.tokenUsage);
    const newWordCount = countChapterLength(result.content, params.lengthSpec.countingMode);
    return { content: result.content, wordCount: newWordCount, applied: result.applied };
  };

  const normalizedBeforeAudit = await normalizeIfHardDrift(finalContent);
  finalContent = params.normalizePostWriteSurface(normalizedBeforeAudit.content);
  finalWordCount = countChapterLength(finalContent, params.lengthSpec.countingMode);
  normalizeApplied = normalizeApplied || normalizedBeforeAudit.applied;
  params.assertChapterContentNotEmpty(finalContent, "draft generation");

  // 复读账本:全书「已用滥表达」清单(由 chapter-persistence 落盘时记账,本章开审前读一次)。
  // 新稿命中即出确定性 warning → reviser 拿原句定点换写,并经 audit_drift 注入下一章写手。
  const overusedPhrases = await loadOverusedPhrases(params.bookDir).catch(
    () => [] as Awaited<ReturnType<typeof loadOverusedPhrases>>,
  );
  const ledgerLanguage: "zh" | "en" = /[一-鿿]/.test(finalContent.slice(0, 2000)) ? "zh" : "en";

  // ---------------------------------------------------------------------------
  // Helper: assess a chapter (audit + deterministic checks + length + score)
  // ---------------------------------------------------------------------------
  const assess = async (
    content: string,
    options?: { temperature?: number },
  ): Promise<{ auditResult: AuditResult; score: number; lengthInRange: boolean }> => {
    const llmAudit = await params.auditor.auditChapter(
      params.bookDir,
      content,
      params.chapterNumber,
      params.book.genre,
      params.reducedControlInput
        ? { ...params.reducedControlInput, ...(options ?? {}) }
        : options,
    );
    totalUsage = params.addUsage(totalUsage, llmAudit.tokenUsage);
    const aiTellsResult = params.analyzeAITells(content);
    const sensitiveResult = params.analyzeSensitiveWords(content);
    const hasBlockedWords = sensitiveResult.found.some((item) => item.severity === "block");
    const wordCount = countChapterLength(content, params.lengthSpec.countingMode);
    const lengthInRange = !isOutsideHardRange(wordCount, params.lengthSpec);

    // Deterministic post-write checks: run every round, not just the first.
    // If runPostWriteChecks is provided, use it; otherwise fall back to initial postWriteErrors.
    const postWriteIssues = params.runPostWriteChecks
      ? params.runPostWriteChecks(content)
      : initialPostWriteIssues;
    const phraseLedgerIssues = buildPhraseLedgerIssues(content, overusedPhrases, ledgerLanguage);

    const allIssues: AuditIssue[] = [
      ...llmAudit.issues,
      ...aiTellsResult.issues,
      ...sensitiveResult.issues,
      ...postWriteIssues,
      ...phraseLedgerIssues,
    ];

    // Length is NOT added to reviser issues — normalize handles it as a dedicated step.
    // lengthInRange is only used in isPassed() as a hard gate.

    const hasPostWriteCritical = postWriteIssues.some((i) => i.severity === "critical");
    const hasNumericScore = typeof llmAudit.overallScore === "number" && Number.isFinite(llmAudit.overallScore);
    const score = hasNumericScore ? llmAudit.overallScore! : (llmAudit.passed ? PASS_SCORE_THRESHOLD : 0);
    const gateIssues: AuditIssue[] = [];
    if (hasNumericScore && score < PASS_SCORE_THRESHOLD) {
      gateIssues.push({
        severity: "critical",
        category: "quality-gate",
        description: `章节综合评分 ${score} 低于通过线 ${PASS_SCORE_THRESHOLD}`,
        suggestion: "必须先修复本章质量门禁，再允许章节进入待审或后续续写。",
      });
    }
    if (!lengthInRange) {
      gateIssues.push({
        severity: "critical",
        category: "length-gate",
        description: `章节字数 ${wordCount} 不在目标软范围内`,
        suggestion: "必须先完成篇幅归一化或改写，避免短章/水章被误标为通过。",
      });
    }

    const gatePassed = !hasBlockedWords
      && !hasPostWriteCritical
      && llmAudit.passed
      && (!hasNumericScore || score >= PASS_SCORE_THRESHOLD)
      && lengthInRange;
    const auditResult: AuditResult = {
      passed: gatePassed,
      issues: [...allIssues, ...gateIssues],
      summary: llmAudit.summary,
      overallScore: llmAudit.overallScore,
    };

    return { auditResult, score, lengthInRange };
  };

  const isPassed = (assessment: { auditResult: AuditResult; score: number; lengthInRange: boolean }): boolean =>
    assessment.auditResult.passed && assessment.score >= PASS_SCORE_THRESHOLD && assessment.lengthInRange;

  // ---------------------------------------------------------------------------
  // Scoring loop: assess → revise → assess, max 3 iterations, pick best
  // ---------------------------------------------------------------------------
  params.logStage({ zh: "审计草稿", en: "auditing draft" });
  const initial = await assess(finalContent);

  const snapshots: ReviewSnapshot[] = [{
    content: finalContent,
    wordCount: finalWordCount,
    auditResult: initial.auditResult,
    score: initial.score,
  }];

  let currentAudit = initial;
  let postReviseCount = 0;

  if (!isPassed(initial)) {
    // 设计修复：若初评已含主设定保真阻塞，预读本书核心承诺一次（守卫式、可降级）
    const isEnglish = !/[一-鿿]/.test(finalContent.slice(0, 2000));
    let premiseAnchor = "";
    if (hasPremiseFidelityBlocker(initial.auditResult.issues)) {
      premiseAnchor = await loadPremiseAnchor(params.bookDir);
    }

    const maxReviewIterations = params.reviewRetries ?? MAX_REVIEW_ITERATIONS;
    for (let iteration = 0; iteration < maxReviewIterations; iteration++) {
      // 单章时间预算:超时则在下一轮开始前优雅停止(取最佳稿),不无限耗在修复上。
      if (params.deadlineAt && Date.now() > params.deadlineAt) {
        params.logWarn({
          zh: `已达单章时间预算,提前结束修复循环(已修 ${iteration} 轮,当前 ${currentAudit.score} 分,取最佳稿)`,
          en: `chapter time budget reached; stopping repair loop early after ${iteration} round(s) (current score: ${currentAudit.score})`,
        });
        break;
      }
      params.logStage({
        zh: `修复轮次 ${iteration + 1}/${maxReviewIterations}（当前 ${currentAudit.score} 分）`,
        en: `repair iteration ${iteration + 1}/${maxReviewIterations} (current score: ${currentAudit.score})`,
      });

      // 主设定漂移 或 沉浸塌方 被卡 → 升级为结构重写并注入对应重锚指令，
      // 让两类"局部修永远抬不动"的结构性问题在复修闭环内自我收敛，
      // 不再每次靠人工拉回。
      const premiseBlocked = hasPremiseFidelityBlocker(
        currentAudit.auditResult.issues,
      );
      if (premiseBlocked && !premiseAnchor) {
        premiseAnchor = await loadPremiseAnchor(params.bookDir);
      }
      const usePremiseReanchor = premiseBlocked && premiseAnchor.length > 0;
      const immersionCollapsed = detectImmersionCollapse(finalContent);
      const escalateStructural = usePremiseReanchor || immersionCollapsed;
      const reviseMode: ReviseMode = escalateStructural ? "rework" : "auto";
      const extraIssues: AuditIssue[] = [];
      if (usePremiseReanchor) {
        extraIssues.push(buildPremiseReanchorIssue(premiseAnchor, isEnglish));
      }
      if (immersionCollapsed) {
        extraIssues.push(buildImmersionReanchorIssue(isEnglish));
      }
      const issuesForReviser = extraIssues.length
        ? [...extraIssues, ...currentAudit.auditResult.issues]
        : currentAudit.auditResult.issues;
      if (escalateStructural) {
        const tags = [
          usePremiseReanchor ? "主设定漂移" : "",
          immersionCollapsed ? "沉浸塌方" : "",
        ]
          .filter(Boolean)
          .join("+");
        params.logStage({
          zh: `检测到${tags} → 结构重锚（第 ${iteration + 1} 轮）`,
          en: `structural defect (${usePremiseReanchor ? "premise-drift " : ""}${immersionCollapsed ? "immersion-collapse" : ""}) → re-anchor (iteration ${iteration + 1})`,
        });
      }

      const reviser = params.createReviser();
      const reviseOutput = await reviser.reviseChapter(
        params.bookDir,
        finalContent,
        params.chapterNumber,
        issuesForReviser,
        reviseMode,
        params.book.genre,
        { ...params.reducedControlInput, lengthSpec: params.lengthSpec },
      );
      totalUsage = params.addUsage(totalUsage, reviseOutput.tokenUsage);

      if (reviseOutput.revisedContent.length === 0 || reviseOutput.revisedContent === finalContent) {
        params.logWarn({
          zh: `修复轮次 ${iteration + 1} 未产出新内容，退出循环`,
          en: `repair iteration ${iteration + 1} produced no new content, exiting loop`,
        });
        break;
      }

      params.assertChapterContentNotEmpty(reviseOutput.revisedContent, `repair iteration ${iteration + 1}`);
      const revisedContent = params.normalizePostWriteSurface(reviseOutput.revisedContent);
      const revisedWordCount = countChapterLength(revisedContent, params.lengthSpec.countingMode);

      // Re-assess revised content. If REVISED_CONTENT drifted on length,
      // lengthInRange will be false → isPassed fails → bestSnapshot picks
      // the earlier in-range version. No in-loop normalize needed.
      const nextAssessment = await assess(revisedContent, { temperature: 0 });

      snapshots.push({
        content: revisedContent,
        wordCount: revisedWordCount,
        auditResult: nextAssessment.auditResult,
        score: nextAssessment.score,
      });

      // Check if passed
      if (isPassed(nextAssessment)) {
        params.logStage({
          zh: `修复后达到通过线（${nextAssessment.score} 分），退出循环`,
          en: `repair reached pass threshold (${nextAssessment.score}), exiting loop`,
        });
        finalContent = revisedContent;
        finalWordCount = revisedWordCount;
        postReviseCount = revisedWordCount;
        currentAudit = nextAssessment;
        break;
      }

      // Check net improvement
      if (nextAssessment.score >= currentAudit.score + NET_IMPROVEMENT_EPSILON) {
        finalContent = revisedContent;
        finalWordCount = revisedWordCount;
        postReviseCount = revisedWordCount;
        currentAudit = nextAssessment;
        // Continue to next iteration
      } else {
        params.logWarn({
          zh: `修复轮次 ${iteration + 1} 未净提升（${currentAudit.score} → ${nextAssessment.score}），退出循环`,
          en: `repair iteration ${iteration + 1} no net improvement (${currentAudit.score} → ${nextAssessment.score}), exiting loop`,
        });
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pick the best scoring snapshot for final output
  // ---------------------------------------------------------------------------
  const bestSnapshot = snapshots.reduce((best, snap) =>
    snap.score >= best.score + NET_IMPROVEMENT_EPSILON ? snap : best,
  );

  // If best snapshot differs from current content (repair made things worse
  // but an earlier version was better), roll back to the best version.
  if (bestSnapshot.content !== finalContent && bestSnapshot.score >= currentAudit.score + NET_IMPROVEMENT_EPSILON) {
    params.logWarn({
      zh: `回退到最高分版本（${bestSnapshot.score} 分 vs 当前 ${currentAudit.score} 分）`,
      en: `rolling back to highest-scoring version (${bestSnapshot.score} vs current ${currentAudit.score})`,
    });
    finalContent = bestSnapshot.content;
    finalWordCount = bestSnapshot.wordCount;
    currentAudit = {
      auditResult: bestSnapshot.auditResult,
      score: bestSnapshot.score,
      lengthInRange: !isOutsideHardRange(bestSnapshot.wordCount, params.lengthSpec),
    };
  }

  return {
    finalContent,
    finalWordCount,
    preAuditNormalizedWordCount: finalWordCount,
    revised: snapshots.length > 1 && finalContent !== params.initialOutput.content,
    auditResult: currentAudit.auditResult,
    totalUsage,
    postReviseCount,
    normalizeApplied,
  };
}
