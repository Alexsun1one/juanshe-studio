import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "./fs-atomic.js";
import {
  normalizeMarkdownTableRow,
  parseMarkdownChapterNumber,
  withStoryTruthWriteLock,
  type TruthWriteLogger,
} from "./story-truth-writer.js";

export interface OpeningSignature {
  readonly chapter: number;
  readonly openingType: string;
  readonly signature: string;
  readonly imagery: ReadonlyArray<string>;
  readonly excerpt: string;
}

export interface OpeningLedgerEntry extends OpeningSignature {}

const ZH_IMAGERY_TERMS = [
  "收银台", "便利店", "塑料袋", "玻璃门", "卷帘门", "雨水", "积水", "路灯", "霓虹", "抹布",
  "柜台", "货架", "门帘", "钥匙", "手机", "屏幕", "账本", "照片", "信封", "纸条",
  "雨伞", "校服", "制服", "外套", "香烟", "茶杯", "水杯", "药片", "血迹", "刀",
  "灯光", "灯牌", "巷口", "巷子", "楼道", "窗户", "门缝", "雨", "风", "雪",
  "雾", "潮气", "灰尘", "汽油味", "消毒水", "钟声", "脚步声", "铃声",
];

const EN_IMAGERY_TERMS = [
  "cash register", "convenience store", "plastic bag", "glass door", "rainwater",
  "puddle", "streetlight", "neon", "rag", "counter", "shelf", "key", "phone",
  "screen", "ledger", "photo", "envelope", "note", "umbrella", "uniform", "coat",
  "cigarette", "teacup", "blood", "knife", "light", "alley", "stairwell", "window",
  "doorway", "rain", "wind", "snow", "fog", "dust", "footsteps", "bell",
];

export function extractOpeningSignature(params: {
  readonly chapterNumber: number;
  readonly title?: string;
  readonly content: string;
  readonly language: "zh" | "en";
}): OpeningSignature {
  const opening = extractOpeningText(params.content);
  const openingType = classifyOpeningType(opening, params.language);
  const imagery = extractOpeningImagery(opening, params.language);
  const excerpt = clipSingleLine(opening, params.language === "en" ? 180 : 90);
  const signature = params.language === "en"
    ? `${openingType}: ${excerpt}`
    : `${openingType}：${excerpt}`;

  return {
    chapter: params.chapterNumber,
    openingType,
    signature,
    imagery,
    excerpt,
  };
}

export async function upsertOpeningLedgerFile(params: {
  readonly storyDir: string;
  readonly signature: OpeningSignature;
  readonly language: "zh" | "en";
  readonly logger?: TruthWriteLogger;
}): Promise<void> {
  await withStoryTruthWriteLock(params.storyDir, () => upsertOpeningLedgerFileUnlocked(params));
}

export async function upsertOpeningLedgerFileUnlocked(params: {
  readonly storyDir: string;
  readonly signature: OpeningSignature;
  readonly language: "zh" | "en";
  readonly logger?: TruthWriteLogger;
}): Promise<void> {
  const ledgerPath = join(params.storyDir, "opening_ledger.md");
  await mkdir(params.storyDir, { recursive: true });
  const existing = await readFile(ledgerPath, "utf-8").catch(() => "");
  const next = renderUpsertedOpeningLedger(existing, [renderOpeningLedgerRow(params.signature)], params.language);
  await atomicWriteFile(ledgerPath, next);

  const verified = await readFile(ledgerPath, "utf-8").catch(() => "");
  if (parseOpeningLedgerMarkdown(verified).some((entry) => entry.chapter === params.signature.chapter)) return;

  params.logger?.warn?.(
    params.language === "en"
      ? `[truth-write] opening_ledger.md self-heal: row for chapter ${params.signature.chapter} missing after atomic write; retrying upsert.`
      : `[truth-write] opening_ledger.md 自愈：第${params.signature.chapter}章行在原子写后缺失，重试 upsert。`,
  );
  const healed = renderUpsertedOpeningLedger(verified, [renderOpeningLedgerRow(params.signature)], params.language);
  await atomicWriteFile(ledgerPath, healed);
}

export async function buildOpeningLedgerBrief(params: {
  readonly storyDir: string;
  readonly currentChapter: number;
  readonly keepRecent: number;
  readonly language: "zh" | "en";
}): Promise<string | undefined> {
  const ledgerPath = join(params.storyDir, "opening_ledger.md");
  const content = await readFile(ledgerPath, "utf-8").catch(() => "");
  if (!content.trim()) return undefined;
  const entries = parseOpeningLedgerMarkdown(content)
    .filter((entry) => entry.chapter < params.currentChapter)
    .sort((left, right) => right.chapter - left.chapter)
    .slice(0, params.keepRecent);
  return renderOpeningLedgerBrief(entries, params.language);
}

export function renderOpeningLedgerBrief(
  entries: ReadonlyArray<OpeningLedgerEntry>,
  language: "zh" | "en",
): string | undefined {
  if (entries.length === 0) return undefined;
  const openingTypes = unique(entries.map((entry) => entry.openingType)).slice(0, 12);
  const imagery = unique(entries.flatMap((entry) => entry.imagery)).slice(0, 40);
  const trail = entries
    .map((entry) => {
      const images = entry.imagery.length > 0
        ? entry.imagery.join(language === "en" ? ", " : "、")
        : (language === "en" ? "none" : "无");
      return language === "en"
        ? `- Ch${entry.chapter}: ${entry.openingType} | imagery: ${images} | ${entry.excerpt}`
        : `- 第${entry.chapter}章：${entry.openingType}｜意象：${images}｜${entry.excerpt}`;
    })
    .join("\n");

  if (language === "en") {
    return [
      "## Used Opening / Imagery Ledger (hard avoidance)",
      `Recent opening types: ${openingTypes.join(", ") || "(none)"}`,
      `Recent signature imagery: ${imagery.join(", ") || "(none)"}`,
      "Recent trail:",
      trail,
      "Requirement: open this chapter with a different opening type. Avoid reusing the listed imagery in the first screen; if the same place or character must continue, make the first 100 words deliver a new sensory fact, new information, or new conflict.",
    ].join("\n");
  }

  return [
    "## 已用开篇/意象账本（硬避让）",
    `最近已用开篇类型：${openingTypes.join("、") || "（无）"}`,
    `最近已用招牌意象：${imagery.join("、") || "（无）"}`,
    "最近轨迹：",
    trail,
    "本章要求：必须换一种开篇类型；首屏避免复用上述意象。若必须承接同地点/同人物，开篇 100 字内要给新的感官、信息或冲突，不要复刻上一章仪式感。",
  ].join("\n");
}

export function parseOpeningLedgerMarkdown(markdown: string): OpeningLedgerEntry[] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => parseMarkdownChapterNumber(line) !== null)
    .map((line) => {
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim().replace(/\\\|/g, "|"));
      const chapter = Number(cells[0]);
      const imagery = (cells[3] ?? "")
        .split(/[、,]/)
        .map((item) => item.trim())
        .filter(Boolean);
      return {
        chapter,
        openingType: cells[1] ?? "",
        signature: cells[2] ?? "",
        imagery,
        excerpt: cells[4] ?? "",
      };
    })
    .filter((entry) => Number.isFinite(entry.chapter));
}

function renderUpsertedOpeningLedger(
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

  const scaffold = ensureOpeningLedgerScaffold(nonDataLines, language);
  const rows = [...rowByChapter.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, row]) => row);
  return [...trimTrailingEmptyLines(scaffold), ...rows, ""].join("\n");
}

function renderOpeningLedgerRow(signature: OpeningSignature): string {
  return [
    signature.chapter,
    signature.openingType,
    signature.signature,
    signature.imagery.join("、"),
    signature.excerpt,
  ].map((cell) => String(cell).replace(/\|/g, "\\|").trim()).join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function ensureOpeningLedgerScaffold(lines: string[], language: "zh" | "en"): string[] {
  const cleaned = trimTrailingEmptyLines(lines.length > 0 ? lines : defaultOpeningLedgerHeader(language));
  const hasHeader = cleaned.some((line) => /^\|\s*(章节|Chapter)\s*\|/i.test(line.trim()));
  if (!hasHeader) {
    return [
      ...cleaned,
      ...(cleaned.length > 0 ? [""] : []),
      ...defaultOpeningLedgerHeader(language).slice(2),
    ];
  }
  return cleaned;
}

function defaultOpeningLedgerHeader(language: "zh" | "en"): string[] {
  return language === "en"
    ? [
        "# Opening Ledger",
        "",
        "| Chapter | Opening Type | Opening Signature | Imagery | Excerpt |",
        "| --- | --- | --- | --- | --- |",
      ]
    : [
        "# 开篇账本",
        "",
        "| 章节 | 开篇类型 | 开篇签名 | 招牌意象 | 开篇摘录 |",
        "|------|----------|----------|----------|----------|",
      ];
}

function extractOpeningText(content: string): string {
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
  return lines.slice(0, 4).join(" ").trim();
}

function classifyOpeningType(opening: string, language: "zh" | "en"): string {
  const first = opening.slice(0, language === "en" ? 220 : 120);
  if (/^["'“‘「『]/.test(first)) return language === "en" ? "Dialogue opening" : "对话切入";
  if (language === "en") {
    if (/\b(grabbed|held|pushed|pulled|wiped|ran|walked|turned|pressed|opened|closed|lifted|stared)\b/i.test(first)) {
      return "Action opening";
    }
    if (/\b(morning|night|dawn|dusk|rain|snow|wind|fog|weather|streetlight)\b/i.test(first)) {
      return "Time/weather opening";
    }
    if (/\b(smell|sound|cold|warm|wet|pain|taste|heard|touched)\b/i.test(first)) return "Sensory opening";
    if (/\b(remembered|thought|realized|knew|wondered)\b/i.test(first)) return "Reflection opening";
    return "Scene opening";
  }

  if (/(攥|握|拿|推|拉|擦|走|跑|抬|低|伸|按|拧|踢|捡|递|摸|站|坐|开|关|盯|转身|掀|拍|摁|拎)/u.test(first)) {
    return "动作切入";
  }
  if (
    /(凌晨|清晨|早上|午后|傍晚|黄昏|夜里|半夜|天刚|雨停|雨夜|雪夜|周一|星期)/u.test(first)
    || /(雨|雪|雾|风|路灯|积水|夜色|天色|潮气)/u.test(first)
  ) {
    return "时间/天气切入";
  }
  if (/(味|气味|响|嗡|湿|冷|热|烫|黏|疼|刺|脚步声|铃声|雨声|呼吸)/u.test(first)) return "感官切入";
  if (/(进门|推门|走进|出现|站在门口|从.*出来)/u.test(first)) return "人物入场";
  if (/(想起|记得|知道|明白|意识到|觉得|以为)/u.test(first)) return "反思切入";
  return "场景切入";
}

function extractOpeningImagery(opening: string, language: "zh" | "en"): string[] {
  const source = opening.toLowerCase();
  const terms = language === "en" ? EN_IMAGERY_TERMS : ZH_IMAGERY_TERMS;
  const matched = terms
    .filter((term) => source.includes(term.toLowerCase()))
    .sort((left, right) => source.indexOf(left.toLowerCase()) - source.indexOf(right.toLowerCase()));
  return unique(matched).slice(0, 12);
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
