/**
 * Minimal 极简号 — 黑白灰、几乎无装饰、字号紧凑、行高大。
 * 适合:观点/快讯/日报/极简博客。
 */

import type { WechatTemplate } from "./types.js";
import { esc, inline } from "./types.js";

const INK = "#111111";
const MUTED = "#666666";
const LINE = "#E5E5E5";

const TONE: Record<string, { bar: string; fg: string }> = {
  info: { bar: "#0EA5E9", fg: "#0B6C93" },
  warning: { bar: "#D97706", fg: "#92580A" },
  success: { bar: "#16A34A", fg: "#0F7A37" },
  danger: { bar: "#E5484D", fg: "#A3262B" },
  brand: { bar: INK, fg: INK },
};

const inl = (s: string) => inline(s, { highlightColor: "#FFE45A", accent: INK });

export const minimalTemplate: WechatTemplate = {
  id: "minimal",
  label: "极简号",
  tagline: "黑白克制 · 字大行松 · 适合观点/日报",
  shell() {
    return {
      rootStyle: `font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',sans-serif;font-size:17px;color:${INK};line-height:1.9;max-width:600px;margin:0 auto;padding:8px 4px;`,
      titleStyle: `display:block;font-size:28px;font-weight:800;color:${INK};margin:24px 0 4px;letter-spacing:-0.02em;line-height:1.3;`,
      subtitleStyle: `font-size:14px;color:${MUTED};margin:0 0 30px;line-height:1.5;`,
    };
  },
  renderBlock(b) {
    switch (b.type) {
      case "heading": {
        if (b.level === 1) return `<h1 style="font-size:22px;font-weight:800;color:${INK};margin:38px 0 14px;letter-spacing:-0.01em;">${inl(b.text)}</h1>`;
        if (b.level === 2) return `<h2 style="font-size:18px;font-weight:700;color:${INK};margin:30px 0 12px;">${inl(b.text)}</h2>`;
        return `<h3 style="font-size:16px;font-weight:700;color:${INK};margin:24px 0 10px;">${inl(b.text)}</h3>`;
      }
      case "paragraph":
        return `<p style="font-size:17px;line-height:1.9;color:${INK};margin:0 0 22px;">${inl(b.text)}</p>`;
      case "quote":
        return `<blockquote style="margin:0 0 24px;padding:4px 0 4px 18px;border-left:2px solid ${INK};color:${MUTED};font-size:17px;line-height:1.85;">${inl(b.text)}${b.source ? `<br><span style="font-size:13px;">—— ${inl(b.source)}</span>` : ""}</blockquote>`;
      case "figure_quote": {
        return `<section style="margin:0 0 24px;padding:14px 18px;background:#FAFAFA;border-left:2px solid ${INK};"><p style="margin:0 0 6px;color:${INK};font-size:16.5px;line-height:1.85;">${inl(b.text)}</p><span style="color:${MUTED};font-size:13px;">— ${esc(b.source)}</span></section>`;
      }
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        const items = b.items.map((it) => `<li style="font-size:17px;line-height:1.85;color:${INK};margin:0 0 8px;">${inl(it)}</li>`).join("");
        return `<${tag} style="margin:0 0 22px;padding-left:22px;">${items}</${tag}>`;
      }
      case "divider":
        return `<section style="margin:30px 0;border-top:1px solid ${LINE};"></section>`;
      case "fancy_divider":
        return `<section style="margin:36px 0;text-align:center;color:${MUTED};font-size:14px;">———</section>`;
      case "callout": {
        const t = TONE[b.tone] ?? TONE.brand;
        return `<section style="margin:0 0 22px;padding:10px 0 10px 16px;border-left:3px solid ${t.bar};">${b.title ? `<p style="margin:0 0 4px;font-weight:700;color:${t.fg};font-size:15px;">${inl(b.title)}</p>` : ""}<p style="margin:0;color:${INK};font-size:15px;line-height:1.85;">${inl(b.text)}</p></section>`;
      }
      case "highlight": {
        return `<section style="margin:0 0 22px;padding:14px 18px;background:#F5F5F5;">${b.title ? `<p style="margin:0 0 6px;font-weight:700;color:${INK};font-size:15px;">${inl(b.title)}</p>` : ""}<p style="margin:0;color:${INK};font-size:16px;line-height:1.85;font-weight:500;">${inl(b.text)}</p></section>`;
      }
      case "step": {
        return `<section style="margin:0 0 22px;"><div style="display:flex;align-items:baseline;margin-bottom:6px;"><span style="font-size:14px;font-weight:700;color:${MUTED};margin-right:10px;letter-spacing:0.04em;">${String(b.number).padStart(2, "0")}</span><h3 style="margin:0;font-size:17px;font-weight:700;color:${INK};">${inl(b.title)}</h3></div>${b.text ? `<p style="margin:0;font-size:16px;line-height:1.85;color:${INK};">${inl(b.text)}</p>` : ""}</section>`;
      }
      case "table": {
        const head = b.headers.map((h, i) => {
          const al = b.align?.[i] ?? "left";
          return `<th style="padding:8px 12px;text-align:${al};border-bottom:1px solid ${INK};color:${INK};font-weight:700;font-size:14px;">${esc(h)}</th>`;
        }).join("");
        const rows = b.rows.map((r) => {
          const cells = r.map((c, ci) => {
            const al = b.align?.[ci] ?? "left";
            return `<td style="padding:8px 12px;text-align:${al};border-bottom:1px solid ${LINE};color:${INK};font-size:14.5px;">${inl(c)}</td>`;
          }).join("");
          return `<tr>${cells}</tr>`;
        }).join("");
        return `<section style="margin:0 0 22px;overflow-x:auto;"><table style="width:100%;border-collapse:collapse;">${head ? `<thead><tr>${head}</tr></thead>` : ""}<tbody>${rows}</tbody></table></section>`;
      }
      case "cta": {
        const map: Record<string, string> = { comment: "评论", share: "转发", follow: "关注", subscribe: "订阅", buy: "了解", save: "收藏" };
        const label = b.text?.trim() || map[b.intent] || "";
        return `<section style="margin:30px 0;text-align:center;"><span style="display:inline-block;padding:8px 20px;color:${INK};font-size:14px;font-weight:600;border:1px solid ${INK};">${inl(label)}</span></section>`;
      }
      case "image_slot":
        return `<section style="margin:0 0 22px;padding:32px 16px;background:#FAFAFA;text-align:center;color:${MUTED};font-size:13px;">[ ${esc(b.purpose)} ]${b.caption ? `<br>${inl(b.caption)}` : ""}</section>`;
      default:
        return "";
    }
  },
};
