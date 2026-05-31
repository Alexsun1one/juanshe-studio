/**
 * WechatRenderer —— Content AST → 微信公众号成品 HTML。
 *
 * 关键约束:公众号编辑器会**剥掉 <style> 和 class**,只保留**内联样式**。
 * 因此本渲染器把所有样式写成 element 上的 style="" —— 复制粘贴进公众号编辑器即保留排版,
 * 无需二次排版。输出同时给 plainText 作为纯文本回退。
 *
 * B9 模板系统:renderWechat(doc, template) 第二参数选 5 个内置模板之一。
 *   business(默认) / knowledge / story / literary / minimal
 * 每个模板自带 doc shell + 单 block 渲染规则,样式差异大、信息密度差异大。
 */

import type {
  ContentBlock,
  ContentDocument,
  RenderedContent,
} from "../../content/ast.js";
import { getWechatTemplate } from "./templates/index.js";
export { listWechatTemplates, DEFAULT_WECHAT_TEMPLATE } from "./templates/index.js";
export type { WechatTemplateId } from "./templates/index.js";

const ACCENT = "#5b5bd6";
const INK = "#2e2e33";
const MUTED = "#8a8a99";
const LINE = "#ececf2";

const TONE: Record<string, { bar: string; bg: string; fg: string }> = {
  info: { bar: "#0ea5e9", bg: "#e6f4fc", fg: "#0b6c93" },
  warning: { bar: "#d97706", bg: "#fdf1dd", fg: "#92580a" },
  success: { bar: "#16a34a", bg: "#e7f6ed", fg: "#0f7a37" },
  danger: { bar: "#e5484d", bg: "#fcebec", fg: "#a3262b" },
  brand: { bar: ACCENT, bg: "#eeecff", fg: "#473fb0" },
};

const CTA_LABEL: Record<string, string> = {
  comment: "留言聊聊你的看法",
  share: "转发给需要的朋友",
  follow: "点个关注不迷路",
  subscribe: "订阅以获取更新",
  buy: "点此了解 / 购买",
  save: "收藏起来慢慢看",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 行内格式:**粗体** / *斜体* / `行内码`。先转义,再套内联样式。 */
function inline(s: string): string {
  let out = esc(s);
  out = out.replace(
    /`([^`]+)`/g,
    `<code style="font-family:SFMono-Regular,Consolas,monospace;font-size:14px;background:#f2f2f7;color:${ACCENT};padding:1px 5px;border-radius:4px;">$1</code>`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong style="font-weight:700;color:#1f1f24;">$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em style="font-style:italic;">$2</em>');
  return out;
}

function renderBlock(b: ContentBlock): string {
  switch (b.type) {
    case "heading": {
      if (b.level === 1) {
        return `<h1 style="font-size:22px;font-weight:700;color:#18181f;line-height:1.4;margin:34px 0 18px;letter-spacing:-0.01em;">${inline(b.text)}</h1>`;
      }
      if (b.level === 2) {
        return `<h2 style="font-size:19px;font-weight:700;color:#18181f;line-height:1.4;margin:30px 0 16px;padding-left:11px;border-left:4px solid ${ACCENT};">${inline(b.text)}</h2>`;
      }
      return `<h3 style="font-size:16px;font-weight:700;color:#2a2a31;line-height:1.5;margin:24px 0 12px;">${inline(b.text)}</h3>`;
    }
    case "paragraph":
      return `<p style="font-size:16px;line-height:1.85;color:${INK};margin:0 0 20px;letter-spacing:0.02em;">${inline(b.text)}</p>`;
    case "quote":
      return `<blockquote style="margin:0 0 20px;padding:12px 16px;background:#f7f7fb;border-left:3px solid ${ACCENT};border-radius:0 8px 8px 0;color:#55555f;font-size:15px;line-height:1.8;">${inline(b.text)}${b.source ? `<br><span style="color:${MUTED};font-size:13px;">—— ${inline(b.source)}</span>` : ""}</blockquote>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      const items = b.items
        .map(
          (it) =>
            `<li style="font-size:16px;line-height:1.8;color:${INK};margin:0 0 8px;">${inline(it)}</li>`,
        )
        .join("");
      return `<${tag} style="margin:0 0 20px;padding-left:24px;">${items}</${tag}>`;
    }
    case "divider":
      return `<section style="margin:28px 0;text-align:center;color:${LINE};font-size:14px;letter-spacing:6px;">• • •</section>`;
    case "callout": {
      const t = TONE[b.tone] ?? TONE.brand;
      return `<section style="margin:0 0 20px;padding:14px 16px;background:${t.bg};border-left:4px solid ${t.bar};border-radius:0 8px 8px 0;">${b.title ? `<p style="margin:0 0 6px;font-weight:700;color:${t.fg};font-size:15px;">${inline(b.title)}</p>` : ""}<p style="margin:0;color:${t.fg};font-size:15px;line-height:1.8;">${inline(b.text)}</p></section>`;
    }
    case "cta": {
      const label = b.text?.trim() || CTA_LABEL[b.intent] || "";
      return `<section style="margin:24px 0;text-align:center;"><span style="display:inline-block;padding:10px 22px;background:${ACCENT};color:#ffffff;font-size:15px;font-weight:600;border-radius:999px;">${inline(label)}</span></section>`;
    }
    case "image_slot":
      return `<section style="margin:0 0 20px;padding:28px 16px;background:#fafafe;border:1px dashed #cfcfdb;border-radius:10px;text-align:center;color:${MUTED};font-size:13px;">[ 配图占位 · ${esc(b.purpose)} ]${b.caption ? `<br>${inline(b.caption)}` : ""}${b.prompt ? `<br><span style="font-size:12px;">提示:${inline(b.prompt)}</span>` : ""}</section>`;
    default:
      return "";
  }
}

function blockToPlain(b: ContentBlock): string {
  switch (b.type) {
    case "heading":
      return b.text;
    case "paragraph":
    case "quote":
      return b.text;
    case "list":
      return b.items.map((it, i) => `${b.ordered ? `${i + 1}. ` : "· "}${it}`).join("\n");
    case "divider":
      return "———";
    case "fancy_divider":
      return "── ✦ ──";
    case "callout":
      return [b.title, b.text].filter(Boolean).join("：");
    case "highlight":
      return [b.title ? `★ ${b.title}` : "★", b.text].filter(Boolean).join(" ");
    case "step":
      return `Step ${b.number}：${b.title}${b.text ? "\n" + b.text : ""}`;
    case "figure_quote":
      return `"${b.text}" —— ${b.source}`;
    case "table": {
      const head = b.headers.join(" | ");
      const sep = b.headers.map(() => "---").join(" | ");
      const rows = b.rows.map((r) => r.join(" | ")).join("\n");
      return [head, sep, rows].filter(Boolean).join("\n");
    }
    case "cta":
      return b.text?.trim() || CTA_LABEL[b.intent] || "";
    case "image_slot":
      return b.caption ?? `[配图：${b.purpose}]`;
    default:
      return "";
  }
}

/**
 * 渲染整篇为公众号成品 HTML(全内联样式)。
 * @param doc Content AST
 * @param templateId 模板 id(business/knowledge/story/literary/minimal),默认 business
 */
export function renderWechat(doc: ContentDocument, templateId?: string): RenderedContent {
  const template = getWechatTemplate(templateId);
  const shell = template.shell(doc);
  const total = doc.blocks.length;
  const body = doc.blocks.map((b, i) => template.renderBlock(b, i, total)).join("\n");
  const titleHtml = doc.title
    ? `<h1 style="${shell.titleStyle}">${inline(doc.title)}</h1>`
    : "";
  const subtitleHtml = doc.subtitle
    ? `<p style="${shell.subtitleStyle}">${inline(doc.subtitle)}</p>`
    : "";

  const html =
    `<section style="${shell.rootStyle}">` +
    titleHtml +
    subtitleHtml +
    body +
    `</section>`;

  const plainText = [doc.title, doc.subtitle, ...doc.blocks.map(blockToPlain)]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join("\n\n");

  return { platform: "wechat", html, plainText };
}
