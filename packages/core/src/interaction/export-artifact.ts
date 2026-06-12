import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EPub } from "epub-gen-memory";

export interface ExportStateLike {
  readonly bookDir: (bookId: string) => string;
  readonly loadBookConfig: (bookId: string) => Promise<{ readonly title: string; readonly language?: string }>;
  readonly loadChapterIndex: (bookId: string) => Promise<ReadonlyArray<{
    readonly number: number;
    readonly status: string;
    readonly wordCount: number;
  }>>;
}

export interface ExportArtifact {
  readonly outputPath: string;
  readonly fileName: string;
  readonly chaptersExported: number;
  readonly totalWords: number;
  readonly format: "txt" | "md" | "epub";
  readonly contentType: string;
  readonly payload: string | Buffer;
}

function buildChapterFileLookup(files: ReadonlyArray<string>): ReadonlyMap<number, string> {
  const lookup = new Map<number, string>();
  for (const file of files) {
    if (!file.endsWith(".md") || !/^\d{4}/.test(file)) {
      continue;
    }
    const chapterNumber = parseInt(file.slice(0, 4), 10);
    if (!lookup.has(chapterNumber)) {
      lookup.set(chapterNumber, file);
    }
  }
  return lookup;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ── 导出前的逐章规范化(只清洗导出流,绝不改落盘章节文件) ──────────────────
// 真实书稿的章节 .md 首行不统一:一半带「# 第3章 私信」标题、一半正文直接开头。
// 原始直拼的后果:txt 里换章只剩空行读者看不出来、裸 `#`/`---` markdown 残留粘到
// 发布后台直接破相、epub 目录出现 "Untitled Chapter" 英文占位。约定:
// 章题不信任正文,统一从文件名(0003_私信.md)推导;场景分隔线 txt/epub 渲染为「✦」、
// md 保留标准 `---`;连续空行收敛为一个。

const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;
const CN_UNITS = ["", "十", "百", "千"] as const;
/** 章题里的「第N章/回」前缀(阿拉伯或中文数字),用于防「第三章 第3章 私信」式重复。 */
const CHAPTER_PREFIX_RE = /^第\s*[\d零一二三四五六七八九十百千]+\s*[章回][\s::.、]*/;

/** 1..9999 → 中文数字(三/十二/一百零三),够章号用;超界回退阿拉伯数字。 */
export function numberToChineseNumeral(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 9999) {
    return String(value);
  }
  const digits = String(value).split("").map(Number);
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    const digit = digits[i]!;
    if (digit === 0) {
      // 中段的 0 记一个「零」(103→一百零三),末位的 0 不发音(120→一百二十)
      if (out && !out.endsWith(CN_DIGITS[0]) && i < digits.length - 1) {
        out += CN_DIGITS[0];
      }
      continue;
    }
    out += CN_DIGITS[digit]! + CN_UNITS[digits.length - 1 - i]!;
  }
  return out.replace(/^一十/, "十").replace(/零+$/, "");
}

/** 文件最顶端的 YAML frontmatter 围栏;中段的 --- 是场景分隔线,不归它管。 */
function stripFrontmatter(raw: string): string {
  const text = raw.replace(/^\uFEFF/, "");
  const fence = text.match(/^---\s*\n[\s\S]*?\n---\s*\n/);
  return fence ? text.slice(fence[0].length) : text;
}

/** 从文件名提取题名:`0003_私信.md` → 「私信」;旧书纯章号文件名返回空串。 */
function chapterNameFromFile(fileName: string): string {
  return fileName
    .replace(/\.md$/, "")
    .replace(/^\d+[_-]?/, "")
    .replace(/_/g, " ")
    .trim();
}

/** 标题行 → 纯题名:剥井号与「第N章 / Chapter N:」前缀。 */
function chapterNameFromHeadingLine(line: string): string {
  return line
    .replace(/^#{1,6}[ \t]*/, "")
    .replace(CHAPTER_PREFIX_RE, "")
    .replace(/^Chapter\s+\d+\s*[::.-]?\s*/i, "")
    .trim();
}

/**
 * 清洗单章正文。keepMarkdown=true(md 导出)保留正文里的 markdown 语义,
 * 只摘走章题行;false(txt/epub)同时剥中段标题井号、分隔线换「✦」。
 */
function normalizeChapterBody(
  raw: string,
  keepMarkdown: boolean,
): { readonly nameFromBody: string; readonly body: string } {
  let text = stripFrontmatter(raw).replace(/\r\n/g, "\n");
  // 首个非空行若是 # 标题 → 视为章题摘走(章题由 deriveChapterHeading 统一重排)
  let nameFromBody = "";
  const heading = text.match(/^\s*(#{1,6}[ \t]*[^\n]*)\n?/);
  if (heading) {
    nameFromBody = chapterNameFromHeadingLine(heading[1]!);
    text = text.slice(heading[0].length);
  }
  // 场景分隔线:txt/epub 渲染为「✦」,md 保留标准 ---
  text = text.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, keepMarkdown ? "---" : "✦");
  if (!keepMarkdown) {
    // 中段残留标题行只剥井号不吞文本,防误杀正文
    text = text.replace(/^#{1,6}[ \t]*/gm, "");
  }
  // 空行规整:连续多个空行收敛为一个;首尾空白裁掉
  text = text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return { nameFromBody, body: text };
}

/** 统一章题:zh →「第三章 私信」,en →「Chapter 3: Title」;无题名时只留序号。 */
function deriveChapterHeading(params: {
  readonly number: number;
  readonly fileName: string;
  readonly nameFromBody: string;
  readonly language: "zh" | "en";
}): string {
  const name = (chapterNameFromFile(params.fileName) || params.nameFromBody)
    .replace(CHAPTER_PREFIX_RE, "")
    .trim();
  if (params.language === "en") {
    return name ? `Chapter ${params.number}: ${name}` : `Chapter ${params.number}`;
  }
  const ordinal = `第${numberToChineseNumeral(params.number)}章`;
  return name ? `${ordinal} ${name}` : ordinal;
}

/** 清洗后的正文 → epub 段落 html;「✦」场景分隔线居中呈现。 */
function chapterBodyToHtml(body: string): string {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line === "✦"
        ? `<p style="text-align:center">✦</p>`
        : `<p>${escapeHtml(line)}</p>`,
    )
    .join("\n");
}

export async function buildExportArtifact(
  state: ExportStateLike,
  bookId: string,
  options: {
    readonly format?: "txt" | "md" | "epub";
    readonly approvedOnly?: boolean;
    readonly outputPath?: string;
  },
): Promise<ExportArtifact> {
  const format = options.format ?? "txt";
  const index = await state.loadChapterIndex(bookId);
  const book = await state.loadBookConfig(bookId);
  const chapters = options.approvedOnly
    ? index.filter((chapter) => chapter.status === "approved")
    : index;

  if (chapters.length === 0) {
    throw new Error("No chapters to export.");
  }

  const bookDir = state.bookDir(bookId);
  const chaptersDir = join(bookDir, "chapters");
  const projectRoot = dirname(dirname(bookDir));
  const outputPath = options.outputPath ?? join(projectRoot, `${bookId}_export.${format}`);
  const chapterFiles = buildChapterFileLookup(await readdir(chaptersDir));
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);
  const language: "zh" | "en" = book.language === "en" ? "en" : "zh";

  // 逐章读盘 + 规范化:md 保留正文 markdown 语义,txt/epub 剥成纯文本
  const normalized: Array<{ heading: string; body: string }> = [];
  for (const chapter of chapters) {
    const match = chapterFiles.get(chapter.number);
    if (!match) {
      continue;
    }
    const raw = await readFile(join(chaptersDir, match), "utf-8");
    const { nameFromBody, body } = normalizeChapterBody(raw, format === "md");
    normalized.push({
      heading: deriveChapterHeading({
        number: chapter.number,
        fileName: match,
        nameFromBody,
        language,
      }),
      body,
    });
  }

  if (format === "epub") {
    const epubInstance = new EPub(
      { title: book.title, lang: language === "en" ? "en" : "zh-CN" },
      normalized.map(({ heading, body }) => ({ title: heading, content: chapterBodyToHtml(body) })),
    );
    return {
      outputPath,
      fileName: `${bookId}.epub`,
      chaptersExported: normalized.length,
      totalWords,
      format,
      contentType: "application/epub+zip",
      payload: await epubInstance.genEpub(),
    };
  }

  // txt:书名行 + 每章「章题 + 空行 + 正文」,章间空两行;md:# 书名 + ## 章题,层级统一
  const blocks =
    format === "md"
      ? [`# ${book.title}`, ...normalized.map(({ heading, body }) => `## ${heading}\n\n${body}`)]
      : [book.title, ...normalized.map(({ heading, body }) => `${heading}\n\n${body}`)];

  return {
    outputPath,
    fileName: `${bookId}.${format}`,
    chaptersExported: normalized.length,
    totalWords,
    format,
    contentType: format === "md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
    payload: blocks.join(format === "md" ? "\n\n" : "\n\n\n") + "\n",
  };
}

export async function writeExportArtifact(
  state: ExportStateLike,
  bookId: string,
  options: {
    readonly format?: "txt" | "md" | "epub";
    readonly approvedOnly?: boolean;
    readonly outputPath?: string;
  },
): Promise<Omit<ExportArtifact, "payload" | "contentType" | "fileName">> {
  const artifact = await buildExportArtifact(state, bookId, options);
  await mkdir(dirname(artifact.outputPath), { recursive: true });
  await writeFile(artifact.outputPath, artifact.payload);
  return {
    outputPath: artifact.outputPath,
    chaptersExported: artifact.chaptersExported,
    totalWords: artifact.totalWords,
    format: artifact.format,
  };
}
