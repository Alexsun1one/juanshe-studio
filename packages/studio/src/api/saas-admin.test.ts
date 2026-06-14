// 管理后台 + 发码注册表测试。
//
// 与 saas-tenant-isolation.test.ts 同样**不 mock @juanshe/core** —— 走真实 StateManager/磁盘,
// 验证 admin 门禁、概览/用户管理真数据、发码→列出→activate(限时/吊销/过期)闭环、调额度进 ledger,
// 以及桌面模式(SaaS off)下 /api/v1/admin/* 一律 404(不挂载语义)。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const projectConfig = {
  name: "saas-admin-test",
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

function tenantIdForEmail(email: string): string {
  return `tenant_${createHash("sha256").update(email).digest("hex").slice(0, 18)}`;
}

function setCookie(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  const match = raw.match(/hardwrite_saas_session=[^;]+/);
  return match ? match[0] : "";
}

type App = { request: (input: string | Request, init?: RequestInit) => Response | Promise<Response> };

async function register(app: App, email: string, password: string): Promise<{ cookie: string; userId: string; tenantId: string }> {
  const res = await app.request("http://localhost/api/v1/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: setCookie(res), userId: body.user.id, tenantId: tenantIdForEmail(email) };
}

async function seedBookForTenant(root: string, tenantId: string, bookId: string, title: string): Promise<void> {
  const bookDir = join(root, ".saas", "tenants", tenantId, "books", bookId);
  await mkdir(bookDir, { recursive: true });
  await writeFile(join(bookDir, "book.json"), JSON.stringify({ id: bookId, title, language: "zh" }, null, 2), "utf-8");
}

describe("SaaS admin console + code registry", () => {
  let root: string;
  let app: App;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "saas-admin-"));
    await writeFile(join(root, "hardwrite.json"), JSON.stringify(projectConfig, null, 2), "utf-8");
    process.env.HARDWRITE_SAAS_MODE = "1";
    process.env.HARDWRITE_ACTIVATION_SECRET = "test-admin-secret";
    delete process.env.HARDWRITE_SAAS_DATA_DIR;
    const { createStudioServer } = await import("./server.js");
    app = createStudioServer(projectConfig as never, root) as App;
  });

  afterEach(async () => {
    delete process.env.HARDWRITE_SAAS_MODE;
    delete process.env.HARDWRITE_ACTIVATION_SECRET;
    await rm(root, { recursive: true, force: true });
  });

  // ── admin 门禁 ──────────────────────────────────────────────────────────
  it("rejects unauthenticated admin request with 401", async () => {
    const res = await app.request("http://localhost/api/v1/admin/overview");
    expect(res.status).toBe(401);
  });

  it("rejects normal tenant hitting admin routes with 403", async () => {
    await register(app, "admin@example.com", "password-admin"); // 首注=admin
    const normal = await register(app, "normal@example.com", "password-normal");
    const res = await app.request("http://localhost/api/v1/admin/overview", {
      headers: { cookie: normal.cookie },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("allows the first (admin) user to reach admin routes", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const res = await app.request("http://localhost/api/v1/admin/overview", {
      headers: { cookie: admin.cookie },
    });
    expect(res.status).toBe(200);
  });

  // ── 概览真数据 ──────────────────────────────────────────────────────────
  it("overview reports real counts (users, tiers, books, signups, credits)", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const normal = await register(app, "normal@example.com", "password-normal");
    await seedBookForTenant(root, admin.tenantId, "admin-book", "管理员的书");
    await seedBookForTenant(root, normal.tenantId, "normal-book", "普通用户的书");

    const res = await app.request("http://localhost/api/v1/admin/overview", {
      headers: { cookie: admin.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalUsers: number;
      tierDistribution: Record<string, number>;
      totalBooks: number;
      recentSignups: number;
      creditsGranted: number;
      creditsConsumed: number;
      activeWritingJobs: number;
    };
    expect(body.totalUsers).toBe(2);
    expect(body.totalBooks).toBe(2);
    expect(body.recentSignups).toBe(2);
    expect(body.tierDistribution.normal).toBe(2);
    expect(body.creditsGranted).toBeGreaterThanOrEqual(200); // 首个 admin 初始 200
    expect(body.activeWritingJobs).toBe(0);
  });

  // ── 用户管理 ────────────────────────────────────────────────────────────
  it("lists users with pagination + book count + last active", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    await register(app, "normal@example.com", "password-normal");
    await seedBookForTenant(root, admin.tenantId, "admin-book", "管理员的书");

    const res = await app.request("http://localhost/api/v1/admin/users?page=1&pageSize=10", {
      headers: { cookie: admin.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      users: Array<{ id: string; email: string; tier: string; bookCount: number; lastActiveAt: string | null }>;
      total: number;
      page: number;
    };
    expect(body.total).toBe(2);
    const adminRow = body.users.find((u) => u.email === "admin@example.com");
    expect(adminRow).toBeTruthy();
    expect(adminRow!.bookCount).toBe(1);
    expect(adminRow!.lastActiveAt).toBeTruthy();
  });

  it("adjusts user credits and records an admin-adjust ledger entry", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const normal = await register(app, "normal@example.com", "password-normal");

    const res = await app.request(`http://localhost/api/v1/admin/users/${normal.userId}/credits`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ delta: 150, reason: "试用赠送" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { credits: number } };
    expect(body.user.credits).toBe(150);

    const saas = JSON.parse(await readFile(join(root, ".saas", "saas.json"), "utf-8")) as {
      ledger: Array<{ userId: string; reason: string; credits: number }>;
    };
    const entry = saas.ledger.find((l) => l.userId === normal.userId && l.reason === "admin-adjust");
    expect(entry).toBeTruthy();
    expect(entry!.credits).toBe(150);
  });

  it("credit adjustment never drives balance below zero", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const normal = await register(app, "normal@example.com", "password-normal"); // 0 credits

    const res = await app.request(`http://localhost/api/v1/admin/users/${normal.userId}/credits`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ delta: -999 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { credits: number } };
    expect(body.user.credits).toBe(0);
  });

  it("changes user tier", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const normal = await register(app, "normal@example.com", "password-normal");

    const res = await app.request(`http://localhost/api/v1/admin/users/${normal.userId}/tier`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ tier: "pro" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { tier: string } };
    expect(body.user.tier).toBe("pro");
  });

  // ── 发码注册表闭环 ────────────────────────────────────────────────────────
  it("mints a code, lists it, and activate redeems it to set tier", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const normal = await register(app, "normal@example.com", "password-normal");

    const mint = await app.request("http://localhost/api/v1/admin/codes", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ tier: "pro" }),
    });
    expect(mint.status).toBe(200);
    const mintBody = (await mint.json()) as { code: string; status: string };
    expect(mintBody.code).toMatch(/^JUAN-/);
    expect(mintBody.status).toBe("valid");

    const list = await app.request("http://localhost/api/v1/admin/codes", { headers: { cookie: admin.cookie } });
    const listBody = (await list.json()) as { codes: Array<{ code: string; status: string; tier: string }> };
    expect(listBody.codes.some((c) => c.code === mintBody.code && c.tier === "pro")).toBe(true);

    // normal 用户用这个码激活 → tier 升 pro。
    const act = await app.request("http://localhost/api/v1/auth/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: normal.cookie },
      body: JSON.stringify({ code: mintBody.code }),
    });
    expect(act.status).toBe(200);
    const actBody = (await act.json()) as { user: { tier: string }; grantedCredits: number };
    expect(actBody.user.tier).toBe("pro");

    // 列表里该码状态变为 used。
    const list2 = await app.request("http://localhost/api/v1/admin/codes", { headers: { cookie: admin.cookie } });
    const list2Body = (await list2.json()) as { codes: Array<{ code: string; status: string; issuedTo: string | null }> };
    const used = list2Body.codes.find((c) => c.code === mintBody.code);
    expect(used!.status).toBe("used");
    expect(used!.issuedTo).toBe("normal@example.com");
  });

  it("registry code is single-use — cannot upgrade a second account (no infinite reuse)", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const first = await register(app, "first@example.com", "password-first");
    const second = await register(app, "second@example.com", "password-second");

    const mint = await app.request("http://localhost/api/v1/admin/codes", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ tier: "pro" }),
    });
    const code = ((await mint.json()) as { code: string }).code;

    // 第一个账号激活成功 → pro。
    const act1 = await app.request("http://localhost/api/v1/auth/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: first.cookie },
      body: JSON.stringify({ code }),
    });
    expect(act1.status).toBe(200);
    expect(((await act1.json()) as { user: { tier: string } }).user.tier).toBe("pro");

    // 第二个账号用同一张码 → 必须被拒(ACTIVATION_ALREADY_USED),不得升级、不得重领赠额。
    const act2 = await app.request("http://localhost/api/v1/auth/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: second.cookie },
      body: JSON.stringify({ code }),
    });
    expect(act2.status).toBe(403);
    expect(((await act2.json()) as { error: { code: string } }).error.code).toBe("ACTIVATION_ALREADY_USED");

    // 第二个账号仍是 normal。
    const me2 = await app.request("http://localhost/api/v1/auth/me", { headers: { cookie: second.cookie } });
    expect(((await me2.json()) as { user: { tier: string } }).user.tier).toBe("normal");
  });

  it("revoked code is rejected on activate", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const normal = await register(app, "normal@example.com", "password-normal");

    const mint = await app.request("http://localhost/api/v1/admin/codes", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ tier: "ultra" }),
    });
    const mintBody = (await mint.json()) as { code: string };

    const revoke = await app.request(`http://localhost/api/v1/admin/codes/${encodeURIComponent(mintBody.code)}/revoke`, {
      method: "POST",
      headers: { cookie: admin.cookie },
    });
    expect(revoke.status).toBe(200);

    const act = await app.request("http://localhost/api/v1/auth/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: normal.cookie },
      body: JSON.stringify({ code: mintBody.code }),
    });
    expect(act.status).toBe(403);
    const actBody = (await act.json()) as { error: { code: string } };
    expect(actBody.error.code).toBe("ACTIVATION_REVOKED");
  });

  it("expired (limited-time) code is rejected on activate", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const normal = await register(app, "normal@example.com", "password-normal");

    const mint = await app.request("http://localhost/api/v1/admin/codes", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ tier: "pro", expiresInDays: 7 }),
    });
    const mintBody = (await mint.json()) as { code: string };

    // 直接把注册表里这条码的 expiresAt 改到过去,模拟过期。
    const codesFile = join(root, ".saas", "codes.json");
    const codesStore = JSON.parse(await readFile(codesFile, "utf-8")) as {
      codes: Array<{ codeFormatted: string; expiresAt: string | null }>;
    };
    const target = codesStore.codes.find((c) => c.codeFormatted === mintBody.code);
    target!.expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(codesFile, JSON.stringify(codesStore, null, 2), "utf-8");

    const act = await app.request("http://localhost/api/v1/auth/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: normal.cookie },
      body: JSON.stringify({ code: mintBody.code }),
    });
    expect(act.status).toBe(403);
    const actBody = (await act.json()) as { error: { code: string } };
    expect(actBody.error.code).toBe("ACTIVATION_EXPIRED");
  });

  it("limited-time code sets tierExpiresAt; expired tier falls back to normal in publicUser/billing", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const normal = await register(app, "normal@example.com", "password-normal");

    const mint = await app.request("http://localhost/api/v1/admin/codes", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ tier: "pro", expiresInDays: 7 }),
    });
    const mintBody = (await mint.json()) as { code: string };

    const act = await app.request("http://localhost/api/v1/auth/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: normal.cookie },
      body: JSON.stringify({ code: mintBody.code }),
    });
    expect(act.status).toBe(200);
    const actBody = (await act.json()) as { user: { tier: string; tierExpiresAt: string | null } };
    expect(actBody.user.tier).toBe("pro");
    expect(actBody.user.tierExpiresAt).toBeTruthy();

    // 把 user.tierExpiresAt 改到过去 → 有效 tier 应回落 normal。
    const saasFile = join(root, ".saas", "saas.json");
    const saas = JSON.parse(await readFile(saasFile, "utf-8")) as {
      users: Array<{ id: string; tier?: string; tierExpiresAt?: string }>;
    };
    const u = saas.users.find((x) => x.id === normal.userId);
    u!.tierExpiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(saasFile, JSON.stringify(saas, null, 2), "utf-8");

    const me = await app.request("http://localhost/api/v1/billing/me", { headers: { cookie: normal.cookie } });
    const meBody = (await me.json()) as { user: { tier: string; tierExpired: boolean } };
    expect(meBody.user.tier).toBe("normal");
    expect(meBody.user.tierExpired).toBe(true);
  });

  it("HMAC fallback still works for codes not in the registry (old/test codes)", async () => {
    // 不经发码端点,直接用 HMAC 铸一个 pro 码(注册表里没有)→ activate 应回落 HMAC 校验成功。
    const admin = await register(app, "admin@example.com", "password-admin"); // 触发 secret 配置
    expect(admin.cookie).toBeTruthy();
    const { } = admin;
    const normal = await register(app, "normal@example.com", "password-normal");

    // 复用 server 的铸码算法在测试侧重建一个 pro 码。
    const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const SALT = "juanshe.activation.v1";
    const secret = "test-admin-secret";
    const { createHmac } = await import("node:crypto");
    const checksum = (payload: string) => {
      const mac = createHmac("sha256", secret || SALT).update(payload).digest();
      let out = "";
      for (let i = 0; i < 6; i++) out += ALPHABET[mac[i] % 32];
      return out;
    };
    const guard = (tc: string) => {
      const mac = createHmac("sha256", secret || SALT).update("juanshe.tier|" + tc).digest();
      return ALPHABET[mac[0] % 32];
    };
    const tc = "2"; // pro
    const payload = (tc + guard(tc) + "ABCDEFGH").slice(0, 10).padEnd(10, "0");
    const body = payload + checksum("JUAN" + payload);
    const code = `JUAN-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`;

    const act = await app.request("http://localhost/api/v1/auth/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: normal.cookie },
      body: JSON.stringify({ code }),
    });
    expect(act.status).toBe(200);
    const actBody = (await act.json()) as { user: { tier: string } };
    expect(actBody.user.tier).toBe("pro");
  });

  // ── 桌面模式:admin 路由 404(不挂载语义)──────────────────────────────────
  it("desktop mode (SaaS off) returns 404 for all admin routes", async () => {
    delete process.env.HARDWRITE_SAAS_MODE;
    const desktopRoot = await mkdtemp(join(tmpdir(), "desktop-admin-"));
    await writeFile(join(desktopRoot, "hardwrite.json"), JSON.stringify(projectConfig, null, 2), "utf-8");
    const { createStudioServer } = await import("./server.js");
    const desktopApp = createStudioServer(projectConfig as never, desktopRoot) as App;

    const overview = await desktopApp.request("http://localhost/api/v1/admin/overview");
    expect(overview.status).toBe(404);
    const users = await desktopApp.request("http://localhost/api/v1/admin/users");
    expect(users.status).toBe(404);
    const codes = await desktopApp.request("http://localhost/api/v1/admin/codes");
    expect(codes.status).toBe(404);

    await rm(desktopRoot, { recursive: true, force: true });
  });
});
