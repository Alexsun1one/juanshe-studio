/**
 * 可恢复章节草稿落盘。
 *
 * 写章的关键阶段(写手交稿、候选定稿)会把当前正文以带元信息的 Markdown 存到
 * `story/recovery/chapter-XXXX.writer-draft.md`,这样即便后续校验 / 结算 / 落库环节崩了,
 * 也能从这份草稿里把劳动成果捞回来,不至于整章白写。纯 IO 工具函数,从 runner.ts 抽离。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LengthLanguage } from "../utils/length-metrics.js";

export async function saveRecoverableChapterDraft(params: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly stage: "writer" | "candidate";
  readonly language: LengthLanguage;
  readonly wordCount: number;
}): Promise<void> {
  const recoveryDir = join(params.bookDir, "story", "recovery");
  await mkdir(recoveryDir, { recursive: true });
  const padded = String(params.chapterNumber).padStart(4, "0");
  const safeTitle = params.title.replace(/[\r\n]+/g, " ").trim()
    || (params.language === "en" ? "Untitled" : "未命名");
  const heading = params.language === "en"
    ? `# Chapter ${params.chapterNumber}: ${safeTitle}`
    : `# 第${params.chapterNumber}章 ${safeTitle}`;
  const body = [
    "<!-- hardwrite-recovery-draft -->",
    `stage: ${params.stage}`,
    `chapter: ${params.chapterNumber}`,
    `title: ${safeTitle}`,
    `wordCount: ${params.wordCount}`,
    `savedAt: ${new Date().toISOString()}`,
    "",
    heading,
    "",
    params.content.trimEnd(),
    "",
  ].join("\n");

  await writeFile(join(recoveryDir, `chapter-${padded}.writer-draft.md`), body, "utf-8");
}
