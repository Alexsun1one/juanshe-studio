/**
 * 平台渲染器分发 —— Content AST → 各平台成品。
 *
 * 公众号在 ./wechat/renderer.ts(全内联样式 HTML)。
 * 这里补 小红书 / 知乎 / X,并提供 renderForPlatform 统一入口。
 * 每个渲染器都返回 RenderedContent { platform, html(预览), plainText(实际复制) }。
 * 知乎/公众号靠富文本 HTML 粘贴;小红书/X 是移动端/字数受限,plainText 才是主复制内容。
 */

import type {
  ContentBlock,
  ContentDocument,
  Platform,
  RenderedContent,
} from "../content/ast.js";
import { renderWechat } from "./wechat/renderer.js";

export { renderWechat } from "./wechat/renderer.js";

const ACCENT = "#5b5bd6";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function blockText(b: ContentBlock): string {
  switch (b.type) {
    case "heading":
    case "paragraph":
    case "quote":
      return b.text;
    case "list":
      return b.items.map((it, i) => `${b.ordered ? `${i + 1}. ` : "· "}${it}`).join("\n");
    case "callout":
      return [b.title, b.text].filter(Boolean).join("：");
    case "cta":
      return b.text ?? "";
    default:
      return "";
  }
}

/* ============================================================
   知乎 —— 问题导向、论证充分、少营销腔。语义 HTML + Markdown 纯文本。
   ============================================================ */

export function renderZhihu(doc: ContentDocument): RenderedContent {
  const htmlParts: string[] = [];
  const mdParts: string[] = [];
  if (doc.title) {
    htmlParts.push(`<h1>${esc(doc.title)}</h1>`);
    mdParts.push(`# ${doc.title}`);
  }
  for (const b of doc.blocks) {
    switch (b.type) {
      case "heading":
        htmlParts.push(`<h${b.level}>${esc(b.text)}</h${b.level}>`);
        mdParts.push(`${"#".repeat(b.level)} ${b.text}`);
        break;
      case "paragraph":
        htmlParts.push(`<p>${esc(b.text)}</p>`);
        mdParts.push(b.text);
        break;
      case "quote":
        htmlParts.push(`<blockquote>${esc(b.text)}</blockquote>`);
        mdParts.push(`> ${b.text}`);
        break;
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        htmlParts.push(`<${tag}>${b.items.map((it) => `<li>${esc(it)}</li>`).join("")}</${tag}>`);
        mdParts.push(b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : "-"} ${it}`).join("\n"));
        break;
      }
      case "divider":
        htmlParts.push("<hr>");
        mdParts.push("---");
        break;
      default:
        break;
    }
  }
  return { platform: "zhihu", html: htmlParts.join("\n"), plainText: mdParts.join("\n\n") };
}

/* ============================================================
   小红书 —— 移动端速读:强标题、短段、emoji、可收藏、标签。
   ============================================================ */

function deriveHashtags(doc: ContentDocument): string[] {
  const tags = new Set<string>();
  const pushTag = (value: string | undefined) => {
    const t = String(value ?? "").replace(/[^\p{Script=Han}\p{Letter}\p{Number}_-]/gu, "").trim();
    if (t.length >= 2 && t.length <= 12) tags.add(t);
  };
  for (const b of doc.blocks) {
    if (b.type === "heading") {
      pushTag(b.text.replace(/^[一二三四五六七八九十、\d.\s]+/, ""));
    }
  }
  if (doc.metadata?.tone) pushTag(doc.metadata.tone);
  return [...tags].slice(0, 8);
}

export function renderXiaohongshu(doc: ContentDocument): RenderedContent {
  const lines: string[] = [];
  if (doc.title) lines.push(`📖 ${doc.title}`);
  if (doc.subtitle) lines.push(doc.subtitle);
  lines.push("");
  for (const b of doc.blocks) {
    if (b.type === "heading") lines.push(`✨ ${b.text}`);
    else if (b.type === "paragraph") lines.push(b.text);
    else if (b.type === "quote") lines.push(`💬 ${b.text}`);
    else if (b.type === "list") lines.push(b.items.map((it) => `· ${it}`).join("\n"));
    else if (b.type === "callout") lines.push(`📌 ${[b.title, b.text].filter(Boolean).join("：")}`);
    else if (b.type === "cta") lines.push(b.text || "收藏起来,下次照着用");
    else if (b.type === "image_slot" && b.caption) lines.push(`配图: ${b.caption}`);
    else if (b.type === "divider") lines.push("— — —");
    if (b.type !== "list") lines.push("");
  }
  const hashtags = deriveHashtags(doc).map((t) => `#${t}`);
  const plainText = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n\n${hashtags.join(" ")}`.trim();

  const cards = plainText.split("\n\n").map(
    (p) =>
      `<p style="margin:0 0 12px;font-size:15px;line-height:1.7;color:#33333a;">${esc(p).replace(/\n/g, "<br>")}</p>`,
  );
  const html = `<section style="font-family:-apple-system,'PingFang SC',sans-serif;max-width:340px;margin:0 auto;background:#fff;border-radius:14px;padding:18px 16px;">${cards.join("")}</section>`;
  return { platform: "xiaohongshu", html, plainText };
}

/* ============================================================
   X / Twitter —— thread:强 hook、短句、每条独立、编号。
   ============================================================ */

const X_LIMIT = 260; // 粗略权重:CJK 计 2,留余量

function weightedLen(s: string): number {
  let n = 0;
  for (const ch of s) n += /[　-鿿＀-￯]/.test(ch) ? 2 : 1;
  return n;
}

function splitToTweets(text: string): string[] {
  const out: string[] = [];
  const sentences = text.split(/(?<=[。！？!?\n])/).map((s) => s.trim()).filter(Boolean);
  let cur = "";
  for (const s of sentences) {
    if (weightedLen(cur) + weightedLen(s) > X_LIMIT && cur) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function renderX(doc: ContentDocument): RenderedContent {
  const body = [doc.title, doc.subtitle, ...doc.blocks.map(blockText)]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join("\n");
  const tweets = splitToTweets(body);
  const total = tweets.length;
  const numbered = tweets.map((t, i) => `${t}${total > 1 ? `\n\n${i + 1}/${total}` : ""}`);
  const plainText = numbered.join("\n\n———\n\n");

  const cards = numbered
    .map(
      (t, i) =>
        `<div style="border:1px solid #e2e2ea;border-radius:12px;padding:12px 14px;margin:0 0 10px;font-size:14px;line-height:1.6;color:#2e2e33;white-space:pre-wrap;"><span style="color:${ACCENT};font-weight:700;">${i + 1}/${total}</span><br>${esc(t.replace(/\n\n\d+\/\d+$/, ""))}</div>`,
    )
    .join("");
  const html = `<section style="font-family:-apple-system,'PingFang SC',sans-serif;max-width:420px;margin:0 auto;">${cards}</section>`;
  return { platform: "x", html, plainText };
}

/* ============================================================
   Newsletter —— 邮件订阅长文:清晰摘要、短段落、可转发/订阅 CTA。
   ============================================================ */

function renderNewsletterBlockHtml(block: ContentBlock): string {
  switch (block.type) {
    case "heading":
      return `<h${block.level} style="margin:28px 0 10px;font-size:${block.level === 1 ? "24px" : "20px"};line-height:1.35;color:#111827;">${esc(block.text)}</h${block.level}>`;
    case "paragraph":
      return `<p style="margin:0 0 16px;font-size:16px;line-height:1.78;color:#374151;">${esc(block.text)}</p>`;
    case "quote":
      return `<blockquote style="margin:0 0 18px;padding:12px 16px;border-left:4px solid ${ACCENT};background:#f7f7ff;color:#4b5563;font-size:15px;line-height:1.7;">${esc(block.text)}</blockquote>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      return `<${tag} style="margin:0 0 18px;padding-left:22px;color:#374151;font-size:16px;line-height:1.75;">${block.items.map((item) => `<li style="margin:0 0 8px;">${esc(item)}</li>`).join("")}</${tag}>`;
    }
    case "divider":
      return `<hr style="border:0;border-top:1px solid #e5e7eb;margin:26px 0;">`;
    case "callout":
      return `<aside style="margin:0 0 18px;padding:14px 16px;border-radius:12px;background:#f9fafb;border:1px solid #e5e7eb;color:#374151;font-size:15px;line-height:1.7;">${block.title ? `<strong style="display:block;margin-bottom:4px;color:#111827;">${esc(block.title)}</strong>` : ""}${esc(block.text)}</aside>`;
    case "cta":
      return `<p style="margin:24px 0 0;padding:14px 16px;border-radius:999px;background:#f4f4ff;color:${ACCENT};font-weight:700;text-align:center;">${esc(block.text)}</p>`;
    case "image_slot":
      return block.caption
        ? `<p style="margin:0 0 16px;color:#6b7280;font-size:14px;text-align:center;">${esc(block.caption)}</p>`
        : "";
    default:
      return "";
  }
}

function renderNewsletterBlockText(block: ContentBlock): string {
  switch (block.type) {
    case "heading":
      return `${"#".repeat(block.level)} ${block.text}`;
    case "paragraph":
      return block.text;
    case "quote":
      return `> ${block.text}`;
    case "list":
      return block.items.map((item, i) => `${block.ordered ? `${i + 1}.` : "-"} ${item}`).join("\n");
    case "divider":
      return "---";
    case "callout":
      return [block.title, block.text].filter(Boolean).join("\n");
    case "cta":
      return block.text;
    case "image_slot":
      return block.caption ?? "";
    default:
      return "";
  }
}

export function renderNewsletter(doc: ContentDocument): RenderedContent {
  const title = doc.title?.trim() || "Untitled Newsletter";
  const subtitle = doc.subtitle?.trim() || doc.summary?.trim() || "";
  const bodyHtml = doc.blocks.map(renderNewsletterBlockHtml).filter(Boolean).join("\n");
  const preheader = subtitle || "本期精选内容";
  const html = [
    `<section style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;max-width:640px;margin:0 auto;background:#ffffff;color:#111827;">`,
    `<div style="display:none;max-height:0;overflow:hidden;color:transparent;">${esc(preheader)}</div>`,
    `<header style="padding:28px 0 22px;border-bottom:1px solid #e5e7eb;margin-bottom:24px;">`,
    `<div style="margin-bottom:10px;font-size:12px;line-height:1.4;letter-spacing:.08em;text-transform:uppercase;color:${ACCENT};font-weight:800;">Newsletter</div>`,
    `<h1 style="margin:0;font-size:30px;line-height:1.25;color:#111827;">${esc(title)}</h1>`,
    subtitle ? `<p style="margin:12px 0 0;font-size:16px;line-height:1.65;color:#6b7280;">${esc(subtitle)}</p>` : "",
    `</header>`,
    bodyHtml,
    `<footer style="margin-top:34px;padding-top:18px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:13px;line-height:1.7;">感谢阅读。如果这封信对你有帮助,可以转发给需要的人,或回复告诉我们下一期想看什么。</footer>`,
    `</section>`,
  ].filter(Boolean).join("\n");

  const plainText = [
    `# ${title}`,
    subtitle,
    ...doc.blocks.map(renderNewsletterBlockText),
    "感谢阅读。如果这封信对你有帮助,可以转发给需要的人,或回复告诉我们下一期想看什么。",
  ].filter((part) => part.trim()).join("\n\n");

  return { platform: "newsletter", html, plainText };
}

/* ============================================================
   统一入口
   ============================================================ */

export function renderForPlatform(
  platform: Platform,
  doc: ContentDocument,
  options?: { templateId?: string },
): RenderedContent {
  switch (platform) {
    case "wechat":
      return renderWechat(doc, options?.templateId);
    case "zhihu":
      return renderZhihu(doc);
    case "xiaohongshu":
      return renderXiaohongshu(doc);
    case "x":
      return renderX(doc);
    case "newsletter":
      return renderNewsletter(doc);
    default:
      return renderWechat(doc, options?.templateId);
  }
}
