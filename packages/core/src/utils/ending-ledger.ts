import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "./fs-atomic.js";
import {
  normalizeMarkdownTableRow,
  parseMarkdownChapterNumber,
  withStoryTruthWriteLock,
  type TruthWriteLogger,
} from "./story-truth-writer.js";
import { CADENCE_PRESSURE_THRESHOLDS } from "./cadence-policy.js";

export interface EndingSignature {
  readonly chapter: number;
  readonly endingShape: string;
  readonly signature: string;
  readonly register: string;
  readonly tempo: string;
  readonly protagonistActions: ReadonlyArray<string>;
  readonly sidePortraits: ReadonlyArray<string>;
  readonly excerpt: string;
}

export interface EndingLedgerEntry extends EndingSignature {}

export interface TextDiversityIssue {
  readonly severity: "warning";
  readonly category: string;
  readonly description: string;
  readonly suggestion: string;
}

const ZH_ENDING_SHAPE_PATTERNS: ReadonlyArray<{ readonly shape: string; readonly pattern: RegExp }> = [
  { shape: "对话收束", pattern: /[“「『][^”」』]{1,90}[”」』][。！？!?]?$/u },
  { shape: "反问独白", pattern: /[？?]\s*(?:$|[”」』])/u },
  { shape: "残句留白", pattern: /(?:没有|没再|不再|只剩|无人|无声|答案|沉默|停住|回头|关门|开口|动了动|信吗|不信)/u },
  { shape: "动作悬念", pattern: /(?:推开|拉开|按下|拨通|举起|拍在|递出|转身|抬手|伸手|握住|抓住|扣住|掀开|打开|关上|敲响|门把手|手机|刀|钥匙|证据|名单|纸条)/u },
  { shape: "明确落点", pattern: /(?:终于|已经|当场|从此|决定|确认|拿到|失去|交给|留下|完成|结束|变成|落定|定了)/u },
  { shape: "场景外推", pattern: /(?:门外|窗外|街上|远处|楼下|巷口|城市|天空|天色|人群|广播|灯牌|车流|雨幕|风里)/u },
  { shape: "象征意象", pattern: /(?:黑暗|灯光|影子|雨|雪|雾|风|裂缝|字|纸|钟|火|灰|水|镜子|玻璃|月光|夜色)/u },
];

const EN_ENDING_SHAPE_PATTERNS: ReadonlyArray<{ readonly shape: string; readonly pattern: RegExp }> = [
  { shape: "Dialogue close", pattern: /["'][^"']{1,120}["'][.!?]?$/u },
  { shape: "Question close", pattern: /\?\s*(?:$|["'])/u },
  { shape: "Fragment silence", pattern: /\b(no answer|said nothing|did not|didn't|never turned|never looked back|only silence|still there|no one)\b/i },
  { shape: "Action suspense", pattern: /\b(opened|closed|pressed|dialed|raised|reached|turned|grabbed|held|knocked|door|phone|knife|key|evidence|letter)\b/i },
  { shape: "Clear landing", pattern: /\b(finally|already|decided|confirmed|lost|gained|finished|ended|became|settled)\b/i },
  { shape: "Scene extrapolation", pattern: /\b(outside|street|window|city|sky|crowd|rain|wind|lights|traffic)\b/i },
  { shape: "Symbolic image", pattern: /\b(dark|darkness|light|shadow|rain|snow|fog|crack|word|paper|clock|fire|ash|water|glass|moon)\b/i },
];

const ZH_PROTAGONIST_ACTION_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "擦柜台", pattern: /擦(?:着)?(?:柜台|收银台)|把(?:柜台|收银台).{0,8}擦/u },
  { label: "反复擦", pattern: /(?:反复|一遍又一遍|又擦了|擦了又擦).{0,10}(?:擦|抹布|柜台|收银台)/u },
  { label: "拧笔帽", pattern: /拧(?:着)?笔帽|笔帽.{0,6}拧/u },
  { label: "攥纸条", pattern: /攥(?:着)?(?:纸条|信纸|便签)|(?:纸条|信纸|便签).{0,8}攥/u },
  { label: "叠抹布/方块", pattern: /叠(?:着)?抹布|抹布.{0,10}(?:叠|方块)/u },
  { label: "沉默观察", pattern: /(?:沉默|没说话|没有开口).{0,30}(?:看|盯|听|望|观察)/u },
  { label: "攥拳/握紧", pattern: /攥紧|握紧|拳头.{0,8}(?:紧|发白)|指节.{0,8}(?:发白|绷紧)/u },
  { label: "捏杯/茶杯", pattern: /捏(?:着|住)?(?:杯|茶杯|水杯)|(?:杯|茶杯|水杯).{0,8}(?:捏|裂|碎)/u },
  { label: "揉眉心", pattern: /揉(?:了)?揉眉心|按(?:住)?眉心/u },
  { label: "摸旧物", pattern: /摸(?:着|到)?(?:钥匙|旧照片|旧账本|旧信|吊坠|玉佩|戒指)/u },
];

const EN_PROTAGONIST_ACTION_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "wiping counter", pattern: /\bwip(?:e|ed|ing).{0,30}\b(counter|cash register)\b/i },
  { label: "repeated wiping", pattern: /\b(again and again|over and over|wiped again)\b/i },
  { label: "twisting pen cap", pattern: /\b(twist(?:ed|ing)?|turn(?:ed|ing)?)\b.{0,20}\bpen cap\b/i },
  { label: "clutching note", pattern: /\b(clutch(?:ed|ing)?|crumpl(?:ed|ing)?|gripp(?:ed|ing)?)\b.{0,20}\b(note|paper|letter)\b/i },
  { label: "silent watching", pattern: /\b(silent|said nothing|did not speak)\b.{0,40}\b(watched|stared|listened)\b/i },
  { label: "clenched fist", pattern: /\b(clenched fist|knuckles whitened|gripped until)\b/i },
];

const ZH_SIDE_PORTRAIT_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "工装/油污/攒钱", pattern: /(?:工装|工作服).{0,40}(?:洗得发白|油污|机油|指甲缝|攒钱|省钱)|(?:指甲缝.{0,8}(?:油污|黑)|攒(?:了|钱))/u },
  { label: "外卖/骑手/风尘", pattern: /(?:外卖|骑手|头盔|电动车|雨披|保温箱)/u },
  { label: "白领/通勤/体面", pattern: /(?:西装|衬衫|高跟鞋|电脑包|工牌|写字楼|通勤|香水|腕表)/u },
  { label: "学生/校服/书包", pattern: /(?:校服|书包|作业本|学生证|补习班|练习册)/u },
  { label: "老人/退休/旧病", pattern: /(?:老人|老头|老太|退休|老花镜|拐杖|药盒|血压)/u },
  { label: "带娃母亲/家庭压力", pattern: /(?:孩子|婴儿车|奶粉|尿不湿|抱着娃|幼儿园|家长群)/u },
  { label: "富裕阶层/司机/名表", pattern: /(?:司机|豪车|名表|腕表|真丝|皮鞋|私人会所|别墅|高定)/u },
  { label: "医护/病患/消毒水", pattern: /(?:医生|护士|病号服|输液|消毒水|医院|病历)/u },
];

const EN_SIDE_PORTRAIT_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "workwear/oil/savings", pattern: /\b(workwear|overalls|oil under|grease|saving money|worn thin)\b/i },
  { label: "delivery rider", pattern: /\b(delivery|rider|helmet|bike|thermal bag)\b/i },
  { label: "office commuter", pattern: /\b(suit|badge|laptop bag|office tower|commuter|wristwatch)\b/i },
  { label: "student", pattern: /\b(uniform|backpack|student id|homework)\b/i },
  { label: "elderly/illness", pattern: /\b(elderly|retired|cane|pillbox|blood pressure)\b/i },
  { label: "wealth/driver/watch", pattern: /\b(driver|limousine|luxury car|tailored|private club|villa)\b/i },
];

export function extractEndingSignature(params: {
  readonly chapterNumber: number;
  readonly title?: string;
  readonly content: string;
  readonly language: "zh" | "en";
}): EndingSignature {
  const stripped = stripMarkdownHeadings(params.content);
  const ending = extractEndingText(stripped);
  const endingShape = classifyEndingShape(ending, params.language);
  const register = classifyRegister(stripped, params.language);
  const tempo = classifyTempo(stripped, params.language);
  const protagonistActions = extractPatternLabels(stripped, params.language === "en" ? EN_PROTAGONIST_ACTION_PATTERNS : ZH_PROTAGONIST_ACTION_PATTERNS, 8);
  const sidePortraits = extractPatternLabels(stripped, params.language === "en" ? EN_SIDE_PORTRAIT_PATTERNS : ZH_SIDE_PORTRAIT_PATTERNS, 8);
  const excerpt = clipSingleLine(ending, params.language === "en" ? 200 : 100);
  const signature = params.language === "en"
    ? `${endingShape}: ${excerpt}`
    : `${endingShape}：${excerpt}`;

  return {
    chapter: params.chapterNumber,
    endingShape,
    signature,
    register,
    tempo,
    protagonistActions,
    sidePortraits,
    excerpt,
  };
}

export async function upsertEndingLedgerFile(params: {
  readonly storyDir: string;
  readonly signature: EndingSignature;
  readonly language: "zh" | "en";
  readonly logger?: TruthWriteLogger;
}): Promise<void> {
  await withStoryTruthWriteLock(params.storyDir, () => upsertEndingLedgerFileUnlocked(params));
}

export async function upsertEndingLedgerFileUnlocked(params: {
  readonly storyDir: string;
  readonly signature: EndingSignature;
  readonly language: "zh" | "en";
  readonly logger?: TruthWriteLogger;
}): Promise<void> {
  const ledgerPath = join(params.storyDir, "ending_ledger.md");
  await mkdir(params.storyDir, { recursive: true });
  const existing = await readFile(ledgerPath, "utf-8").catch(() => "");
  const next = renderUpsertedEndingLedger(existing, [renderEndingLedgerRow(params.signature)], params.language);
  await atomicWriteFile(ledgerPath, next);

  const verified = await readFile(ledgerPath, "utf-8").catch(() => "");
  if (parseEndingLedgerMarkdown(verified).some((entry) => entry.chapter === params.signature.chapter)) return;

  params.logger?.warn?.(
    params.language === "en"
      ? `[truth-write] ending_ledger.md self-heal: row for chapter ${params.signature.chapter} missing after atomic write; retrying upsert.`
      : `[truth-write] ending_ledger.md 自愈：第${params.signature.chapter}章行在原子写后缺失，重试 upsert。`,
  );
  const healed = renderUpsertedEndingLedger(verified, [renderEndingLedgerRow(params.signature)], params.language);
  await atomicWriteFile(ledgerPath, healed);
}

export async function buildTextDiversityBrief(params: {
  readonly storyDir: string;
  readonly currentChapter: number;
  readonly keepRecent: number;
  readonly language: "zh" | "en";
}): Promise<string | undefined> {
  const ledgerPath = join(params.storyDir, "ending_ledger.md");
  const content = await readFile(ledgerPath, "utf-8").catch(() => "");
  if (!content.trim()) return undefined;
  const entries = parseEndingLedgerMarkdown(content)
    .filter((entry) => entry.chapter < params.currentChapter)
    .sort((left, right) => right.chapter - left.chapter)
    .slice(0, params.keepRecent);
  return renderTextDiversityBrief(entries, params.language);
}

export function renderTextDiversityBrief(
  entries: ReadonlyArray<EndingLedgerEntry>,
  language: "zh" | "en",
): string | undefined {
  if (entries.length === 0) return undefined;

  const target = chooseTextDiversityTarget(entries, language);
  const recentEndingShapes = unique(entries.map((entry) => entry.endingShape)).slice(0, 12);
  const recentRegisters = unique(entries.map((entry) => entry.register)).slice(0, 12);
  const recentTempos = unique(entries.map((entry) => entry.tempo)).slice(0, 8);
  const recentActions = unique(entries.flatMap((entry) => entry.protagonistActions)).slice(0, 30);
  const recentPortraits = unique(entries.flatMap((entry) => entry.sidePortraits)).slice(0, 30);
  const repeatedActions = repeatedValues(entries.flatMap((entry) => entry.protagonistActions), CADENCE_PRESSURE_THRESHOLDS.textDiversity.repeatedActionCount);
  const repeatedPortraits = repeatedValues(entries.flatMap((entry) => entry.sidePortraits), CADENCE_PRESSURE_THRESHOLDS.textDiversity.repeatedPortraitCount);

  const trail = entries
    .map((entry) => {
      const actions = entry.protagonistActions.length > 0
        ? entry.protagonistActions.join(language === "en" ? ", " : "、")
        : (language === "en" ? "none" : "无");
      const portraits = entry.sidePortraits.length > 0
        ? entry.sidePortraits.join(language === "en" ? ", " : "、")
        : (language === "en" ? "none" : "无");
      return language === "en"
        ? `- Ch${entry.chapter}: ending=${entry.endingShape} | register=${entry.register}/${entry.tempo} | actions=${actions} | portraits=${portraits} | ${entry.excerpt}`
        : `- 第${entry.chapter}章：结尾=${entry.endingShape}｜气质=${entry.register}/${entry.tempo}｜动作=${actions}｜画像=${portraits}｜${entry.excerpt}`;
    })
    .join("\n");

  if (language === "en") {
    const pressure = target.pressureNotes.length > 0 ? target.pressureNotes.join("; ") : "none";
    return [
      "## Text Diversity / Ending Ledger (soft cadence pressure)",
      `Recent ending shapes: ${recentEndingShapes.join(", ") || "(none)"}`,
      `Recent register / tempo: ${recentRegisters.join(", ") || "(none)"} / ${recentTempos.join(", ") || "(none)"}`,
      `Recent protagonist external actions: ${recentActions.join(", ") || "(none)"}`,
      `Recent side-character portrait templates: ${recentPortraits.join(", ") || "(none)"}`,
      `Repeated actions under pressure: ${repeatedActions.join(", ") || "(none)"}`,
      `Repeated portrait templates under pressure: ${repeatedPortraits.join(", ") || "(none)"}`,
      `This chapter register target: ${target.registerTarget}; tempo target: ${target.tempoTarget}.`,
      `Cadence pressure: ${pressure}`,
      "Requirement: choose a different ending shape from the recent list; do not reuse the same protagonist tic or the same side-character portrait template. Let the chapter's scenes obey the register/tempo target. This is prompt pressure only, not a blocking validator.",
      "Recent trail:",
      trail,
    ].join("\n");
  }

  const pressure = target.pressureNotes.length > 0 ? target.pressureNotes.join("；") : "无";
  return [
    "## 文本多样性 / 结尾账本（软 cadence 压力）",
    `最近已用结尾形状：${recentEndingShapes.join("、") || "（无）"}`,
    `最近 register / tempo：${recentRegisters.join("、") || "（无）"} / ${recentTempos.join("、") || "（无）"}`,
    `最近主角外化小动作：${recentActions.join("、") || "（无）"}`,
    `最近客人/配角画像模板：${recentPortraits.join("、") || "（无）"}`,
    `重复小动作压力：${repeatedActions.join("、") || "（无）"}`,
    `重复画像压力：${repeatedPortraits.join("、") || "（无）"}`,
    `本章文本气质目标：register=${target.registerTarget}；tempo=${target.tempoTarget}。`,
    `cadence 压力：${pressure}`,
    "本章要求：结尾换一种形状，禁止连用同型；主角情绪不要再靠同一个招牌小动作外化；新客人/配角不要复用同一阶层/衣着/手部特征/处境模板。正文场景必须服从本章 register/tempo 目标。这是 prompt 压力，不是阻断校验。",
    "最近轨迹：",
    trail,
  ].join("\n");
}

export async function analyzeTextDiversityFatigue(params: {
  readonly storyDir: string;
  readonly chapterNumber: number;
  readonly chapterContent: string;
  readonly language: "zh" | "en";
}): Promise<{ readonly issues: ReadonlyArray<TextDiversityIssue> }> {
  const content = await readFile(join(params.storyDir, "ending_ledger.md"), "utf-8").catch(() => "");
  const previousEntries = content.trim()
    ? parseEndingLedgerMarkdown(content)
      .filter((entry) => entry.chapter < params.chapterNumber)
      .sort((left, right) => right.chapter - left.chapter)
    : [];
  if (previousEntries.length === 0) {
    return { issues: [] };
  }

  const current = extractEndingSignature({
    chapterNumber: params.chapterNumber,
    content: params.chapterContent,
    language: params.language,
  });
  const entries = [current, ...previousEntries].slice(0, CADENCE_PRESSURE_THRESHOLDS.textDiversity.lookback);
  return { issues: buildTextDiversityIssues(entries, params.language) };
}

export function parseEndingLedgerMarkdown(markdown: string): EndingLedgerEntry[] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => parseMarkdownChapterNumber(line) !== null)
    .map((line) => {
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim().replace(/\\\|/g, "|"));
      const chapter = Number(cells[0]);
      return {
        chapter,
        endingShape: cells[1] ?? "",
        signature: cells[2] ?? "",
        register: cells[3] ?? "",
        tempo: cells[4] ?? "",
        protagonistActions: splitListCell(cells[5] ?? ""),
        sidePortraits: splitListCell(cells[6] ?? ""),
        excerpt: cells[7] ?? "",
      };
    })
    .filter((entry) => Number.isFinite(entry.chapter));
}

function renderUpsertedEndingLedger(
  existingMarkdown: string,
  newRows: ReadonlyArray<string>,
  language: "zh" | "en",
): string {
  const rowByChapter = new Map<number, string>();
  const nonDataLines: string[] = [];

  for (const line of existingMarkdown.split("\n")) {
    const chapter = parseMarkdownChapterNumber(line);
    if (chapter === null) {
      if (line.trim().length > 0 || nonDataLines.length > 0) nonDataLines.push(line);
      continue;
    }
    rowByChapter.set(chapter, normalizeMarkdownTableRow(line));
  }

  for (const row of newRows) {
    const chapter = parseMarkdownChapterNumber(row);
    if (chapter !== null) rowByChapter.set(chapter, normalizeMarkdownTableRow(row));
  }

  const scaffold = ensureEndingLedgerScaffold(nonDataLines, language);
  const rows = [...rowByChapter.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, row]) => row);
  return [...trimTrailingEmptyLines(scaffold), ...rows, ""].join("\n");
}

function renderEndingLedgerRow(signature: EndingSignature): string {
  return [
    signature.chapter,
    signature.endingShape,
    signature.signature,
    signature.register,
    signature.tempo,
    signature.protagonistActions.join("、"),
    signature.sidePortraits.join("、"),
    signature.excerpt,
  ].map((cell) => String(cell).replace(/\|/g, "\\|").trim()).join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function ensureEndingLedgerScaffold(lines: string[], language: "zh" | "en"): string[] {
  const cleaned = trimTrailingEmptyLines(lines.length > 0 ? lines : defaultEndingLedgerHeader(language));
  const hasHeader = cleaned.some((line) => /^\|\s*(章节|Chapter)\s*\|/i.test(line.trim()));
  if (!hasHeader) {
    return [
      ...cleaned,
      ...(cleaned.length > 0 ? [""] : []),
      ...defaultEndingLedgerHeader(language).slice(2),
    ];
  }
  return cleaned;
}

function defaultEndingLedgerHeader(language: "zh" | "en"): string[] {
  return language === "en"
    ? [
        "# Ending Ledger",
        "",
        "| Chapter | Ending Shape | Ending Signature | Register | Tempo | Protagonist Actions | Side Portraits | Excerpt |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ]
    : [
        "# 结尾账本",
        "",
        "| 章节 | 结尾形状 | 结尾签名 | Register | Tempo | 主角外化动作 | 客人/配角画像 | 结尾摘录 |",
        "|------|----------|----------|----------|----------|--------------|----------------|----------|",
      ];
}

function buildTextDiversityIssues(
  entriesDescWithCurrent: ReadonlyArray<EndingLedgerEntry>,
  language: "zh" | "en",
): TextDiversityIssue[] {
  const issues: TextDiversityIssue[] = [];
  const current = entriesDescWithCurrent[0];
  if (!current) return issues;

  const endingStreak = countLeadingStreak(entriesDescWithCurrent, (entry) => entry.endingShape);
  if (endingStreak >= CADENCE_PRESSURE_THRESHOLDS.textDiversity.endingShapeHighCount) {
    issues.push(language === "en"
      ? {
          severity: "warning",
          category: "Ending Shape Monotony",
          description: `The latest ${endingStreak} chapters share the same ending shape: ${current.endingShape}.`,
          suggestion: "Change the next landing shape: use dialogue, consequence, public fallout, or a decisive action instead of repeating the same close.",
        }
      : {
          severity: "warning",
          category: "结尾形状重复",
          description: `最近${endingStreak}章连续使用“${current.endingShape}”结尾，章尾读感会公式化。`,
          suggestion: "下一章结尾必须换形状：用对话收束、明确落点、公开后果或人物选择，不再沿用同型留白。",
        });
  }

  const registerStreak = countLeadingStreak(entriesDescWithCurrent, (entry) => entry.register);
  if (registerStreak >= CADENCE_PRESSURE_THRESHOLDS.textDiversity.registerHighCount) {
    issues.push(language === "en"
      ? {
          severity: "warning",
          category: "Register Monotony",
          description: `The latest ${registerStreak} chapters stay in ${current.register}.`,
          suggestion: "Force a register shift in the next chapter: warm, lighter, brighter, or dialogue-driven.",
        }
      : {
          severity: "warning",
          category: "文本气质单调",
          description: `最近${registerStreak}章 register 持续停留在“${current.register}”，主角和叙述温度开始一个味。`,
          suggestion: "下一章必须换档：安排温暖、轻松、明快或对话密的场面，不要继续阴郁内省/高压观察到底。",
        });
  }

  const tempoStreak = countLeadingStreak(entriesDescWithCurrent, (entry) => entry.tempo);
  if (tempoStreak >= CADENCE_PRESSURE_THRESHOLDS.textDiversity.tempoHighCount) {
    issues.push(language === "en"
      ? {
          severity: "warning",
          category: "Tempo Monotony",
          description: `The latest ${tempoStreak} chapters stay at ${current.tempo} tempo.`,
          suggestion: "Shift the next chapter's tempo with a faster exchange, a public beat, or a clean middle-tempo consequence scene.",
        }
      : {
          severity: "warning",
          category: "节奏档位单调",
          description: `最近${tempoStreak}章 tempo 持续停留在“${current.tempo}”，阅读呼吸被压平。`,
          suggestion: "下一章切换 tempo：用快节奏对话、公开动作或中速后果段制造呼吸变化。",
        });
  }

  const repeatedCurrentActions = current.protagonistActions.filter((action) =>
    countTokenHits(entriesDescWithCurrent, (entry) => entry.protagonistActions, action) >= CADENCE_PRESSURE_THRESHOLDS.textDiversity.repeatedActionCount,
  );
  if (repeatedCurrentActions.length > 0) {
    issues.push(language === "en"
      ? {
          severity: "warning",
          category: "Protagonist Tic Repetition",
          description: `Recent chapters reuse the protagonist external action: ${unique(repeatedCurrentActions).join(", ")}.`,
          suggestion: "Externalize emotion through a different body signal, social action, or practical task; do not lean on the same tic again.",
        }
      : {
          severity: "warning",
          category: "招牌小动作重复",
          description: `近章反复用“${unique(repeatedCurrentActions).join("、")}”外化主角情绪。`,
          suggestion: "下一章换身体语言或行为承载情绪，不要再靠同一个 tic（擦、拧、攥、叠等）解决人物内心。",
        });
  }

  const repeatedCurrentPortraits = current.sidePortraits.filter((portrait) =>
    countTokenHits(entriesDescWithCurrent, (entry) => entry.sidePortraits, portrait) >= CADENCE_PRESSURE_THRESHOLDS.textDiversity.repeatedPortraitCount,
  );
  if (repeatedCurrentPortraits.length > 0) {
    issues.push(language === "en"
      ? {
          severity: "warning",
          category: "Side Portrait Repetition",
          description: `Recent side characters reuse portrait templates: ${unique(repeatedCurrentPortraits).join(", ")}.`,
          suggestion: "Introduce the next side character from a different class, age, texture, body signature, or life pressure.",
        }
      : {
          severity: "warning",
          category: "配角画像重复",
          description: `近章客人/配角画像反复落在“${unique(repeatedCurrentPortraits).join("、")}”。`,
          suggestion: "下一轮新角色换阶层、年龄、气质、身体签名或生活处境，避免继续工装/油污/攒钱模板。",
        });
  }

  return issues;
}

function chooseTextDiversityTarget(
  entriesDesc: ReadonlyArray<EndingLedgerEntry>,
  language: "zh" | "en",
): { readonly registerTarget: string; readonly tempoTarget: string; readonly pressureNotes: ReadonlyArray<string> } {
  const registerStreak = countLeadingStreak(entriesDesc, (entry) => entry.register);
  const tempoStreak = countLeadingStreak(entriesDesc, (entry) => entry.tempo);
  const latestRegister = entriesDesc[0]?.register ?? "";
  const latestTempo = entriesDesc[0]?.tempo ?? "";
  const recentRegisters = entriesDesc.slice(0, 4).map((entry) => entry.register);
  const hasRecentBreather = recentRegisters.some((register) =>
    language === "en"
      ? /warm|light|dialogue|bright/i.test(register)
      : /温暖|轻松|对话密|明快/u.test(register),
  );
  const pressureNotes: string[] = [];

  let registerTarget = language === "en" ? "different from the latest register" : `避开“${latestRegister || "上一章气质"}”`;
  if (registerStreak >= 2 || !hasRecentBreather) {
    registerTarget = language === "en" ? "warm / bright / dialogue-dense" : "温暖 / 明快 / 对话密";
    pressureNotes.push(language === "en"
      ? `register pressure: ${registerStreak} chapter(s) on ${latestRegister || "same register"}`
      : `register 压力：${registerStreak}章停在“${latestRegister || "同档"}”或近4章无喘息`);
  }

  let tempoTarget = language === "en" ? "medium with visible variation" : "中速并有快慢变化";
  if (tempoStreak >= 2) {
    if (/slow|慢/u.test(latestTempo)) {
      tempoTarget = language === "en" ? "fast / dialogue-driven" : "快 / 对话驱动";
    } else if (/fast|快/u.test(latestTempo)) {
      tempoTarget = language === "en" ? "medium consequence beat" : "中速后果段";
    } else {
      tempoTarget = language === "en" ? "faster public exchange" : "更快的公开交锋";
    }
    pressureNotes.push(language === "en"
      ? `tempo pressure: ${tempoStreak} chapter(s) on ${latestTempo || "same tempo"}`
      : `tempo 压力：${tempoStreak}章停在“${latestTempo || "同档"}”`);
  }

  const endingStreak = countLeadingStreak(entriesDesc, (entry) => entry.endingShape);
  if (endingStreak >= 2) {
    pressureNotes.push(language === "en"
      ? `ending pressure: ${endingStreak} chapter(s) on ${entriesDesc[0]?.endingShape ?? "same shape"}`
      : `结尾压力：${endingStreak}章同为“${entriesDesc[0]?.endingShape ?? "同型"}”`);
  }

  return {
    registerTarget,
    tempoTarget,
    pressureNotes,
  };
}

function classifyEndingShape(ending: string, language: "zh" | "en"): string {
  const patterns = language === "en" ? EN_ENDING_SHAPE_PATTERNS : ZH_ENDING_SHAPE_PATTERNS;
  const finalSentence = extractFinalSentence(ending);
  if (finalSentence) {
    for (const { shape, pattern } of patterns) {
      if (pattern.test(finalSentence)) return shape;
    }
  }
  for (const { shape, pattern } of patterns) {
    if (pattern.test(ending)) return shape;
  }
  return language === "en" ? "Concrete image close" : "具体画面收束";
}

function classifyRegister(content: string, language: "zh" | "en"): string {
  const quoteCount = (content.match(language === "en" ? /["']/g : /[“”「」『』]/g) ?? []).length;
  const lineCount = Math.max(1, content.split(/\n+/).filter((line) => line.trim()).length);
  if (quoteCount >= Math.max(8, lineCount * 0.8)) return language === "en" ? "dialogue-dense" : "对话密";

  if (language === "en") {
    if (/\b(smiled|laughed|joked|warm|soft|kitchen|meal|home|together|held her hand|tea)\b/i.test(content)) return "warm";
    if (/\b(chased|blood|knife|threat|gun|ran|screamed|danger|trap|deadline|cornered)\b/i.test(content)) return "tense";
    if (/\b(light|quick|bright|clean|decided|paid|moved|opened)\b/i.test(content)) return "bright";
    if (/\b(silent|dark|cold|remembered|alone|watched|thought|shadow|rain)\b/i.test(content)) return "gloomy introspective";
    return "medium";
  }

  if (/(笑|打趣|玩笑|轻声|饭|汤|热茶|灯下|一起|握住|家里|暖|孩子|母亲|外婆)/u.test(content)) return "温暖";
  if (/(追|砸|刀|血|枪|威胁|冲|喊|逃|逼近|危险|陷阱|对峙| deadline|最后期限)/iu.test(content)) return "紧张";
  if (/(调侃|噗|哈哈|乐|贫嘴|轻松|好笑|眨眼)/u.test(content)) return "轻松";
  if (/(当场|立刻|转身|推开|拿出|递给|拍在|走进|站出来|明亮|干脆|利落)/u.test(content)) return "明快";
  if (/(沉默|没说话|没有开口|黑暗|夜色|冷|想起|记得|独自|盯着|雨|影子|压抑)/u.test(content)) return "阴郁内省";
  return "中性推进";
}

function classifyTempo(content: string, language: "zh" | "en"): string {
  const sentences = splitSentences(content);
  const avgLength = sentences.length > 0
    ? sentences.reduce((sum, sentence) => sum + sentence.length, 0) / sentences.length
    : content.length;
  const quoteCount = (content.match(language === "en" ? /["']/g : /[“”「」『』]/g) ?? []).length;
  const actionHits = (content.match(language === "en"
    ? /\b(ran|grabbed|opened|closed|hit|pressed|turned|threw|pushed|pulled|shouted|called)\b/gi
    : /(跑|冲|抓|推|拉|拍|砸|按|拨|转身|喊|叫|递|拿|掀|打开|关上)/gu) ?? []).length;
  const introspectionHits = (content.match(language === "en"
    ? /\b(remembered|thought|wondered|realized|watched|listened|silent|slowly)\b/gi
    : /(想起|记得|意识到|盯着|听着|沉默|慢慢|没有动|看了很久)/gu) ?? []).length;

  if (quoteCount >= 8 || actionHits >= 12) return language === "en" ? "fast" : "快";
  if (introspectionHits >= 5 || avgLength >= (language === "en" ? 135 : 62)) return language === "en" ? "slow-observational" : "慢观察";
  if (avgLength <= (language === "en" ? 72 : 34)) return language === "en" ? "fast" : "快";
  return language === "en" ? "medium" : "中";
}

function extractEndingText(content: string): string {
  const lines = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      line.length > 0
      && !line.startsWith("#")
      && !line.startsWith("|")
      && !line.startsWith("===")
      && !/^<!--/.test(line),
    );
  return lines.slice(-2).join(" ").trim();
}

function stripMarkdownHeadings(content: string): string {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      line.length > 0
      && !line.startsWith("#")
      && !line.startsWith("|")
      && !line.startsWith("===")
      && !/^<!--/.test(line),
    )
    .join("\n");
}

function splitSentences(content: string): string[] {
  return content
    .replace(/\s+/g, " ")
    .split(/(?<=[。！？!?\.])\s*/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function extractFinalSentence(content: string): string {
  const sentences = splitSentences(content);
  return sentences[sentences.length - 1] ?? content.trim();
}

function extractPatternLabels(
  content: string,
  definitions: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }>,
  limit: number,
): string[] {
  return definitions
    .filter((definition) => definition.pattern.test(content))
    .map((definition) => definition.label)
    .slice(0, limit);
}

function splitListCell(cell: string): string[] {
  return cell
    .split(/[、,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function repeatedValues(values: ReadonlyArray<string>, minCount: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([value]) => value);
}

function countLeadingStreak<T>(entries: ReadonlyArray<T>, selector: (entry: T) => string): number {
  const first = selector(entries[0] as T);
  if (!first) return 0;
  let count = 0;
  for (const entry of entries) {
    if (selector(entry) !== first) break;
    count += 1;
  }
  return count;
}

function countTokenHits(
  entries: ReadonlyArray<EndingLedgerEntry>,
  selector: (entry: EndingLedgerEntry) => ReadonlyArray<string>,
  token: string,
): number {
  return entries.filter((entry) => selector(entry).includes(token)).length;
}

function clipSingleLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function unique(values: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function trimTrailingEmptyLines(lines: ReadonlyArray<string>): string[] {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1]!.trim().length === 0) copy.pop();
  return copy;
}
