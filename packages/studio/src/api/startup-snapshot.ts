/**
 * 启动时自动快照 —— 防止"强停+重启"类操作把书籍真相文件
 * (`chapters/index.json` / `current_state.md` / `pending_hooks.md` /
 * `chapter_summaries.md`) 在飞行中写截断造成状态回归。
 *
 * 设计契约（与 handoff §18/§20 一致）：
 * - 纯加法：只在 `<workspace>/books/<bookId>/backups/auto-snapshots/<YYYYMMDD-HHMMSS>/`
 *   下创建新文件，绝不修改/删除任何 live 文件。
 * - 防截断：当 critical 文件字节数过小（疑似已被写截断）时**跳过那一次**，
 *   避免把损坏版当做"备份"覆盖更早的好版。
 * - 滚动保留：默认保留每本书最近 14 份快照，更旧的归档自动清理（仅清自己创建的
 *   `auto-snapshots/`，绝不动 user-created backups）。
 * - 失败不阻断启动：任何 IO/解析错误都吞掉，只走 console.warn。
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

const TRUTH_FILES: Array<{ rel: string; minBytes: number }> = [
  { rel: "chapters/index.json", minBytes: 200 },
  { rel: "story/chapter_summaries.md", minBytes: 200 },
  { rel: "story/current_state.md", minBytes: 80 },
  { rel: "story/pending_hooks.md", minBytes: 80 },
];

const KEEP = 14;

function stamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

async function safeStat(p: string): Promise<number | null> {
  try {
    const s = await fs.stat(p);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

async function snapshotOneBook(bookDir: string): Promise<{
  bookDir: string;
  copied: number;
  skipped: string[];
  dest?: string;
}> {
  const skipped: string[] = [];
  const candidates: Array<{ src: string; rel: string }> = [];
  for (const { rel, minBytes } of TRUTH_FILES) {
    const src = join(bookDir, rel);
    const size = await safeStat(src);
    if (size === null) {
      skipped.push(`${rel}: 不存在`);
      continue;
    }
    if (size < minBytes) {
      // 疑似截断 —— 跳过，保留之前的好快照
      skipped.push(`${rel}: 仅 ${size}B 疑似截断（已跳过）`);
      continue;
    }
    candidates.push({ src, rel });
  }
  if (candidates.length === 0) return { bookDir, copied: 0, skipped };

  const dest = join(bookDir, "backups", "auto-snapshots", stamp());
  await fs.mkdir(dest, { recursive: true });
  let copied = 0;
  for (const { src, rel } of candidates) {
    const target = join(dest, rel.replace(/[\\/]/g, "_"));
    try {
      await fs.copyFile(src, target);
      copied++;
    } catch (e) {
      skipped.push(`${rel}: copy 失败 ${(e as Error).message}`);
    }
  }

  // 滚动清理：仅清 auto-snapshots/ 下自己创建的目录，永远不动其它备份
  try {
    const parent = join(bookDir, "backups", "auto-snapshots");
    const entries = (await fs.readdir(parent, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^\d{8}-\d{6}$/.test(d.name))
      .map((d) => d.name)
      .sort();
    const drop = entries.slice(0, Math.max(0, entries.length - KEEP));
    for (const name of drop) {
      try {
        await fs.rm(join(parent, name), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  return { bookDir, copied, skipped, dest };
}

export async function runStartupSnapshot(workspaceRoot: string): Promise<void> {
  try {
    const booksRoot = join(workspaceRoot, "books");
    const stat = await fs.stat(booksRoot).catch(() => null);
    if (!stat?.isDirectory()) return;

    const entries = await fs.readdir(booksRoot, { withFileTypes: true });
    const bookDirs = entries
      .filter((d) => d.isDirectory())
      .map((d) => join(booksRoot, d.name));

    const results = await Promise.all(bookDirs.map(snapshotOneBook));
    const totalCopied = results.reduce((s, r) => s + r.copied, 0);
    const skippedBooks = results
      .filter((r) => r.skipped.length > 0)
      .map((r) => `${r.bookDir.split("/").pop()}: ${r.skipped.join("；")}`);

    if (totalCopied > 0) {
      console.log(
        `[startup-snapshot] 已为 ${results.filter((r) => r.copied > 0).length} 本书写入快照，共复制 ${totalCopied} 个真相文件`,
      );
    }
    if (skippedBooks.length > 0) {
      console.warn(
        `[startup-snapshot] 跳过项（疑似截断或缺失，保留更早的好快照）：${skippedBooks.join(" | ")}`,
      );
    }
  } catch (e) {
    console.warn(`[startup-snapshot] 跳过：${(e as Error).message}`);
  }
}
