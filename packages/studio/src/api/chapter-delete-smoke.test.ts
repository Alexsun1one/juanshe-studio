import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 章节删除路由的端到端冒烟:真实 StateManager(真 rollbackToChapter + 真备份),
// 只 mock LLM 客户端与调度器,防网络/后台任务。

const createLLMClientMock = vi.fn(() => ({}));
const logger = {
  child: () => logger,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("@juanshe/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@juanshe/core")>();
  class MockScheduler {
    constructor(_config: unknown) {}
    async start(): Promise<void> { /* noop */ }
    stop(): void { /* noop */ }
    get isRunning(): boolean { return false; }
  }
  class MockPipelineRunner {
    constructor(_config: unknown) {}
    initBook = vi.fn();
    runRadar = vi.fn();
  }
  return {
    ...actual,
    createLLMClient: createLLMClientMock,
    Scheduler: MockScheduler,
    PipelineRunner: MockPipelineRunner,
    createLogger: () => logger,
  };
});

const projectConfig = {
  name: "chapter-delete-smoke",
  version: "0.1.0",
  language: "zh" as const,
  llm: {
    provider: "openai",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    model: "gpt-5.4",
    temperature: 0.7,
    maxTokens: 4096,
    stream: false,
  },
  daemon: {
    schedule: { radarCron: "0 */6 * * *", writeCron: "*/15 * * * *" },
    maxConcurrentBooks: 1,
    chaptersPerCycle: 1,
    retryDelayMs: 30000,
    cooldownAfterChapterMs: 0,
    maxDailyChapters: 5,
  },
  notify: [],
};

let root = "";

async function seedBook(bookId: string) {
  const bookDir = join(root, "books", bookId);
  // 三章正文 + index.json + 第 2 章末的状态快照(rollbackToChapter(2) 的恢复源)
  const chaptersDir = join(bookDir, "chapters");
  await mkdir(chaptersDir, { recursive: true });
  for (const [num, title] of [[1, "起点"], [2, "转折"], [3, "失控"]] as const) {
    await writeFile(join(chaptersDir, `${String(num).padStart(3, "0")}_${title}.md`), `# 第${num}章 ${title}\n\n正文${num}`, "utf-8");
  }
  await writeFile(join(chaptersDir, "index.json"), JSON.stringify([
    { number: 1, title: "起点", status: "done", wordCount: 100 },
    { number: 2, title: "转折", status: "done", wordCount: 100 },
    { number: 3, title: "失控", status: "done", wordCount: 100 },
  ]), "utf-8");
  const snap2 = join(bookDir, "story", "snapshots", "2");
  await mkdir(snap2, { recursive: true });
  await writeFile(join(snap2, "current_state.md"), "状态截至第2章末", "utf-8");
  await writeFile(join(snap2, "pending_hooks.md"), "钩子账本截至第2章", "utf-8");
  await writeFile(join(bookDir, "book.json"), JSON.stringify({ id: bookId, title: "删除测试书", genre: "xuanhuan", targetChapters: 10 }), "utf-8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chapter-delete-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelayMs: 150 });
});

describe("DELETE /api/v1/books/:id/chapters/:num", () => {
  it("删除第3章(尾部):200 + discarded=[3] + 正文进 backups + 快照恢复到第2章末", async () => {
    await seedBook("del-book");
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(projectConfig as never, root);

    const res = await app.request("http://localhost/api/v1/books/del-book/chapters/3", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; discarded: number[]; rolledBackTo: number };
    expect(body.ok).toBe(true);
    expect(body.discarded).toEqual([3]);
    expect(body.rolledBackTo).toBe(2);

    // 章节文件与索引:第3章消失,剩 1/2
    const files = await readdir(join(root, "books", "del-book", "chapters"));
    expect(files.filter((f) => f.endsWith(".md")).sort()).toEqual(["001_起点.md", "002_转折.md"]);
    const index = JSON.parse(await readFile(join(root, "books", "del-book", "chapters", "index.json"), "utf-8")) as Array<{ number: number }>;
    expect(index.map((e) => e.number)).toEqual([1, 2]);

    // 原稿已备份到 backups/(可找回)
    const backupRoot = join(root, "books", "del-book", "backups");
    const backupDirs = await readdir(backupRoot);
    expect(backupDirs.some((d) => d.startsWith("pre-rollback-"))).toBe(true);
    const backupChapters = await readdir(join(backupRoot, backupDirs.find((d) => d.startsWith("pre-rollback-"))!, "chapters"));
    expect(backupChapters).toContain("003_失控.md");

    // 引擎状态已恢复到第 2 章末快照
    const state = await readFile(join(root, "books", "del-book", "story", "current_state.md"), "utf-8");
    expect(state).toBe("状态截至第2章末");
  });

  it("第1章不可删(409)", async () => {
    await seedBook("del-book");
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(projectConfig as never, root);
    const res = await app.request("http://localhost/api/v1/books/del-book/chapters/1", { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("cannot_delete_first_chapter");
  });

  it("不存在的章(404)", async () => {
    await seedBook("del-book");
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(projectConfig as never, root);
    const res = await app.request("http://localhost/api/v1/books/del-book/chapters/99", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("无效章号(400)", async () => {
    await seedBook("del-book");
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(projectConfig as never, root);
    const res = await app.request("http://localhost/api/v1/books/del-book/chapters/0", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("缺快照的书删除返回 409 snapshot_missing 而非 500", async () => {
    await seedBook("del-book");
    // 把第 2 章快照删掉 → rollbackToChapter(2) 的 restoreState 失败
    await rm(join(root, "books", "del-book", "story", "snapshots", "2"), { recursive: true, force: true });
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(projectConfig as never, root);
    const res = await app.request("http://localhost/api/v1/books/del-book/chapters/3", { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("snapshot_missing");
    // 原稿原封不动
    const files = await readdir(join(root, "books", "del-book", "chapters"));
    expect(files.filter((f) => f.endsWith(".md")).length).toBe(3);
  });
});
