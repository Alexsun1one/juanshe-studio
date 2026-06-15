import { BaseAgent } from "./base.js";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readVolumeMap } from "../utils/outline-paths.js";
import {
  parsePendingHooksMarkdown,
  renderHookSnapshot,
} from "../utils/story-markdown.js";
import { atomicWriteFile } from "../utils/fs-atomic.js";
import { withStoryTruthWriteLock } from "../utils/story-truth-writer.js";
import { buildVolumeCadenceFileSet } from "../utils/volume-cadence-plan.js";

export interface ConsolidationResult {
  readonly volumeSummaries: string;
  readonly archivedVolumes: number;
  readonly retainedChapters: number;
  /**
   * Phase 7 hotfix 2: number of ledger hooks whose `promoted` flag flipped
   * from false to true during this consolidation run (advanced_count rule).
   * 0 when pending_hooks.md is absent or no hook crossed the threshold.
   */
  readonly promotedHookCount: number;
}

/**
 * Consolidates chapter summaries into volume-level narrative summaries.
 * Reduces token usage for long books while preserving critical context.
 */
export class ConsolidatorAgent extends BaseAgent {
  get name(): string {
    return "consolidator";
  }

  /**
   * Consolidate chapter summaries by volume.
   * - Reads outline/volume_map.md (fallback: legacy volume_outline.md) to
   *   determine volume boundaries
   * - For each completed volume, LLM compresses chapter summaries into a narrative paragraph
   * - Archives detailed summaries, keeps only recent volume's per-chapter rows
   */
  async consolidate(bookDir: string): Promise<ConsolidationResult> {
    const storyDir = join(bookDir, "story");
    const summariesPath = join(storyDir, "chapter_summaries.md");
    const volumeSummariesPath = join(storyDir, "volume_summaries.md");

    const [summariesRaw, outlineRaw, volumeOkrRaw] = await Promise.all([
      readFile(summariesPath, "utf-8").catch(() => ""),
      readVolumeMap(bookDir, ""),
      readFile(join(storyDir, "outline", "volume_okr.json"), "utf-8").catch(() => ""),
    ]);

    // Phase 7 hotfix 2: pre-archive re-promotion pass. Runs independently of
    // summary consolidation so a new book (no completed volumes yet) still
    // flips the `promoted` flag whenever a seed's advanced_count crosses the
    // threshold.
    const promotedHookCount = await this.rerunAdvancedCountPromotion(storyDir);
    await this.updateVolumeCadenceFiles(storyDir, outlineRaw, summariesRaw, volumeOkrRaw);

    if (!summariesRaw || !outlineRaw) {
      return { volumeSummaries: "", archivedVolumes: 0, retainedChapters: 0, promotedHookCount };
    }

    // Parse volume boundaries from outline
    const volumeBoundaries = this.parseVolumeBoundaries(outlineRaw);
    if (volumeBoundaries.length === 0) {
      return { volumeSummaries: "", archivedVolumes: 0, retainedChapters: 0, promotedHookCount };
    }

    // Parse chapter summaries into rows
    const { header, rows } = this.parseSummaryTable(summariesRaw);
    if (rows.length === 0) {
      return { volumeSummaries: "", archivedVolumes: 0, retainedChapters: 0, promotedHookCount };
    }

    const maxChapter = Math.max(...rows.map((r) => r.chapter));

    // Determine which volumes are "completed" (all chapters written)
    const completedVolumes: Array<{ name: string; startCh: number; endCh: number; rows: typeof rows }> = [];
    const currentVolumeRows: typeof rows = [];

    for (const vol of volumeBoundaries) {
      const volRows = rows.filter((r) => r.chapter >= vol.startCh && r.chapter <= vol.endCh);
      if (vol.endCh <= maxChapter && volRows.length > 0) {
        completedVolumes.push({ ...vol, rows: volRows });
      } else {
        // Current/incomplete volume — keep detailed rows
        currentVolumeRows.push(...volRows);
      }
    }

    // Also keep any rows not covered by volume boundaries
    const coveredChapters = new Set(volumeBoundaries.flatMap((v) => {
      const chs: number[] = [];
      for (let i = v.startCh; i <= v.endCh; i++) chs.push(i);
      return chs;
    }));
    for (const r of rows) {
      if (!coveredChapters.has(r.chapter)) currentVolumeRows.push(r);
    }

    if (completedVolumes.length === 0) {
      return {
        volumeSummaries: "",
        archivedVolumes: 0,
        retainedChapters: currentVolumeRows.length,
        promotedHookCount,
      };
    }

    // LLM consolidation for each completed volume
    const existingVolSummaries = await readFile(volumeSummariesPath, "utf-8").catch(() => "");
    const newSummaries: string[] = existingVolSummaries ? [existingVolSummaries.trim()] : ["# Volume Summaries\n"];

    for (const vol of completedVolumes) {
      const volSummaryRows = vol.rows.map((r) => r.raw).join("\n");

      const response = await this.chat([
        {
          role: "system",
          content: `You are a narrative summarizer. Compress chapter-by-chapter summaries into a single coherent paragraph (max 500 words) that captures the key events, character developments, and plot progression of this volume. Preserve specific names, locations, and plot points. Write in the same language as the input.`,
        },
        {
          role: "user",
          content: `Volume: ${vol.name} (Chapters ${vol.startCh}-${vol.endCh})\n\nChapter summaries:\n${header}\n${volSummaryRows}`,
        },
      ], { temperature: 0.3 });

      newSummaries.push(`\n## ${vol.name} (Ch.${vol.startCh}-${vol.endCh})\n\n${response.content.trim()}`);
    }

    await withStoryTruthWriteLock(storyDir, async () => {
      // 压缩调用可能耗时很长:进写锁后重新读最新摘要表,只移出本轮确实归档过的旧章节。
      // 若这期间有新章写入,它不会被旧 rows 覆盖掉。
      const latestRaw = await readFile(summariesPath, "utf-8").catch(() => summariesRaw);
      const latestParsed = this.parseSummaryTable(latestRaw);
      const archivedChapters = new Set(completedVolumes.flatMap((vol) => vol.rows.map((row) => row.chapter)));
      const retainedRows = latestParsed.rows.filter((row) => !archivedChapters.has(row.chapter));
      const retainedHeader = latestParsed.header || header;

      // Write volume summaries
      await atomicWriteFile(volumeSummariesPath, newSummaries.join("\n"));

      // Archive detailed summaries
      const archiveDir = join(storyDir, "summaries_archive");
      await mkdir(archiveDir, { recursive: true });
      for (const vol of completedVolumes) {
        const archivePath = join(archiveDir, `vol_${vol.startCh}-${vol.endCh}.md`);
        await atomicWriteFile(archivePath, `# ${vol.name}\n\n${header}\n${vol.rows.map((r) => r.raw).join("\n")}`);
      }

      // Rewrite chapter_summaries.md with only non-archived rows from the latest table.
      const retainedContent = retainedRows.length > 0
        ? `${retainedHeader}\n${retainedRows.map((r) => r.raw).join("\n")}\n`
        : `${retainedHeader}\n`;
      await atomicWriteFile(summariesPath, retainedContent);
    });

    return {
      volumeSummaries: newSummaries.join("\n"),
      archivedVolumes: completedVolumes.length,
      retainedChapters: currentVolumeRows.length,
      promotedHookCount,
    };
  }

  /**
   * Phase 7 hotfix 2 — re-run promotion for seeds whose advancedCount has
   * crossed the 2-chapter threshold since architect seed time. Delegates to
   * the shared `rerunPromotionPass` in utils/hook-promotion.ts.
   *
   * Returns the number of hooks that flipped from promoted=false (or
   * undefined) to promoted=true this run.
   */
  private async rerunAdvancedCountPromotion(storyDir: string): Promise<number> {
    const ledgerPath = join(storyDir, "pending_hooks.md");
    return withStoryTruthWriteLock(storyDir, async () => {
      const raw = await readFile(ledgerPath, "utf-8").catch(() => "");
      if (!raw.trim()) return 0;

      const hooks = parsePendingHooksMarkdown(raw);
      if (hooks.length === 0) return 0;

      const language: "zh" | "en" = /[\u4e00-\u9fff]/.test(raw) ? "zh" : "en";
      const summariesRaw = await readFile(join(storyDir, "chapter_summaries.md"), "utf-8").catch(() => "");

      const { rerunPromotionPass } = await import("../utils/hook-promotion.js");
      const result = rerunPromotionPass(hooks, summariesRaw);
      if (!result.updated) return 0;

      await atomicWriteFile(ledgerPath, renderHookSnapshot([...result.hooks], language));
      return result.flippedCount;
    });
  }

  private async updateVolumeCadenceFiles(
    storyDir: string,
    outlineRaw: string,
    summariesRaw: string,
    volumeOkrRaw: string,
  ): Promise<void> {
    const files = buildVolumeCadenceFileSet({
      volumeMap: outlineRaw,
      volumeOkrJson: volumeOkrRaw,
      chapterSummaries: summariesRaw,
      language: /[\u4e00-\u9fff]/.test(`${outlineRaw}\n${volumeOkrRaw}`) ? "zh" : "en",
    });
    if (!files) return;
    await withStoryTruthWriteLock(storyDir, async () => {
      await atomicWriteFile(join(storyDir, "volume_chapter_cadence.md"), files.cadenceMarkdown);
      await atomicWriteFile(join(storyDir, "progress_against_volume_kr.json"), files.krProgressJson);
    });
  }

  /**
   * 解析卷的章节边界。兼容两种 volume_map 写法:
   *   形式一(同行):  「### 第一卷：xxx（1-30章）」
   *   形式二(跨行):  「## 第一卷：退烧之始」+ 后续行「- 范围：第 1-30 章」
   * 没有边界就退化成空(不会误删/误压缩);只取每卷遇到的第一条范围行。
   */
  private parseVolumeBoundaries(outline: string): Array<{ name: string; startCh: number; endCh: number }> {
    const volumes: Array<{ name: string; startCh: number; endCh: number }> = [];
    const lines = outline.split("\n");
    const volumeHeader = /^(第[一二三四五六七八九十百千万零〇\d]+卷|Volume\s+\d+)/i;
    // 范围:兼容 (1-30) / 第 1-30 章 / 范围：第 1-30 章 / Chapters 1-30 / Range: 1-30
    const rangePattern = /(?:范围|区间|range|scope)?\s*[：:]?\s*[（(]?\s*(?:第|[Cc]hapters?)?\s*(\d+)\s*[-–~～—]\s*(\d+)\s*(?:章)?\s*[）)]?/i;
    // 只有真正出现「数字-数字」才算范围行,避免把「第 1 章：退烧」这类候选名误判为范围
    const hasNumericRange = /\d+\s*[-–~～—]\s*\d+/;
    let pendingName: string | null = null;

    for (const rawLine of lines) {
      const line = rawLine.replace(/^[#>\-*\s]+/, "").trim();
      if (!line) continue;

      if (volumeHeader.test(line)) {
        // 形式一:范围与卷名同行
        if (hasNumericRange.test(line)) {
          const inline = line.match(rangePattern);
          const startCh = parseInt(inline?.[1] ?? "0", 10);
          const endCh = parseInt(inline?.[2] ?? "0", 10);
          if (startCh > 0 && endCh > 0) {
            const name = line.slice(0, inline?.index ?? line.length).replace(/[（(]\s*$/, "").trim();
            if (name.length > 0) {
              volumes.push({ name, startCh, endCh });
              pendingName = null;
              continue;
            }
          }
        }
        // 形式二:范围在后续行,先记下卷名
        pendingName = line;
        continue;
      }

      // 形式二的范围行(在卷名之后、下一卷名之前的第一条「数字-数字」行)
      if (pendingName && hasNumericRange.test(line)) {
        const match = line.match(rangePattern);
        const startCh = parseInt(match?.[1] ?? "0", 10);
        const endCh = parseInt(match?.[2] ?? "0", 10);
        if (startCh > 0 && endCh > 0) {
          volumes.push({ name: pendingName, startCh, endCh });
          pendingName = null;
        }
      }
    }
    return volumes;
  }

  private parseSummaryTable(raw: string): { header: string; rows: Array<{ chapter: number; raw: string }> } {
    const lines = raw.split("\n");
    const headerLines = lines.filter((l) => l.startsWith("|") && (l.includes("章节") || l.includes("Chapter") || l.includes("---")));
    const dataLines = lines.filter((l) => l.startsWith("|") && !l.includes("章节") && !l.includes("Chapter") && !l.includes("---"));

    const header = headerLines.join("\n");
    const rows = dataLines.map((line) => {
      const match = line.match(/\|\s*(\d+)\s*\|/);
      return { chapter: match ? parseInt(match[1]!, 10) : 0, raw: line };
    }).filter((r) => r.chapter > 0);

    return { header, rows };
  }
}
