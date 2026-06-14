// 写作打卡热力图(GitHub 贡献图风格)+ 连更里程碑 测试。
//
// 与 saas-tenant-isolation.test.ts / saas-feed.test.ts 一样**不 mock @juanshe/core** ——
// 它要验证真实 StateManager 在(租户 / 桌面)物理目录读 chapters/index.json 的聚合效果,
// mock 掉就失去意义。覆盖:
//   - 聚合正确:造几章不同本地日期的 wordCount → calendar / todayWords / activeDays / totalWords 对得上;
//   - 连续 / 断更 streak 计算(currentStreak / longestStreak);
//   - 连更里程碑只送一次(重复请求不重复送);
//   - 桌面模式(SaaS off)不送 credits 但 streak 数据正常;
//   - 租户隔离(A 的 streak 不含 B 的书)。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const projectConfig = {
  name: "streak-test",
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

type StreakBody = {
  saas: boolean;
  calendar: Array<{ date: string; words: number; chapters: number }>;
  currentStreak: number;
  longestStreak: number;
  todayWords: number;
  activeDays: number;
  totalWords: number;
  credits: number | null;
  newlyRewarded: Array<{ days: number; credits: number }>;
  rewardedMilestones: number[];
};

async function register(app: App, email: string, password: string): Promise<{ cookie: string; tenantId: string }> {
  const res = await app.request("http://localhost/api/v1/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return { cookie: setCookie(res), tenantId: tenantIdForEmail(email) };
}

// 本地日期 YYYY-MM-DD(与 server.ts 的 localDateKey 一致,用本地时区,不用 toISOString)。
function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// "今天往回数 offset 天"的本地午夜时间戳(ISO)。offset=0 → 今天。
function daysAgoISO(offset: number, hour = 12): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, hour, 0, 0);
  return d.toISOString();
}
function daysAgoKey(offset: number): string {
  const now = new Date();
  return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset));
}

type SeedChapter = { number: number; words: number; offset: number };

// 直接在 books/<bookId>/chapters/index.json 落一份章节索引,绕开真实 LLM 写作。
// booksRoot:桌面 = <root>/books;SaaS 租户 = <root>/.saas/tenants/<tid>/books。
async function seedBook(
  booksRoot: string,
  bookId: string,
  title: string,
  chapters: SeedChapter[],
): Promise<void> {
  const bookDir = join(booksRoot, bookId);
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await writeFile(
    join(bookDir, "book.json"),
    JSON.stringify({ id: bookId, title, language: "zh" }, null, 2),
    "utf-8",
  );
  const index = chapters.map((ch) => {
    const ts = daysAgoISO(ch.offset);
    return {
      number: ch.number,
      title: `第 ${ch.number} 章`,
      status: "approved",
      wordCount: ch.words,
      createdAt: ts,
      updatedAt: ts,
      auditIssues: [],
      lengthWarnings: [],
    };
  });
  await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify(index, null, 2), "utf-8");
}

function desktopBooksRoot(root: string): string {
  return join(root, "books");
}
function tenantBooksRoot(root: string, tenantId: string): string {
  return join(root, ".saas", "tenants", tenantId, "books");
}

async function getStreak(app: App, cookie?: string): Promise<{ status: number; body: StreakBody }> {
  const res = await app.request("http://localhost/api/v1/streak", {
    headers: cookie ? { cookie } : {},
  });
  return { status: res.status, body: (await res.json()) as StreakBody };
}

// ──────────────────────────────────────────────────────────────────────────
// SaaS 模式
// ──────────────────────────────────────────────────────────────────────────
describe("Writing streak heatmap — SaaS mode", () => {
  let root: string;
  let app: App;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "streak-saas-"));
    await writeFile(join(root, "hardwrite.json"), JSON.stringify(projectConfig, null, 2), "utf-8");
    process.env.HARDWRITE_SAAS_MODE = "1";
    process.env.HARDWRITE_ACTIVATION_SECRET = "test-streak-secret";
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
    const { status } = await getStreak(app);
    expect(status).toBe(401);
  });

  it("aggregates chapter wordCount by local day into calendar + todayWords + totals", async () => {
    const a = await register(app, "alice@example.com", "password-aaa");
    // 今天 1200 字(两章),昨天 800 字(一章)。
    await seedBook(tenantBooksRoot(root, a.tenantId), "novel", "小说", [
      { number: 1, words: 500, offset: 0 },
      { number: 2, words: 700, offset: 0 },
      { number: 3, words: 800, offset: 1 },
    ]);

    const { status, body } = await getStreak(app, a.cookie);
    expect(status).toBe(200);
    expect(body.saas).toBe(true);
    expect(body.todayWords).toBe(1200);
    expect(body.totalWords).toBe(2000);
    expect(body.activeDays).toBe(2);

    const today = body.calendar.find((c) => c.date === daysAgoKey(0));
    const yesterday = body.calendar.find((c) => c.date === daysAgoKey(1));
    expect(today).toEqual({ date: daysAgoKey(0), words: 1200, chapters: 2 });
    expect(yesterday).toEqual({ date: daysAgoKey(1), words: 800, chapters: 1 });
    // 没写的日子补 0(密集日历)。
    const gapDay = body.calendar.find((c) => c.date === daysAgoKey(5));
    expect(gapDay).toEqual({ date: daysAgoKey(5), words: 0, chapters: 0 });
  });

  it("computes currentStreak for consecutive days and breaks on a gap", async () => {
    const a = await register(app, "alice@example.com", "password-aaa");
    // 今天、昨天、前天连写 → currentStreak=3;再往回隔一天(offset 4)单独一天 → 不连。
    await seedBook(tenantBooksRoot(root, a.tenantId), "novel", "小说", [
      { number: 1, words: 300, offset: 0 },
      { number: 2, words: 300, offset: 1 },
      { number: 3, words: 300, offset: 2 },
      { number: 4, words: 300, offset: 4 },
    ]);

    const { body } = await getStreak(app, a.cookie);
    expect(body.currentStreak).toBe(3);
    expect(body.longestStreak).toBe(3);
  });

  it("zero-word chapters do not count toward streak/activeDays", async () => {
    const a = await register(app, "alice@example.com", "password-aaa");
    await seedBook(tenantBooksRoot(root, a.tenantId), "novel", "小说", [
      { number: 1, words: 0, offset: 0 }, // 今天只有空章 → 今天不算写作
      { number: 2, words: 400, offset: 1 },
    ]);

    const { body } = await getStreak(app, a.cookie);
    expect(body.todayWords).toBe(0);
    expect(body.activeDays).toBe(1);
    // 今天没写但昨天写了 → currentStreak 从昨天起算 = 1(不打断)。
    expect(body.currentStreak).toBe(1);
  });

  it("grants a streak milestone reward once and is idempotent on repeat requests", async () => {
    const a = await register(app, "alice@example.com", "password-aaa");
    // 连写 3 天(今天+前两天)→ 命中 3 天里程碑(+50 credits)。
    await seedBook(tenantBooksRoot(root, a.tenantId), "novel", "小说", [
      { number: 1, words: 300, offset: 0 },
      { number: 2, words: 300, offset: 1 },
      { number: 3, words: 300, offset: 2 },
    ]);

    // 读注册时的初始 credits。
    const meRes = await app.request("http://localhost/api/v1/auth/me", { headers: { cookie: a.cookie } });
    const me = (await meRes.json()) as { user: { credits: number } };
    const baseCredits = me.user.credits;

    const first = await getStreak(app, a.cookie);
    expect(first.body.currentStreak).toBe(3);
    expect(first.body.newlyRewarded).toEqual([{ days: 3, credits: 50 }]);
    expect(first.body.rewardedMilestones).toEqual([3]);
    expect(first.body.credits).toBe(baseCredits + 50);

    // 第二次请求:已领过 → 不重复送。
    const second = await getStreak(app, a.cookie);
    expect(second.body.newlyRewarded).toEqual([]);
    expect(second.body.rewardedMilestones).toEqual([3]);
    expect(second.body.credits).toBe(baseCredits + 50);

    // ledger 里只有一笔 streak-reward。
    const ledgerRes = await app.request("http://localhost/api/v1/billing/me", { headers: { cookie: a.cookie } });
    const ledger = (await ledgerRes.json()) as { ledger: Array<{ reason: string; credits: number }> };
    const rewards = ledger.ledger.filter((e) => e.reason === "streak-reward");
    expect(rewards).toHaveLength(1);
    expect(rewards[0]!.credits).toBe(50);
  });

  it("grants every newly-reached milestone at once (3 + 7) when streak jumps past several", async () => {
    const a = await register(app, "alice@example.com", "password-aaa");
    // 连写 7 天 → 一次命中 3 天 + 7 天两个里程碑。
    const chapters: SeedChapter[] = [];
    for (let i = 0; i < 7; i++) chapters.push({ number: i + 1, words: 300, offset: i });
    await seedBook(tenantBooksRoot(root, a.tenantId), "novel", "小说", chapters);

    const { body } = await getStreak(app, a.cookie);
    expect(body.currentStreak).toBe(7);
    expect(body.newlyRewarded).toEqual([
      { days: 3, credits: 50 },
      { days: 7, credits: 120 },
    ]);
    expect(body.rewardedMilestones).toEqual([3, 7]);
  });

  it("isolates streak per tenant — A's streak does NOT include B's book", async () => {
    const a = await register(app, "alice@example.com", "password-aaa");
    const b = await register(app, "bob@example.com", "password-bbb");
    await seedBook(tenantBooksRoot(root, a.tenantId), "alice-novel", "爱丽丝", [
      { number: 1, words: 1000, offset: 0 },
    ]);
    await seedBook(tenantBooksRoot(root, b.tenantId), "bob-novel", "鲍勃", [
      { number: 1, words: 5000, offset: 0 },
      { number: 2, words: 5000, offset: 1 },
    ]);

    const aStreak = await getStreak(app, a.cookie);
    expect(aStreak.body.totalWords).toBe(1000);
    expect(aStreak.body.todayWords).toBe(1000);

    const bStreak = await getStreak(app, b.cookie);
    expect(bStreak.body.totalWords).toBe(10000);
    expect(bStreak.body.todayWords).toBe(5000);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 桌面模式(SaaS off)
// ──────────────────────────────────────────────────────────────────────────
describe("Writing streak heatmap — desktop mode (SaaS off)", () => {
  let root: string;
  let app: App;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "streak-desktop-"));
    await writeFile(join(root, "hardwrite.json"), JSON.stringify(projectConfig, null, 2), "utf-8");
    delete process.env.HARDWRITE_SAAS_MODE;
    const { createStudioServer } = await import("./server.js");
    app = createStudioServer(projectConfig as never, root) as App;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns streak data without login and without granting credits", async () => {
    // 桌面书在 <root>/books;连写两天。
    await seedBook(desktopBooksRoot(root), "local-novel", "本地小说", [
      { number: 1, words: 600, offset: 0 },
      { number: 2, words: 400, offset: 1 },
    ]);

    const { status, body } = await getStreak(app);
    expect(status).toBe(200);
    expect(body.saas).toBe(false);
    expect(body.todayWords).toBe(600);
    expect(body.totalWords).toBe(1000);
    expect(body.currentStreak).toBe(2);
    expect(body.activeDays).toBe(2);
    // 桌面无配额体系:不送 credits。
    expect(body.credits).toBeNull();
    expect(body.newlyRewarded).toEqual([]);
    expect(body.rewardedMilestones).toEqual([]);
  });

  it("returns an empty calendar (all-zero, no error) when no books exist", async () => {
    const { status, body } = await getStreak(app);
    expect(status).toBe(200);
    expect(body.saas).toBe(false);
    expect(body.currentStreak).toBe(0);
    expect(body.totalWords).toBe(0);
    expect(body.activeDays).toBe(0);
    expect(body.calendar.length).toBeGreaterThan(0);
    expect(body.calendar.every((c) => c.words === 0 && c.chapters === 0)).toBe(true);
  });
});
