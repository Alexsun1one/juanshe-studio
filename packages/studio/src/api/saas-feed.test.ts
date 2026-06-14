// 站长广播 Feed 测试。
//
// 与 saas-admin.test.ts 同样**不 mock @juanshe/core** —— 走真实 StateManager/磁盘,验证:
//   - 发/删动态严格 admin 门禁(非 admin POST/DELETE → 403、未登录 → 401)
//   - admin 发动态 → GET /feed 看得到 + 其他用户未读 +1
//   - 标记已读后未读归零
//   - 校验:title 非空、type 合法、link 可空/必须 http(s)
//   - pinned 置顶 + createdAt 倒序
//   - 桌面模式(SaaS off):/admin/feed 一律 404、/feed 返回空(saas:false,不报错)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const projectConfig = {
  name: "saas-feed-test",
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

function setCookie(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  const match = raw.match(/hardwrite_saas_session=[^;]+/);
  return match ? match[0] : "";
}

type App = { request: (input: string | Request, init?: RequestInit) => Response | Promise<Response> };

async function register(app: App, email: string, password: string): Promise<{ cookie: string; userId: string }> {
  const res = await app.request("http://localhost/api/v1/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: setCookie(res), userId: body.user.id };
}

async function postFeed(
  app: App,
  cookie: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  return app.request("http://localhost/api/v1/admin/feed", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(payload),
  });
}

describe("SaaS station-owner broadcast feed", () => {
  let root: string;
  let app: App;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "saas-feed-"));
    await writeFile(join(root, "hardwrite.json"), JSON.stringify(projectConfig, null, 2), "utf-8");
    process.env.HARDWRITE_SAAS_MODE = "1";
    process.env.HARDWRITE_ACTIVATION_SECRET = "test-feed-secret";
    delete process.env.HARDWRITE_SAAS_DATA_DIR;
    const { createStudioServer } = await import("./server.js");
    app = createStudioServer(projectConfig as never, root) as App;
  });

  afterEach(async () => {
    delete process.env.HARDWRITE_SAAS_MODE;
    delete process.env.HARDWRITE_ACTIVATION_SECRET;
    await rm(root, { recursive: true, force: true });
  });

  // ── 发/删动态门禁 ──────────────────────────────────────────────────────────
  it("rejects unauthenticated POST /admin/feed with 401", async () => {
    const res = await app.request("http://localhost/api/v1/admin/feed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新公众号文章" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects normal tenant POST /admin/feed with 403", async () => {
    await register(app, "admin@example.com", "password-admin"); // 首注=admin
    const normal = await register(app, "normal@example.com", "password-normal");
    const res = await postFeed(app, normal.cookie, { title: "想冒充站长发广播" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("rejects normal tenant DELETE /admin/feed/:id with 403", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const normal = await register(app, "normal@example.com", "password-normal");
    const created = (await (await postFeed(app, admin.cookie, { title: "更新日志 v2" })).json()) as { item: { id: string } };
    const res = await app.request(`http://localhost/api/v1/admin/feed/${created.item.id}`, {
      method: "DELETE",
      headers: { cookie: normal.cookie },
    });
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated DELETE /admin/feed/:id with 401", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const created = (await (await postFeed(app, admin.cookie, { title: "新品发布" })).json()) as { item: { id: string } };
    const res = await app.request(`http://localhost/api/v1/admin/feed/${created.item.id}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  // ── 发→读→未读→已读闭环 ────────────────────────────────────────────────────
  it("admin posts a feed item; another user sees it with unreadCount +1, then zero after seen", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const reader = await register(app, "reader@example.com", "password-reader");

    const post = await postFeed(app, admin.cookie, {
      title: "公众号新文章:卷舍的下一步",
      body: "聊聊路线图。",
      link: "https://write.nextapi.top/article/1",
      type: "article",
    });
    expect(post.status).toBe(200);
    const postBody = (await post.json()) as { ok: boolean; item: { id: string; type: string; createdBy: string } };
    expect(postBody.ok).toBe(true);
    expect(postBody.item.type).toBe("article");
    expect(postBody.item.createdBy).toBe("admin@example.com");

    // reader GET /feed:看得到该条 + 未读 +1。
    const feed = await app.request("http://localhost/api/v1/feed", { headers: { cookie: reader.cookie } });
    expect(feed.status).toBe(200);
    const feedBody = (await feed.json()) as {
      saas: boolean;
      items: Array<{ id: string; title: string; link: string }>;
      unreadCount: number;
    };
    expect(feedBody.saas).toBe(true);
    expect(feedBody.items.length).toBe(1);
    expect(feedBody.items[0].title).toBe("公众号新文章:卷舍的下一步");
    expect(feedBody.items[0].link).toBe("https://write.nextapi.top/article/1");
    expect(feedBody.unreadCount).toBe(1);
    // 隐私:公开 /feed 绝不暴露 createdBy(站长 admin 邮箱)给普通用户。
    expect((feedBody.items[0] as Record<string, unknown>).createdBy).toBeUndefined();

    // 标记已读 → 未读归零。
    const seen = await app.request("http://localhost/api/v1/feed/seen", {
      method: "POST",
      headers: { cookie: reader.cookie },
    });
    expect(seen.status).toBe(200);
    expect(((await seen.json()) as { ok: boolean }).ok).toBe(true);

    const feed2 = await app.request("http://localhost/api/v1/feed", { headers: { cookie: reader.cookie } });
    const feed2Body = (await feed2.json()) as { items: unknown[]; unreadCount: number };
    expect(feed2Body.unreadCount).toBe(0);
    expect(feed2Body.items.length).toBe(1); // 仍看得到,只是不再算未读

    // feedSeenAt 落盘在 user 上。
    const saas = JSON.parse(await readFile(join(root, ".saas", "saas.json"), "utf-8")) as {
      users: Array<{ id: string; feedSeenAt?: string }>;
    };
    const readerUser = saas.users.find((u) => u.id === reader.userId);
    expect(readerUser!.feedSeenAt).toBeTruthy();
  });

  it("a feed item posted AFTER a user marked seen counts as unread again", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const reader = await register(app, "reader@example.com", "password-reader");

    await postFeed(app, admin.cookie, { title: "第一条" });
    await app.request("http://localhost/api/v1/feed/seen", { method: "POST", headers: { cookie: reader.cookie } });

    // 已读后再发一条 —— createdAt > feedSeenAt → 未读应回到 1。
    // 用 1ms 间隔避免同毫秒导致 strict-greater 判定边界误判。
    await new Promise((r) => setTimeout(r, 5));
    await postFeed(app, admin.cookie, { title: "已读后又来一条" });

    const feed = await app.request("http://localhost/api/v1/feed", { headers: { cookie: reader.cookie } });
    const body = (await feed.json()) as { unreadCount: number; items: unknown[] };
    expect(body.items.length).toBe(2);
    expect(body.unreadCount).toBe(1);
  });

  // ── 校验 ────────────────────────────────────────────────────────────────────
  it("rejects empty title with 400", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const res = await postFeed(app, admin.cookie, { title: "   " });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_TITLE");
  });

  it("rejects invalid type with 400", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const res = await postFeed(app, admin.cookie, { title: "标题", type: "spam" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_TYPE");
  });

  it("accepts an item with empty link (link is optional)", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const res = await postFeed(app, admin.cookie, { title: "纯文字公告,没有链接", type: "update" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { item: { link: string } }).item.link).toBe("");
  });

  it("rejects a non-http link with 400", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const res = await postFeed(app, admin.cookie, { title: "标题", link: "javascript:alert(1)" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_LINK");
  });

  // ── 排序:pinned 置顶 + createdAt 倒序 ──────────────────────────────────────
  it("orders pinned first, then newest createdAt", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const reader = await register(app, "reader@example.com", "password-reader");

    await postFeed(app, admin.cookie, { title: "旧普通" });
    await new Promise((r) => setTimeout(r, 5));
    await postFeed(app, admin.cookie, { title: "新普通" });
    await new Promise((r) => setTimeout(r, 5));
    await postFeed(app, admin.cookie, { title: "置顶公告", pinned: true });

    const feed = await app.request("http://localhost/api/v1/feed", { headers: { cookie: reader.cookie } });
    const body = (await feed.json()) as { items: Array<{ title: string; pinned: boolean }> };
    expect(body.items.map((i) => i.title)).toEqual(["置顶公告", "新普通", "旧普通"]);
    expect(body.items[0].pinned).toBe(true);
  });

  // ── admin GET /admin/feed 列全部 + DELETE 删除 ──────────────────────────────
  it("admin lists all items and can delete one", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const created = (await (await postFeed(app, admin.cookie, { title: "待删除" })).json()) as { item: { id: string } };
    await postFeed(app, admin.cookie, { title: "保留" });

    const list = await app.request("http://localhost/api/v1/admin/feed", { headers: { cookie: admin.cookie } });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: unknown[] }).items.length).toBe(2);

    const del = await app.request(`http://localhost/api/v1/admin/feed/${created.item.id}`, {
      method: "DELETE",
      headers: { cookie: admin.cookie },
    });
    expect(del.status).toBe(200);

    const list2 = await app.request("http://localhost/api/v1/admin/feed", { headers: { cookie: admin.cookie } });
    const list2Body = (await list2.json()) as { items: Array<{ title: string }> };
    expect(list2Body.items.length).toBe(1);
    expect(list2Body.items[0].title).toBe("保留");
  });

  it("deleting a missing feed id returns 404", async () => {
    const admin = await register(app, "admin@example.com", "password-admin");
    const res = await app.request("http://localhost/api/v1/admin/feed/feed_doesnotexist", {
      method: "DELETE",
      headers: { cookie: admin.cookie },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FEED_NOT_FOUND");
  });

  // ── /feed 未登录 401 ────────────────────────────────────────────────────────
  it("GET /feed without a session returns 401 in SaaS mode", async () => {
    await register(app, "admin@example.com", "password-admin"); // 进入 SaaS 有用户态
    const res = await app.request("http://localhost/api/v1/feed");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_REQUIRED");
  });

  // ── 桌面模式 ────────────────────────────────────────────────────────────────
  it("desktop mode (SaaS off): /admin/feed routes are 404, /feed returns empty (saas:false)", async () => {
    delete process.env.HARDWRITE_SAAS_MODE;
    const desktopRoot = await mkdtemp(join(tmpdir(), "desktop-feed-"));
    await writeFile(join(desktopRoot, "hardwrite.json"), JSON.stringify(projectConfig, null, 2), "utf-8");
    const { createStudioServer } = await import("./server.js");
    const desktopApp = createStudioServer(projectConfig as never, desktopRoot) as App;

    const adminPost = await desktopApp.request("http://localhost/api/v1/admin/feed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(adminPost.status).toBe(404);
    const adminList = await desktopApp.request("http://localhost/api/v1/admin/feed");
    expect(adminList.status).toBe(404);
    const adminDel = await desktopApp.request("http://localhost/api/v1/admin/feed/anything", { method: "DELETE" });
    expect(adminDel.status).toBe(404);

    // 用户端 /feed:桌面下不报错,返回空 + saas:false(行为字节级不变,不暴露 SaaS 语义)。
    const feed = await desktopApp.request("http://localhost/api/v1/feed");
    expect(feed.status).toBe(200);
    const feedBody = (await feed.json()) as { saas: boolean; items: unknown[]; unreadCount: number };
    expect(feedBody.saas).toBe(false);
    expect(feedBody.items).toEqual([]);
    expect(feedBody.unreadCount).toBe(0);

    const seen = await desktopApp.request("http://localhost/api/v1/feed/seen", { method: "POST" });
    expect(seen.status).toBe(200);
    expect(((await seen.json()) as { saas: boolean }).saas).toBe(false);

    await rm(desktopRoot, { recursive: true, force: true });
  });
});
