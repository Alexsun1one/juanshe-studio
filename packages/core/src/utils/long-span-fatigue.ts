import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { analyzeChapterCadence } from "./chapter-cadence.js";
import {
  CADENCE_WINDOW_DEFAULTS,
  LONG_SPAN_FATIGUE_THRESHOLDS,
  resolveCadenceSummaryLookback,
} from "./cadence-policy.js";

export interface LongSpanFatigueIssue {
  readonly severity: "warning";
  readonly category: string;
  readonly description: string;
  readonly suggestion: string;
}

export interface AnalyzeLongSpanFatigueInput {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly chapterContent: string;
  readonly chapterSummary?: string;
  readonly language?: "zh" | "en";
}

export interface VarianceBrief {
  readonly highFrequencyPhrases: ReadonlyArray<string>;
  readonly repeatedOpeningPatterns: ReadonlyArray<string>;
  readonly repeatedEndingShapes: ReadonlyArray<string>;
  readonly sceneObligation: string;
  readonly text: string;
}

export type EnglishVarianceBrief = VarianceBrief;

interface SummaryRow {
  readonly chapter: number;
  readonly title: string;
  readonly mood: string;
  readonly chapterType: string;
}

const CHINESE_PUNCTUATION = /[，。！？；：“”‘’（）《》、\s\-—…·]/g;
const ENGLISH_PUNCTUATION = /[^a-z0-9]+/gi;
const BOUNDARY_WINDOW_CHARS = 260;

interface ChinesePatternDefinition {
  readonly label: string;
  readonly pattern: RegExp;
}

const CHINESE_OPENING_PATTERNS: ReadonlyArray<ChinesePatternDefinition> = [
  { label: "凌晨/天亮醒来开场", pattern: /(?:凌晨|天(?:刚|还|色|没)|蒙蒙亮|黑暗|没亮).{0,24}(?:醒|睁眼|睁了眼|睁开眼|起身|没动)/ },
  { label: "静听/不动观察开场", pattern: /(?:听了几秒|竖着耳朵|没有动|没动|屏住|屋里没有|院里没有|无人声|无狗吠|静得)/ },
  { label: "独自出门探查开场", pattern: /(?:出院|出门|推门|绕到|摸到|走向|去了).{0,30}(?:渠|渡口|芦苇|河滩|废船|墙根|院外|暗渠|码头)/ },
  { label: "证物检查开场", pattern: /(?:碎片|脚印|石灰|泥点|绳|木桩|暗渠|账本|纸页|名单|水痕).{0,24}(?:看|摸|捏|对照|收起|压住)/ },
];

const CHINESE_ENDING_PATTERNS: ReadonlyArray<ChinesePatternDefinition> = [
  { label: "证物/线索落板", pattern: /(?:碎片|脚印|石灰|泥点|绳|木桩|暗渠|账本|纸页|名单|钥匙|灯光|痕迹|印|裂缝|证据|线索)/ },
  { label: "风雨夜色压迫收尾", pattern: /(?:风|雨|夜色|黑暗|雾|天色|屋檐|巷子).{0,26}(?:压|沉|暗|吹|响|静|更深|更冷)/ },
  { label: "悬而不说收尾", pattern: /(?:没有说|没有回头|没有动|没有开口|谁也不知道|只剩|仍然|还在|再也|偏偏)/ },
  { label: "外部异动钩子收尾", pattern: /(?:门外|墙后|院外|更深|另一|脚步|灯|响|动了一下|亮了一下|有人)/ },
];

const CHINESE_HIGH_FREQUENCY_PHRASES: ReadonlyArray<string> = [
  "天还没亮",
  "天刚蒙蒙亮",
  "凌晨",
  "睁开眼",
  "醒来",
  "没动",
  "听了一阵",
  "出院门",
  "暗渠",
  "芦苇",
  "碎片",
  "脚印",
  "石灰",
  "风从",
  "夜色",
];

const CHINESE_SOLO_SCOUT_PATTERN = /(?:独自|一个人|没叫醒|没惊动|悄悄|摸黑|沿着|绕到|出院|出门|推门).{0,70}(?:探|查|看|听|摸|找|捡|盯|对照|渠|渡口|芦苇|河滩|废船|墙根|院外|暗渠|码头)/;
const CHINESE_EVIDENCE_PATTERN = /(?:碎片|脚印|石灰|泥点|绳|木桩|暗渠|账本|纸页|名单|钥匙|灯光|痕迹|印|裂缝|证据|线索)/;

export async function buildEnglishVarianceBrief(params: {
  readonly bookDir: string;
  readonly chapterNumber: number;
}): Promise<EnglishVarianceBrief | null> {
  return buildVarianceBrief({
    ...params,
    language: "en",
  });
}

export async function buildVarianceBrief(params: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly language?: "zh" | "en";
}): Promise<VarianceBrief | null> {
  const language = params.language ?? "zh";
  const chapterBodies = await loadPreviousChapterBodies(
    params.bookDir,
    params.chapterNumber,
    CADENCE_WINDOW_DEFAULTS.englishVarianceLookback,
  );
  if (chapterBodies.length < 2) {
    return null;
  }

  if (language === "zh") {
    return buildChineseVarianceBrief({
      bookDir: params.bookDir,
      chapterNumber: params.chapterNumber,
      chapterBodies,
    });
  }

  return buildEnglishVarianceBriefFromBodies({
    bookDir: params.bookDir,
    chapterNumber: params.chapterNumber,
    chapterBodies,
  });
}

async function buildEnglishVarianceBriefFromBodies(params: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly chapterBodies: ReadonlyArray<string>;
}): Promise<VarianceBrief> {
  const summaryRows = await loadSummaryRows(join(params.bookDir, "story", "chapter_summaries.md"));
  const cadenceLookback = resolveCadenceSummaryLookback({ currentChapter: params.chapterNumber });
  const recentRows = summaryRows
    .filter((row) => row.chapter < params.chapterNumber)
    .sort((left, right) => left.chapter - right.chapter)
    .slice(-cadenceLookback);

  const highFrequencyPhrases = collectRepeatedEnglishPhrases(params.chapterBodies);
  const repeatedOpeningPatterns = collectRepeatedBoundaryPatterns(params.chapterBodies, "opening");
  const repeatedEndingShapes = collectRepeatedBoundaryPatterns(params.chapterBodies, "ending");
  const cadence = analyzeChapterCadence({
    rows: recentRows,
    language: "en",
    currentChapter: params.chapterNumber,
  });
  const sceneObligation = chooseSceneObligation(cadence, repeatedOpeningPatterns, repeatedEndingShapes);

  const lines = [
    "## English Variance Brief",
    "",
    `- High-frequency phrases to avoid: ${formatEnglishList(highFrequencyPhrases)}`,
    `- Repeated opening patterns to avoid: ${formatEnglishList(repeatedOpeningPatterns)}`,
    `- Repeated ending patterns to avoid: ${formatEnglishList(repeatedEndingShapes)}`,
    `- Scene obligation: ${sceneObligation}`,
  ];

  return {
    highFrequencyPhrases,
    repeatedOpeningPatterns,
    repeatedEndingShapes,
    sceneObligation,
    text: lines.join("\n"),
  };
}

async function buildChineseVarianceBrief(params: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly chapterBodies: ReadonlyArray<string>;
}): Promise<VarianceBrief> {
  const summaryRows = await loadSummaryRows(join(params.bookDir, "story", "chapter_summaries.md"));
  const cadenceLookback = resolveCadenceSummaryLookback({ currentChapter: params.chapterNumber });
  const recentRows = summaryRows
    .filter((row) => row.chapter < params.chapterNumber)
    .sort((left, right) => left.chapter - right.chapter)
    .slice(-cadenceLookback);

  const highFrequencyPhrases = collectRepeatedChinesePhrases(params.chapterBodies);
  const repeatedOpeningPatterns = collectRepeatedChineseBoundaryPatterns(params.chapterBodies, "opening");
  const repeatedEndingShapes = collectRepeatedChineseBoundaryPatterns(params.chapterBodies, "ending");
  const cadence = analyzeChapterCadence({
    rows: recentRows,
    language: "zh",
    currentChapter: params.chapterNumber,
  });
  const sceneObligation = chooseChineseSceneObligation(cadence, repeatedOpeningPatterns, repeatedEndingShapes);

  const lines = [
    "## 中文变体简报",
    "",
    `- 高频短语/动作避免：${formatChineseList(highFrequencyPhrases)}`,
    `- 重复开头模式避免：${formatChineseList(repeatedOpeningPatterns)}`,
    `- 重复结尾落点避免：${formatChineseList(repeatedEndingShapes)}`,
    `- 本章结构义务：${sceneObligation}`,
    "- 硬禁令：近章若已用“凌晨/醒来/独自探查/发现线索/新证据收尾”，本章不得再走“醒来 → 出门探查 → 发现物件 → 章尾新线索”的模板，除非本章用户指令逐字强制。",
  ];

  return {
    highFrequencyPhrases,
    repeatedOpeningPatterns,
    repeatedEndingShapes,
    sceneObligation,
    text: lines.join("\n"),
  };
}

export async function analyzeLongSpanFatigue(
  input: AnalyzeLongSpanFatigueInput,
): Promise<{ readonly issues: ReadonlyArray<LongSpanFatigueIssue> }> {
  const language = input.language ?? "zh";
  const issues: LongSpanFatigueIssue[] = [];

  const summaryRows = await loadSummaryRows(join(input.bookDir, "story", "chapter_summaries.md"));
  const mergedRows = mergeCurrentSummary(summaryRows, input.chapterSummary);
  const cadenceLookback = resolveCadenceSummaryLookback({ currentChapter: input.chapterNumber });
  const recentRows = mergedRows
    .filter((row) => row.chapter <= input.chapterNumber)
    .sort((left, right) => left.chapter - right.chapter)
    .slice(-cadenceLookback);
  const cadence = analyzeChapterCadence({
    rows: recentRows,
    language,
    currentChapter: input.chapterNumber,
  });

  const chapterTypeIssue = buildChapterTypeIssue(cadence, language);
  if (chapterTypeIssue) {
    issues.push(chapterTypeIssue);
  }

  const moodIssue = buildMoodIssue(cadence, language);
  if (moodIssue) {
    issues.push(moodIssue);
  }

  const titleIssue = buildTitleIssue(cadence, language);
  if (titleIssue) {
    issues.push(titleIssue);
  }

  const recentChapterBodies = await loadRecentChapterBodies(
    input.bookDir,
    input.chapterNumber,
    input.chapterContent,
  );

  const openingIssue = buildSentencePatternIssue(recentChapterBodies, "opening", language);
  if (openingIssue) {
    issues.push(openingIssue);
  }

  const openingSceneIssue = buildChineseBoundarySceneIssue(recentChapterBodies, "opening", language);
  if (openingSceneIssue) {
    issues.push(openingSceneIssue);
  }

  const structuralFlowIssue = buildChineseStructuralFlowIssue(recentChapterBodies, language);
  if (structuralFlowIssue) {
    issues.push(structuralFlowIssue);
  }

  const endingIssue = buildSentencePatternIssue(recentChapterBodies, "ending", language);
  if (endingIssue) {
    issues.push(endingIssue);
  }

  const endingSceneIssue = buildChineseBoundarySceneIssue(recentChapterBodies, "ending", language);
  if (endingSceneIssue) {
    issues.push(endingSceneIssue);
  }

  return { issues };
}

async function loadSummaryRows(path: string): Promise<SummaryRow[]> {
  try {
    const raw = await readFile(path, "utf-8");
    return raw
      .split("\n")
      .map((line) => parseSummaryRow(line))
      .filter((row): row is SummaryRow => row !== null);
  } catch {
    return [];
  }
}

async function loadPreviousChapterBodies(
  bookDir: string,
  currentChapter: number,
  limit: number,
): Promise<string[]> {
  const chaptersDir = join(bookDir, "chapters");
  try {
    const files = await readdir(chaptersDir);
    const previousFiles = files
      .map((file) => ({ file, chapter: Number.parseInt(file.slice(0, 4), 10) }))
      .filter((entry) => Number.isFinite(entry.chapter) && entry.chapter < currentChapter && entry.file.endsWith(".md"))
      .sort((left, right) => left.chapter - right.chapter)
      .slice(-limit);

    return Promise.all(
      previousFiles.map((entry) => readFile(join(chaptersDir, entry.file), "utf-8")),
    );
  } catch {
    return [];
  }
}

function mergeCurrentSummary(rows: ReadonlyArray<SummaryRow>, currentSummary?: string): SummaryRow[] {
  const parsedCurrent = currentSummary ? parseSummaryRow(currentSummary) : null;
  if (!parsedCurrent) return [...rows];

  const nextRows = rows.filter((row) => row.chapter !== parsedCurrent.chapter);
  nextRows.push(parsedCurrent);
  return nextRows;
}

function parseSummaryRow(line: string): SummaryRow | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || trimmed.includes("章节 |") || trimmed.includes("Chapter |") || trimmed.includes("---")) {
    return null;
  }

  const cells = trimmed
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
  if (cells.length < 8) {
    return null;
  }

  const chapter = Number.parseInt(cells[0] ?? "", 10);
  if (!Number.isFinite(chapter) || chapter <= 0) {
    return null;
  }

  return {
    chapter,
    title: cells[1] ?? "",
    mood: cells[6] ?? "",
    chapterType: cells[7] ?? "",
  };
}

function buildChapterTypeIssue(
  cadence: ReturnType<typeof analyzeChapterCadence>,
  language: "zh" | "en",
): LongSpanFatigueIssue | null {
  if (cadence.scenePressure?.pressure !== "high") {
    return null;
  }
  const { repeatedType, streak } = cadence.scenePressure;

  if (language === "en") {
    return {
      severity: "warning",
      category: "Pacing Monotony",
      description: `The last ${streak} chapter types have stayed on ${repeatedType}, which suggests macro pacing monotony.`,
      suggestion: "Switch the next chapter's function instead of extending the same beat again. Rotate setup, payoff, reversal, and fallout more deliberately.",
    };
  }

  return {
    severity: "warning",
    category: "节奏单调",
    description: `最近${streak}章章节类型持续停留在“${repeatedType}”，长篇节奏可能开始固化。`,
    suggestion: "下一章应切换章节功能，不要连续重复同一种布局/推进节拍。",
  };
}

function buildMoodIssue(
  cadence: ReturnType<typeof analyzeChapterCadence>,
  language: "zh" | "en",
): LongSpanFatigueIssue | null {
  if (cadence.moodPressure?.pressure !== "high") {
    return null;
  }
  const { highTensionStreak, recentMoods } = cadence.moodPressure;

  if (language === "en") {
    return {
      severity: "warning",
      category: "Mood Monotony",
      description: `High-tension mood has locked in for ${highTensionStreak} chapters (${recentMoods.join(" -> ")}), with no visible emotional release.`,
      suggestion: "Insert a release beat, warmth, humor, intimacy, or reflective quiet before escalating again.",
    };
  }

  return {
    severity: "warning",
    category: "情绪单调",
    description: `最近${highTensionStreak}章持续高压（${recentMoods.join(" -> ")}），缺少明显的情绪释放。`,
    suggestion: "下一章安排一次喘息、温情、幽默或静场释放，再继续加压。",
  };
}

function buildTitleIssue(
  cadence: ReturnType<typeof analyzeChapterCadence>,
  language: "zh" | "en",
): LongSpanFatigueIssue | null {
  if (cadence.titlePressure?.pressure !== "high") {
    return null;
  }
  const { repeatedToken, count } = cadence.titlePressure;

  if (language === "en") {
    return {
      severity: "warning",
      category: "Title Collapse",
      description: `Recent titles keep collapsing around "${repeatedToken}" (${count} hits in the current window), which makes chapter naming feel formulaic.`,
      suggestion: "Change the next title anchor. Use a new image, action, consequence, or character vector instead of the same keyword shell.",
    };
  }

  return {
    severity: "warning",
    category: "标题重复",
    description: `最近标题持续围绕“${repeatedToken}”命名（当前窗口命中${count}次），命名开始坍缩。`,
    suggestion: "下一章标题换一个新的意象、动作、后果或人物焦点，不要继续套同一个关键词壳。",
  };
}

async function loadRecentChapterBodies(
  bookDir: string,
  currentChapter: number,
  currentContent: string,
): Promise<string[]> {
  const chaptersDir = join(bookDir, "chapters");
  try {
    const files = await readdir(chaptersDir);
    const previousFiles = files
      .map((file) => ({ file, chapter: Number.parseInt(file.slice(0, 4), 10) }))
      .filter((entry) => Number.isFinite(entry.chapter) && entry.chapter < currentChapter && entry.file.endsWith(".md"))
      .sort((left, right) => left.chapter - right.chapter)
      .slice(-CADENCE_WINDOW_DEFAULTS.recentBoundaryPatternBodies);

    if (previousFiles.length < CADENCE_WINDOW_DEFAULTS.recentBoundaryPatternBodies) {
      return [];
    }

    const previousBodies = await Promise.all(
      previousFiles.map((entry) => readFile(join(chaptersDir, entry.file), "utf-8")),
    );

    return [...previousBodies, currentContent];
  } catch {
    return [];
  }
}

function buildSentencePatternIssue(
  chapterBodies: ReadonlyArray<string>,
  boundary: "opening" | "ending",
  language: "zh" | "en",
): LongSpanFatigueIssue | null {
  if (chapterBodies.length < LONG_SPAN_FATIGUE_THRESHOLDS.boundaryPatternMinBodies) return null;

  const sentences = chapterBodies.map((body) => extractBoundarySentence(body, boundary));
  if (sentences.some((sentence) => sentence === null)) {
    return null;
  }

  const normalized = sentences
    .map((sentence) => normalizeSentence(sentence!, language));
  if (normalized.some((sentence) => sentence.length < LONG_SPAN_FATIGUE_THRESHOLDS.boundarySentenceMinLength)) {
    return null;
  }

  const similarities = [
    diceCoefficient(normalized[0]!, normalized[1]!),
    diceCoefficient(normalized[1]!, normalized[2]!),
  ];
  if (Math.min(...similarities) < LONG_SPAN_FATIGUE_THRESHOLDS.boundarySimilarityFloor) {
    return null;
  }

  const sample = summarizeSentence(sentences[2]!, language);
  const pairText = similarities.map((value) => value.toFixed(2)).join("/");

  if (language === "en") {
    const category = boundary === "opening" ? "Opening Pattern Repetition" : "Ending Pattern Repetition";
    const position = boundary === "opening" ? "openings" : "endings";
    return {
      severity: "warning",
      category,
      description: `The last 3 chapter ${position} are highly similar (adjacent similarity ${pairText}), which risks a formulaic rhythm. Current ${boundary} signature: "${sample}".`,
      suggestion: boundary === "opening"
        ? "Change the next chapter opening vector. Start from action, consequence, or surprise instead of repeating the same camera move."
        : "Change the next chapter landing pattern. End on consequence, decision, or a new variable instead of repeating the same explanatory cadence.",
    };
  }

  return {
    severity: "warning",
    category: boundary === "opening" ? "开头同构" : "结尾同构",
    description: `最近3章${boundary === "opening" ? "开头" : "结尾"}句式高度相似（相邻相似度${pairText}），容易形成模板化${boundary === "opening" ? "开篇" : "章尾"}。当前句式近似“${sample}”。`,
    suggestion: boundary === "opening"
      ? "下一章换一个开篇入口，用动作、后果或异常信息切入，不要连续沿用同一种抬镜句。"
      : "下一章换一个收束方式，用行动后果、角色决断或新变量落板，不要连续用解释性句子收尾。",
  };
}

function buildChineseBoundarySceneIssue(
  chapterBodies: ReadonlyArray<string>,
  boundary: "opening" | "ending",
  language: "zh" | "en",
): LongSpanFatigueIssue | null {
  if (language !== "zh") return null;
  if (chapterBodies.length < LONG_SPAN_FATIGUE_THRESHOLDS.boundaryPatternMinBodies) return null;

  const repeatedPatterns = collectRepeatedChineseBoundaryPatterns(chapterBodies, boundary)
    .filter((pattern) => countChineseBoundaryPatternHits(chapterBodies, boundary, pattern) >= 3);
  if (repeatedPatterns.length === 0) {
    return null;
  }

  if (boundary === "opening") {
    return {
      severity: "warning",
      category: "开头场景同构",
      description: `最近3章开头反复落在“${repeatedPatterns.join("、")}”，即使换了字面句式，也会让读者感觉每章从同一个镜头启动。`,
      suggestion: "下一章禁止再用凌晨/醒来/静听/独自探查开篇；改从他人主动动作、当面对话、公开场面、后果现场或被动打断切入。",
    };
  }

  return {
    severity: "warning",
    category: "结尾场景同构",
    description: `最近3章结尾反复落在“${repeatedPatterns.join("、")}”，章尾钩子的功能和镜头开始模板化。`,
    suggestion: "下一章结尾不要只落在新证物/异动/夜色压迫上；改用人物选择、关系变化、外部代价或公开后果收束。",
  };
}

function buildChineseStructuralFlowIssue(
  chapterBodies: ReadonlyArray<string>,
  language: "zh" | "en",
): LongSpanFatigueIssue | null {
  if (language !== "zh") return null;
  if (chapterBodies.length < LONG_SPAN_FATIGUE_THRESHOLDS.boundaryPatternMinBodies) return null;

  const templatedBodies = chapterBodies.filter((body) => {
    const openingWindow = extractBoundaryWindow(body, "opening");
    const endingWindow = extractBoundaryWindow(body, "ending");
    return detectChinesePatterns(openingWindow, CHINESE_OPENING_PATTERNS).some((label) => label.includes("醒来") || label.includes("探查"))
      && CHINESE_SOLO_SCOUT_PATTERN.test(stripMarkdownHeadings(body))
      && (detectChinesePatterns(endingWindow, CHINESE_ENDING_PATTERNS).length > 0 || CHINESE_EVIDENCE_PATTERN.test(endingWindow));
  });

  if (templatedBodies.length < 2) {
    return null;
  }

  return {
    severity: "warning",
    category: "章节结构同构",
    description: `最近${chapterBodies.length}章里至少${templatedBodies.length}章接近“醒来/静听 → 独自探查 → 发现证物/新异动收尾”的同一骨架，读感会明显像批量生成。`,
    suggestion: "下一章必须换中段承载：至少安排一场有阻力的对话、交易、误会、公开冲突或关系代价，不得全章只让主角独自观察和捡线索。",
  };
}

function collectRepeatedEnglishPhrases(chapterBodies: ReadonlyArray<string>): string[] {
  const counts = new Map<string, number>();

  for (const body of chapterBodies) {
    const tokens = body
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/gi, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3)
      .filter((token) => !ENGLISH_STOP_WORDS.has(token));
    const seen = new Set<string>();

    for (let index = 0; index <= tokens.length - 3; index += 1) {
      const phrase = `${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`;
      seen.add(phrase);
    }

    for (const phrase of seen) {
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([phrase]) => phrase);
}

function collectRepeatedChinesePhrases(chapterBodies: ReadonlyArray<string>): string[] {
  const counts = new Map<string, number>();

  for (const body of chapterBodies) {
    const seen = new Set<string>();
    for (const phrase of CHINESE_HIGH_FREQUENCY_PHRASES) {
      if (body.includes(phrase)) {
        seen.add(phrase);
      }
    }
    for (const phrase of seen) {
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"))
    .slice(0, 6)
    .map(([phrase]) => phrase);
}

function collectRepeatedBoundaryPatterns(
  chapterBodies: ReadonlyArray<string>,
  boundary: "opening" | "ending",
): string[] {
  const counts = new Map<string, number>();

  for (const body of chapterBodies) {
    const sentence = extractBoundarySentence(body, boundary);
    if (!sentence) continue;

    const tokens = sentence
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/gi, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4);
    if (tokens.length < 2) continue;

    const pattern = tokens.join(" ");
    counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([pattern]) => pattern);
}

function collectRepeatedChineseBoundaryPatterns(
  chapterBodies: ReadonlyArray<string>,
  boundary: "opening" | "ending",
): string[] {
  const counts = new Map<string, number>();
  const patterns = boundary === "opening" ? CHINESE_OPENING_PATTERNS : CHINESE_ENDING_PATTERNS;

  for (const body of chapterBodies) {
    const window = extractBoundaryWindow(body, boundary);
    const labels = detectChinesePatterns(window, patterns);
    for (const label of new Set(labels)) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"))
    .slice(0, 4)
    .map(([pattern]) => pattern);
}

function countChineseBoundaryPatternHits(
  chapterBodies: ReadonlyArray<string>,
  boundary: "opening" | "ending",
  label: string,
): number {
  const patterns = boundary === "opening" ? CHINESE_OPENING_PATTERNS : CHINESE_ENDING_PATTERNS;
  const definition = patterns.find((pattern) => pattern.label === label);
  if (!definition) return 0;
  return chapterBodies.filter((body) => definition.pattern.test(extractBoundaryWindow(body, boundary))).length;
}

function detectChinesePatterns(
  text: string,
  patterns: ReadonlyArray<ChinesePatternDefinition>,
): string[] {
  return patterns
    .filter((definition) => definition.pattern.test(text))
    .map((definition) => definition.label);
}

function chooseSceneObligation(
  cadence: ReturnType<typeof analyzeChapterCadence>,
  repeatedOpenings: ReadonlyArray<string>,
  repeatedEndings: ReadonlyArray<string>,
): string {
  if (cadence.scenePressure?.pressure === "high") {
    return "confrontation under pressure";
  }
  if (repeatedEndings.length > 0) {
    return "discovery under pressure";
  }
  if (repeatedOpenings.length > 0) {
    return "negotiation with withholding";
  }
  return "concealment with active pushback";
}

function chooseChineseSceneObligation(
  cadence: ReturnType<typeof analyzeChapterCadence>,
  repeatedOpenings: ReadonlyArray<string>,
  repeatedEndings: ReadonlyArray<string>,
): string {
  if (repeatedOpenings.some((pattern) => pattern.includes("醒来") || pattern.includes("静听") || pattern.includes("探查"))) {
    return "必须换开篇入口，从他人主动动作、当面对话、公开场面、后果现场或被动打断切入；开场300字内出现外部阻力。";
  }
  if (cadence.scenePressure?.pressure === "high") {
    return "必须换章节功能，用冲突、代价、关系变化或兑现来承载，不要继续同一类调查/铺垫节拍。";
  }
  if (repeatedEndings.length > 0) {
    return "结尾必须落在人物选择、关系变化或公开后果上，不再只用新证物/异动/夜色压迫收束。";
  }
  return "至少安排一场带阻力的对话、交易、误会或公开冲突，让中段不只是独自观察。";
}

function extractBoundarySentence(content: string, boundary: "opening" | "ending"): string | null {
  const flattened = stripMarkdownHeadings(content);

  const sentences = flattened
    .split(/(?<=[。！？!?\.])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

  if (sentences.length === 0) {
    return null;
  }

  return boundary === "opening" ? sentences[0]! : sentences[sentences.length - 1]!;
}

function extractBoundaryWindow(content: string, boundary: "opening" | "ending"): string {
  const flattened = stripMarkdownHeadings(content);
  return boundary === "opening"
    ? flattened.slice(0, BOUNDARY_WINDOW_CHARS)
    : flattened.slice(-BOUNDARY_WINDOW_CHARS);
}

function stripMarkdownHeadings(content: string): string {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join(" ");
}

function normalizeSentence(sentence: string, language: "zh" | "en"): string {
  if (language === "en") {
    return sentence
      .toLowerCase()
      .replace(ENGLISH_PUNCTUATION, "")
      .trim();
  }

  return sentence
    .replace(CHINESE_PUNCTUATION, "")
    .toLowerCase();
}

function summarizeSentence(sentence: string, language: "zh" | "en"): string {
  if (language === "en") {
    const words = sentence
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/gi, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6)
      .join(" ");
    return words.length > 0 ? words : sentence.slice(0, 32);
  }

  const collapsed = sentence.replace(CHINESE_PUNCTUATION, "");
  return collapsed.slice(0, 12);
}

function formatEnglishList(values: ReadonlyArray<string>): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function formatChineseList(values: ReadonlyArray<string>): string {
  return values.length > 0 ? values.join("、") : "无";
}

function diceCoefficient(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;

  const leftBigrams = buildBigrams(left);
  const rightBigrams = buildBigrams(right);
  let overlap = 0;

  for (const [bigram, count] of leftBigrams) {
    overlap += Math.min(count, rightBigrams.get(bigram) ?? 0);
  }

  const leftCount = [...leftBigrams.values()].reduce((sum, value) => sum + value, 0);
  const rightCount = [...rightBigrams.values()].reduce((sum, value) => sum + value, 0);
  return (2 * overlap) / (leftCount + rightCount);
}

function buildBigrams(value: string): Map<string, number> {
  const result = new Map<string, number>();
  for (let index = 0; index < value.length - 1; index++) {
    const bigram = value.slice(index, index + 2);
    result.set(bigram, (result.get(bigram) ?? 0) + 1);
  }
  return result;
}

const ENGLISH_STOP_WORDS = new Set([
  "the",
  "and",
  "but",
  "with",
  "from",
  "into",
  "that",
  "this",
  "there",
  "again",
  "while",
  "after",
  "before",
  "were",
  "was",
  "had",
  "has",
  "have",
  "kept",
]);
