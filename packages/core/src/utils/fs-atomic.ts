import { writeFile, rename, unlink } from "node:fs/promises";
import { join, dirname, basename } from "node:path";

let seq = 0;

/**
 * 原子写文件:先写同目录临时文件,再 rename 覆盖目标。
 *
 * rename 在同一文件系统上是原子操作 —— 写到一半崩溃 / 断电 / OOM / Ctrl-C 只会留下一个临时文件,
 * 目标文件要么保持旧的完整内容、要么变成新的完整内容,**绝不会被截断成半截**。
 *
 * 用于不可再生的章节正文、index.json、真相文件等关键写入,替换裸 writeFile。
 * 临时文件放在与目标同一目录(同一文件系统),保证 rename 真的原子;失败时清理临时文件。
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.tmp-${process.pid}-${++seq}`);
  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, filePath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      /* 临时文件清理失败忽略 —— 它不会污染目标文件 */
    }
    throw err;
  }
}
