// 导出全部书稿(整本目录打包 zip · 数据可携带)测试。
//
// 与 streak.test.ts / saas-tenant-isolation.test.ts 一样**不 mock @juanshe/core** ——
// 它要验证真实 StateManager 在(租户 / 桌面)物理目录把 books/<id>/ 整本目录打进 zip 的效果。
// 重点是安全边界:**租户隔离**(A 的 zip 绝不含 B 的书)。
// zip 条目文件名在本地文件头里是明文 UTF-8(只有正文被 deflate 压缩),所以可直接在 buffer 里搜目录名断言存在/缺席。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const projectConfig = {
  name: "export-test",
  version: "0.1.0",
  language: "zh",
  llm: {
    provider: "openai",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-platform-seed",
    model: "gpt-test",
    temperature: 0.7,
    maxTokens: 4096,
    stream: false,
  },
  modelOverrides: {},
  notify: [],
} as const;

// 与 server.ts 的 tenantIdForEmail 一致,用来定位租户物理目录。
function tenantIdForEmail(email: string): string {
  return `tenant_${createHash("sha256").update(email).digest("hex").slice(0, 18)}`;
}

function setCookie(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  const match = raw.match(/hardwrite_saas_session=[^;]+/);
  return match ? match[0] : "";
}

type App = { request: (input: string | Request, init?: RequestInit) => Response | Promise<Response> };

async function register(app: App, email: string, password: string): Promise<{ cookie: string; tenantId: string }> {
  const res = await app.request("http://localhost/api/v1/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return { cookie: setCookie(res), tenantId: tenantIdForEmail(email) };
}

// 在 books/<bookId>/ 落一本最小但完整的书(book.json + 一章正文 + index.json),绕开真实 LLM 写作。
async function seedBook(booksRoot: string, bookId: string, title: string): Promise<void> {
  const bookDir = join(booksRoot, bookId);
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await writeFile(
    join(bookDir, "book.json"),
    JSON.stringify({ id: bookId, title, language: "zh" }, null, 2),
    "utf-8",
  );
  await writeFile(join(bookDir, "chapters", "0001_first.md"), `# ${title}\n\n这是第一章的正文内容。`, "utf-8");
  const now = new Date().toISOString();
  await writeFile(
    join(bookDir, "chapters", "index.json"),
    JSON.stringify([{ number: 1, title: "第 1 章", status: "approved", wordCount: 100, createdAt: now, updatedAt: now }], null, 2),
    "utf-8",
  );
}

function desktopBooksRoot(root: string): string {
  return join(root, "books");
}
function tenantBooksRoot(root: string, tenantId: string): string {
  return join(root, ".saas", "tenants", tenantId, "books");
}

async function exportAll(app: App, cookie?: string): Promise<Response> {
  return app.request("http://localhost/api/v1/export/books", {
    headers: cookie ? { cookie } : {},
  });
}

async function zipBuffer(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

// ──────────────────────────────────────────────────────────────────────────
// SaaS 模式
// ──────────────────────────────────────────────────────────────────────────
describe("Export all books (zip) — SaaS mode", () => {
  let root: string;
  let app: App;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "export-saas-"));
    await writeFile(join(root, "hardwrite.json"), JSON.stringify(projectConfig, null, 2), "utf-8");
    process.env.HARDWRITE_SAAS_MODE = "1";
    process.env.HARDWRITE_ACTIVATION_SECRET = "test-export-secret";
    delete process.env.HARDWRITE_SAAS_DATA_DIR;
    const { createStudioServer } = await import("./server.js");
    app = createStudioServer(projectConfig as never, root) as App;
  });

  afterEach(async () => {
    delete process.env.HARDWRITE_SAAS_MODE;
    delete process.env.HARDWRITE_ACTIVATION_SECRET;
    await rm(root, { recursive: true, force: true });
  });

  it("requires login (401 without cookie)", async () => {
    const res = await exportAll(app);
    expect(res.status).toBe(401);
  });

  it("404 when the user has no books", async () => {
    const a = await register(app, "alice@example.com", "password-aaa");
    const res = await exportAll(app, a.cookie);
    expect(res.status).toBe(404);
  });

  it("returns a zip (PK magic + content-disposition) for a user with books", async () => {
    const a = await register(app, "alice@example.com", "password-aaa");
    await seedBook(tenantBooksRoot(root, a.tenantId), "alpha-book", "晨光");

    const res = await exportAll(app, a.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    expect(res.headers.get("content-disposition")).toContain(".zip");

    const buf = await zipBuffer(res);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK"); // zip 魔数 PK\x03\x04
    expect(buf.includes(Buffer.from("alpha-book/"))).toBe(true);
    expect(buf.includes(Buffer.from("book.json"))).toBe(true);
  });

  it("tenant isolation — A's export NEVER contains B's books", async () => {
    const a = await register(app, "alice@example.com", "password-aaa");
    const b = await register(app, "bob@example.com", "password-bbb");
    await seedBook(tenantBooksRoot(root, a.tenantId), "alpha-book", "晨光");
    await seedBook(tenantBooksRoot(root, b.tenantId), "beta-book", "夜航");

    const bufA = await zipBuffer(await exportAll(app, a.cookie));
    expect(bufA.includes(Buffer.from("alpha-book/"))).toBe(true);
    expect(bufA.includes(Buffer.from("beta-book/"))).toBe(false); // ← 安全边界:绝不含别租户的书

    const bufB = await zipBuffer(await exportAll(app, b.cookie));
    expect(bufB.includes(Buffer.from("beta-book/"))).toBe(true);
    expect(bufB.includes(Buffer.from("alpha-book/"))).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 桌面模式(无 SaaS,无登录,导出当前工作区)
// ──────────────────────────────────────────────────────────────────────────
describe("Export all books (zip) — desktop mode", () => {
  let root: string;
  let app: App;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "export-desktop-"));
    await writeFile(join(root, "hardwrite.json"), JSON.stringify(projectConfig, null, 2), "utf-8");
    delete process.env.HARDWRITE_SAAS_MODE;
    const { createStudioServer } = await import("./server.js");
    app = createStudioServer(projectConfig as never, root) as App;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("exports the local workspace books without any login", async () => {
    await seedBook(desktopBooksRoot(root), "local-book", "本地书");
    const res = await exportAll(app); // 桌面无鉴权门
    expect(res.status).toBe(200);
    const buf = await zipBuffer(res);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(buf.includes(Buffer.from("local-book/"))).toBe(true);
  });
});
