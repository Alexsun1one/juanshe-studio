/**
 * AI 编辑部 MCP 服务端(stdio,零依赖手写实现 JSON-RPC 2.0)。
 *
 * 把"AI 编辑部"的能力暴露成 MCP 工具,让本机自动化入口
 * 支持 MCP 的客户端直接调用(生成多平台内容、取作品知识、总编裁决…)。
 *
 * 传输:MCP stdio —— stdin/stdout 上每行一个完整的 JSON-RPC 消息(换行分隔)。
 *      日志一律走 stderr,绝不污染 stdout(stdout 是协议通道)。
 * 后端:转调正在运行的 studio HTTP API(默认 127.0.0.1:4569,可用 JUANSHE_API_PORT 覆盖)。
 */

import { createInterface } from "node:readline";

const PORT = process.env.JUANSHE_API_PORT || process.env.HARDWRITE_STUDIO_PORT || "4569";
const API_BASE = `http://127.0.0.1:${PORT}`;
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "juanshe-editorial-office", version: "1.0.0" };

function logErr(...args: unknown[]): void {
  process.stderr.write(`[mcp] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** 调 studio HTTP API;失败抛出可读错误(会被包成工具 isError 结果)。 */
async function api(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (e) {
    throw new Error(`无法连接 studio API(${API_BASE})。请先启动卷舍工作台。原始错误:${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const errMsg = (data as { error?: { message?: string } | string })?.error;
    throw new Error(`API ${res.status}: ${typeof errMsg === "string" ? errMsg : errMsg?.message || text.slice(0, 200)}`);
  }
  return data;
}

const enc = (s: string) => encodeURIComponent(s);

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
};

const PLATFORMS = ["wechat_article", "xiaohongshu_note", "zhihu_answer", "x_thread", "newsletter"] as const;

const TOOLS: ToolDef[] = [
  {
    name: "list_books",
    description: "列出本地 AI 编辑部里的所有作品(小说),含标题与状态。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const d = (await api("/api/v1/books")) as { books?: unknown[] } | unknown[];
      const books = Array.isArray(d) ? d : (d.books ?? []);
      return JSON.stringify(books, null, 2);
    },
  },
  {
    name: "get_book_knowledge",
    description: "取一本作品的结构化知识(Wiki 设定点 + 角色),供外部 agent 在此基础上创作或问答。",
    inputSchema: {
      type: "object",
      properties: { bookId: { type: "string", description: "作品 id(见 list_books)" } },
      required: ["bookId"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const bookId = String(args.bookId || "");
      if (!bookId) throw new Error("bookId 必填");
      const [wiki, cast] = await Promise.all([
        api(`/api/v1/books/${enc(bookId)}/wiki`).catch(() => null),
        api(`/api/v1/books/${enc(bookId)}/cast`).catch(() => null),
      ]);
      return JSON.stringify({ bookId, wiki, cast }, null, 2);
    },
  },
  {
    name: "compose_platform_content",
    description:
      "用 AI 编辑部为指定平台生成一篇可直接发布的成品(经选题→写作→风格化)。平台:wechat_article(公众号)/ xiaohongshu_note(小红书)/ zhihu_answer(知乎)/ x_thread(X)/ newsletter(邮件订阅长文)。",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: [...PLATFORMS], description: "目标平台" },
        brief: { type: "string", description: "选题/要求:主题、角度、受众" },
        revise: { type: "boolean", description: "是否走 生成→评审→修订(更慢更高质量),默认 false" },
      },
      required: ["platform", "brief"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const platform = String(args.platform || "");
      const brief = String(args.brief || "");
      if (!PLATFORMS.includes(platform as (typeof PLATFORMS)[number])) throw new Error(`未知平台: ${platform}`);
      if (!brief.trim()) throw new Error("brief 必填");
      const d = (await api(`/api/v1/content-type/${enc(platform)}/write`, {
        method: "POST",
        body: JSON.stringify({ brief: brief.trim(), revise: Boolean(args.revise) }),
      })) as { content?: string; markdown?: string; article?: string };
      const content = d.content || d.markdown || d.article || "";
      if (!content) throw new Error("后端未返回正文");
      return content;
    },
  },
  {
    name: "list_content_drafts",
    description: "列出已生成的多平台成品(内容库),含平台、标题、字数、评分、创建时间。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const d = (await api("/api/v1/content-drafts")) as { drafts?: unknown[] };
      return JSON.stringify(d.drafts ?? [], null, 2);
    },
  },
  {
    name: "editorial_review",
    description: "请总编(Editor-in-Chief)对某作品的某一章做整体编辑裁决:通过/返工 + 总编批语 + 下一程方向。",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "作品 id" },
        chapter: { type: "number", description: "章号" },
      },
      required: ["bookId", "chapter"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const bookId = String(args.bookId || "");
      const chapter = Number(args.chapter);
      if (!bookId || !Number.isInteger(chapter)) throw new Error("bookId 与 chapter(整数)必填");
      const d = (await api(`/api/v1/books/${enc(bookId)}/chapters/${chapter}/editorial-review`, {
        method: "POST",
        body: "{}",
      })) as { review?: unknown };
      return JSON.stringify(d.review ?? d, null, 2);
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

async function handleMessage(msg: Record<string, unknown>): Promise<void> {
  const { id, method, params } = msg as { id?: unknown; method?: string; params?: Record<string, unknown> };
  // 通知(无 id)不需要回复
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      return;
    case "tools/call": {
      const name = String(params?.name || "");
      const tool = TOOL_MAP.get(name);
      if (!tool) {
        reply(id, { content: [{ type: "text", text: `未知工具: ${name}` }], isError: true });
        return;
      }
      try {
        const text = await tool.handler((params?.arguments as Record<string, unknown>) ?? {});
        reply(id, { content: [{ type: "text", text }], isError: false });
      } catch (e) {
        reply(id, { content: [{ type: "text", text: `工具执行失败: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
      }
      return;
    }
    default:
      if (id !== undefined) replyError(id, -32601, `未知方法: ${method}`);
      return;
  }
}

export function startMcpServer(): void {
  logErr(`AI 编辑部 MCP 服务启动 · 后端 ${API_BASE} · 工具 ${TOOLS.length} 个`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logErr("无法解析的行(已忽略):", trimmed.slice(0, 120));
      return;
    }
    void handleMessage(msg).catch((e) => logErr("处理消息异常:", e instanceof Error ? e.message : String(e)));
  });
  rl.on("close", () => process.exit(0));
}

// 作为独立入口运行时直接启动(node dist/mcp-server.js)。
const isMain = (() => {
  try {
    return process.argv[1] ? import.meta.url === new URL(`file://${process.argv[1]}`).href || process.argv[1].endsWith("mcp-server.js") || process.argv[1].endsWith("mcp-server.ts") : false;
  } catch {
    return false;
  }
})();
if (isMain) startMcpServer();
