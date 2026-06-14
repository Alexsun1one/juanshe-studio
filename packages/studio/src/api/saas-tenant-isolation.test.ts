// SaaS 多租户隔离内核测试。
//
// 关键:本文件**不 mock @juanshe/core** —— 它要验证真实的 StateManager / loadSecrets /
// loadProjectConfig 在租户物理目录(.saas/tenants/{tid}/books)下的隔离效果,mock 掉就失去意义。
// (server.test.ts 里那套全量 core mock 只在那个文件内生效,vi.mock 不跨文件泄漏。)
//
// 覆盖锁定架构的隔离断言:
//   - 注册租户 A、B,各自拿到独立 session cookie + tenantId;
//   - A 建书(直接落盘到 A 的租户 books/,不触发真实 LLM 写作)→ B 的列表看不到;
//   - B 直接打 A 的 bookId per-book 路由 → 404(requireBookAccess + state 租户化);
//   - A、B 的 secrets 互不可见(各租户 .saas/tenants/{tid}/.autow/secrets.json);
//   - 桌面模式(SaaS off)冒烟:行为不变,不需要登录、无租户隔离层。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const projectConfig = {
  name: "saas-isolation-test",
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
  // 取 hardwrite_saas_session=...; 的第一段
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

// 直接在租户的物理 books/ 目录里落一本"已建好的书",绕开真实 LLM 建书流水线。
async function seedBookForTenant(root: string, tenantId: string, bookId: string, title: string): Promise<void> {
  const bookDir = join(root, ".saas", "tenants", tenantId, "books", bookId);
  await mkdir(bookDir, { recursive: true });
  await writeFile(
    join(bookDir, "book.json"),
    JSON.stringify({ id: bookId, title, language: "zh" }, null, 2),
    "utf-8",
  );
}

describe("SaaS multi-tenant isolation kernel", () => {
  let root: string;
  let app: App;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "saas-isolation-"));
    await writeFile(join(root, "hardwrite.json"), JSON.stringify(projectConfig, null, 2), "utf-8");
    process.env.HARDWRITE_SAAS_MODE = "1";
    // 隔离 SaaS 数据目录到当前临时 root,避免落到默认全局路径污染别的测试。
    delete process.env.HARDWRITE_SAAS_DATA_DIR;
    const { createStudioServer } = await import("./server.js");
    app = createStudioServer(projectConfig as never, root) as App;
  });

  afterEach(async () => {
    delete process.env.HARDWRITE_SAAS_MODE;
    await rm(root, { recursive: true, force: true });
  });

  it("registers two tenants with distinct cookies and tenant ids", async () => {
    const a = await register(app, "alice@example.com", "password-aaa");
    const b = await register(app, "bob@example.com", "password-bbb");
    expect(a.cookie).toBeTruthy();
    expect(b.cookie).toBeTruthy();
    expect(a.cookie).not.toBe(b.cookie);
    expect(a.tenantId).not.toBe(b.tenantId);
  });

  it("tenant B's book list does NOT contain tenant A's book", async () => {
    const a = await register(app, "alice@example.com", "password-aaa");
    const b = await register(app, "bob@example.com", "password-bbb");
    await seedBookForTenant(root, a.tenantId, "alice-secret-novel", "爱丽丝的秘密小说");

    const aList = await app.request("http://localhost/api/v1/books", { headers: { cookie: a.cookie } });
    expect(aList.status).toBe(200);
    const aBody = (await aList.json()) as { books: Array<{ id: string }> };
    expect(aBody.books.map((book) => book.id)).toContain("alice-secret-novel");

    const bList = await app.request("http://localhost/api/v1/books", { headers: { cookie: b.cookie } });
    expect(bList.status).toBe(200);
    const bBody = (await bList.json()) as { books: Array<{ id: string }> };
    expect(bBody.books.map((book) => book.id)).not.toContain("alice-secret-novel");
    expect(bBody.books).toHaveLength(0);
  });

  it("tenant B hitting tenant A's per-book route gets 404 (requireBookAccess + state isolation)", async () => {
    const a = await register(app, "alice@example.com", "password-aaa");
    const b = await register(app, "bob@example.com", "password-bbb");
    await seedBookForTenant(root, a.tenantId, "alice-secret-novel", "爱丽丝的秘密小说");

    // A 能读自己的书(bare /:id 路由)。
    const aRead = await app.request("http://localhost/api/v1/books/alice-secret-novel", {
      headers: { cookie: a.cookie },
    });
    expect(aRead.status).toBe(200);

    // B 打 A 的 bookId 的 per-book 子路由 → 404(被 requireBookAccess 拦)。
    const bChapters = await app.request("http://localhost/api/v1/books/alice-secret-novel/chapters", {
      headers: { cookie: b.cookie },
    });
    expect(bChapters.status).toBe(404);

    // B 打 A 的 bookId 的 bare /:id 路由 → 也 404(state 已租户化,在 B 的根下找不到)。
    const bRead = await app.request("http://localhost/api/v1/books/alice-secret-novel", {
      headers: { cookie: b.cookie },
    });
    expect(bRead.status).toBe(404);
  });

  it("unauthenticated per-book request is rejected (not silently served from global root)", async () => {
    const res = await app.request("http://localhost/api/v1/books/some-book/chapters");
    expect(res.status).toBe(401);
  });

  it("premium route returns 402 (without running handler/LLM) when tenant has insufficient credits", async () => {
    // 第二个注册的用户默认 0 额度;打 premium 路由(radar/scan = 3 点)应在中间件层被 402 拦,
    // 不进入 handler、不触发任何 LLM 调用。
    await register(app, "alice@example.com", "password-aaa"); // 首个用户=admin,拿初始额度
    const b = await register(app, "bob@example.com", "password-bbb"); // 第二个=0 额度
    const res = await app.request("http://localhost/api/v1/radar/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: b.cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string }; requiredCredits: number };
    expect(body.error.code).toBe("PAYMENT_REQUIRED");
    expect(body.requiredCredits).toBe(3);
  });

  it("secrets are isolated per tenant — B cannot see A's API key", async () => {
    const a = await register(app, "alice@example.com", "password-aaa");
    const b = await register(app, "bob@example.com", "password-bbb");

    // A 写入一把 moonshot key。
    const putA = await app.request("http://localhost/api/v1/services/moonshot/secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie: a.cookie },
      body: JSON.stringify({ apiKey: "sk-alice-moonshot-xyz" }),
    });
    expect(putA.status).toBe(200);

    // A 自己能看到"已配置"。
    const getA = await app.request("http://localhost/api/v1/services/moonshot/secret", {
      headers: { cookie: a.cookie },
    });
    const aSecret = (await getA.json()) as { hasKey: boolean; masked: string };
    expect(aSecret.hasKey).toBe(true);
    expect(aSecret.masked).toContain("xyz");

    // B 看同一个 service → 未配置(看不到 A 的 key)。
    const getB = await app.request("http://localhost/api/v1/services/moonshot/secret", {
      headers: { cookie: b.cookie },
    });
    const bSecret = (await getB.json()) as { hasKey: boolean; masked: string };
    expect(bSecret.hasKey).toBe(false);
    expect(bSecret.masked).toBe("");

    // 物理验证:A 的 key 落在 A 的租户目录,B 的目录里没有这把 key。
    const aSecretsFile = join(root, ".saas", "tenants", a.tenantId, ".autow", "secrets.json");
    await expect(access(aSecretsFile)).resolves.toBeUndefined();
    const bSecretsFile = join(root, ".saas", "tenants", b.tenantId, ".autow", "secrets.json");
    // B 从没写过 → 文件不存在。
    await expect(access(bSecretsFile)).rejects.toBeTruthy();
  });

  // ── 回归:对抗验证「串户猎手」抓到、修复 agent 谎报未补、主会话手补的三个 leak ──
  it("content-drafts are isolated — B cannot list or read A's generated drafts", async () => {
    const a = await register(app, "alice@example.com", "password-aaa");
    const b = await register(app, "bob@example.com", "password-bbb");

    // 直接在 A 的租户 content-drafts 里种一篇成品(绕开触发 LLM 的 write 流程)。
    const aDraftDir = join(root, ".saas", "tenants", a.tenantId, "content-drafts", "wechat_article");
    await mkdir(aDraftDir, { recursive: true });
    await writeFile(join(aDraftDir, "2026-01-01T00-00-00.md"), "# 爱丽丝的机密商业计划\n\n绝密正文。", "utf-8");

    const aList = await app.request("http://localhost/api/v1/content-drafts", { headers: { cookie: a.cookie } });
    const aBody = (await aList.json()) as { drafts: unknown[] };
    expect(aBody.drafts.length).toBe(1);

    const bList = await app.request("http://localhost/api/v1/content-drafts", { headers: { cookie: b.cookie } });
    const bBody = (await bList.json()) as { drafts: unknown[] };
    expect(bBody.drafts.length).toBe(0); // B 看不到 A 的成品(此前读全局 root → 能看到全文)
  });

  it("custom genres are isolated — B's genre list does not contain A's self-authored genre", async () => {
    const a = await register(app, "alice@example.com", "password-aaa");
    const b = await register(app, "bob@example.com", "password-bbb");

    // 在 A 的租户 genres 里种一个自建类型。
    const aGenresDir = join(root, ".saas", "tenants", a.tenantId, "genres");
    await mkdir(aGenresDir, { recursive: true });
    await writeFile(
      join(aGenresDir, "alice-secret-genre.md"),
      '---\nname: 爱丽丝私房题材\nid: alice-secret-genre\nchapterTypes: ["开篇"]\nfatigueWords: ["仿佛"]\n---\n专有写作规则。',
      "utf-8",
    );

    const aGenres = await app.request("http://localhost/api/v1/genres", { headers: { cookie: a.cookie } });
    const aIds = ((await aGenres.json()) as { genres: Array<{ id: string }> }).genres.map((g) => g.id);
    expect(aIds).toContain("alice-secret-genre");

    const bGenres = await app.request("http://localhost/api/v1/genres", { headers: { cookie: b.cookie } });
    const bIds = ((await bGenres.json()) as { genres: Array<{ id: string }> }).genres.map((g) => g.id);
    expect(bIds).not.toContain("alice-secret-genre"); // B 看不到 A 自建类型(此前读全局 root → 串户)
  });
});

describe("Desktop mode (SaaS off) smoke — behavior unchanged", () => {
  let root: string;
  let app: App;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "desktop-smoke-"));
    await writeFile(join(root, "hardwrite.json"), JSON.stringify(projectConfig, null, 2), "utf-8");
    delete process.env.HARDWRITE_SAAS_MODE;
    const { createStudioServer } = await import("./server.js");
    app = createStudioServer(projectConfig as never, root) as App;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("no auth required: /api/v1/books is reachable without a session", async () => {
    const res = await app.request("http://localhost/api/v1/books");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { books: unknown[] };
    expect(Array.isArray(body.books)).toBe(true);
  });

  it("auth/me reports saas:false in desktop mode", async () => {
    const res = await app.request("http://localhost/api/v1/auth/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saas: boolean; authenticated: boolean };
    expect(body.saas).toBe(false);
    expect(body.authenticated).toBe(true);
  });

  it("books land in the flat global books/ dir (no tenant layer)", async () => {
    const bookDir = join(root, "books", "desktop-book");
    await mkdir(bookDir, { recursive: true });
    await writeFile(join(bookDir, "book.json"), JSON.stringify({ id: "desktop-book", title: "桌面书" }), "utf-8");
    const res = await app.request("http://localhost/api/v1/books", { headers: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { books: Array<{ id: string }> };
    expect(body.books.map((book) => book.id)).toContain("desktop-book");
  });
});
