// SaaS 上线前安全回归:① admin 白名单(HARDWRITE_ADMIN_EMAILS)拆掉"firstUser 自动提权"地雷;
// ② /billing/topup 鉴权——普通登录用户不能充值,x-admin-key 旁路必须等长常数时间比较。
// 与其它 SaaS 测试一样不 mock @juanshe/core,真实 StateManager + saas.json。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const projectConfig = {
  name: "sec-test",
  version: "0.1.0",
  language: "zh",
  llm: { provider: "openai", baseUrl: "https://api.example.com/v1", apiKey: "sk-seed", model: "m", temperature: 0.7, maxTokens: 4096, stream: false },
  modelOverrides: {},
  notify: [],
} as const;

type App = { request: (input: string | Request, init?: RequestInit) => Response | Promise<Response> };

function setCookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const m = raw.match(/hardwrite_saas_session=[^;]+/);
  return m ? m[0] : "";
}

async function register(app: App, email: string, password = "password-aaa") {
  const res = await app.request("http://localhost/api/v1/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { user?: { role: string; email: string }; error?: unknown };
  return { status: res.status, cookie: setCookie(res), user: body.user };
}

async function topup(app: App, opts: { cookie?: string; adminKey?: string; email: string; credits: number }) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  const res = await app.request("http://localhost/api/v1/billing/topup", {
    method: "POST",
    headers,
    body: JSON.stringify({ email: opts.email, credits: opts.credits }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { user?: { credits: number } } };
}

describe("SaaS 安全 · admin 白名单 + topup 鉴权", () => {
  let root: string;
  let app: App;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sec-"));
    await writeFile(join(root, "hardwrite.json"), JSON.stringify(projectConfig, null, 2), "utf-8");
    process.env.HARDWRITE_SAAS_MODE = "1";
    process.env.HARDWRITE_ACTIVATION_SECRET = "test-sec";
    delete process.env.HARDWRITE_SAAS_DATA_DIR;
    delete process.env.HARDWRITE_ADMIN_EMAILS;
    delete process.env.HARDWRITE_ADMIN_KEY;
    const { createStudioServer } = await import("./server.js");
    app = createStudioServer(projectConfig as never, root) as App;
  });

  afterEach(async () => {
    delete process.env.HARDWRITE_SAAS_MODE;
    delete process.env.HARDWRITE_ACTIVATION_SECRET;
    delete process.env.HARDWRITE_ADMIN_EMAILS;
    delete process.env.HARDWRITE_ADMIN_KEY;
    await rm(root, { recursive: true, force: true });
  });

  it("白名单内邮箱注册即 admin,名单外即 user", async () => {
    process.env.HARDWRITE_ADMIN_EMAILS = "boss@example.com";
    const boss = await register(app, "boss@example.com");
    const other = await register(app, "nobody@example.com");
    expect(boss.user?.role).toBe("admin");
    expect(other.user?.role).toBe("user");
  });

  it("配了白名单后,名单外即使第一个注册也只是 user(拆掉 firstUser 提权地雷)", async () => {
    process.env.HARDWRITE_ADMIN_EMAILS = "boss@example.com";
    const firstButNotListed = await register(app, "stranger@example.com");
    expect(firstButNotListed.status).toBe(200);
    expect(firstButNotListed.user?.role).toBe("user"); // ← 关键:抢先注册也夺不了 admin
  });

  it("无白名单时回退:首个注册者 admin,第二个 user", async () => {
    const a = await register(app, "a@example.com");
    const b = await register(app, "b@example.com");
    expect(a.user?.role).toBe("admin");
    expect(b.user?.role).toBe("user");
  });

  it("topup:普通登录用户不能充值(403)", async () => {
    await register(app, "admin@example.com"); // 首个 = admin
    const normal = await register(app, "normal@example.com"); // 普通用户
    const res = await topup(app, { cookie: normal.cookie, email: "normal@example.com", credits: 999 });
    expect(res.status).toBe(403);
  });

  it("topup:admin 可充值,额度入账", async () => {
    const admin = await register(app, "admin@example.com");
    await register(app, "normal@example.com");
    const res = await topup(app, { cookie: admin.cookie, email: "normal@example.com", credits: 500 });
    expect(res.status).toBe(200);
    expect(res.body.user?.credits).toBe(500); // 普通用户初始 0 + 500
  });

  it("topup:已登录普通用户带 x-admin-key 也不提权(403);无会话直接被全局中间件 401", async () => {
    process.env.HARDWRITE_ADMIN_KEY = "super-strong-admin-key-0123456789";
    await register(app, "admin@example.com"); // 首个 = admin
    const normal = await register(app, "normal@example.com");
    expect(normal.user?.role).toBe("user");
    // 已登录普通用户 + 正确 key → 仍 403(有会话就必须 role=admin,key 不旁路 → 堵死提权)
    const escalate = await topup(app, { cookie: normal.cookie, adminKey: "super-strong-admin-key-0123456789", email: "normal@example.com", credits: 100 });
    expect(escalate.status).toBe(403);
    // 无会话(无论带不带 key)→ 全局认证中间件先 401,根本到不了 handler
    const noSession = await topup(app, { adminKey: "super-strong-admin-key-0123456789", email: "normal@example.com", credits: 100 });
    expect(noSession.status).toBe(401);
  });

  it("建书固定子路由不被 requireBookAccess 当成 bookId 拦 404(Hono :id/* 会匹配 /create)", async () => {
    const admin = await register(app, "admin@example.com");
    // GET /books/create-states 只读、不调 LLM,与 POST /books/create 共用同一 requireBookAccess 中间件,
    // 作为"固定子路由放行"的安全代理:绝不能返回 BOOK_NOT_FOUND 404(否则 SaaS 下建书被整个拦死)。
    const res = await app.request("http://localhost/api/v1/books/create-states", { headers: { cookie: admin.cookie } });
    expect(res.status).not.toBe(404);
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
    expect(body?.error?.code).not.toBe("BOOK_NOT_FOUND");

    // 建书进度轮询 /books/:id/create-status:book.json 在 foundation 落库前还没写,
    // 必须能轮询,不能被 requireBookAccess 的存在性检查当成 BOOK_NOT_FOUND 拦死(用户实际踩到的 404)。
    const cs = await app.request("http://localhost/api/v1/books/some-creating-book/create-status", { headers: { cookie: admin.cookie } });
    const csBody = (await cs.json().catch(() => ({}))) as { error?: { code?: string } };
    expect(csBody?.error?.code).not.toBe("BOOK_NOT_FOUND");
  });
});
