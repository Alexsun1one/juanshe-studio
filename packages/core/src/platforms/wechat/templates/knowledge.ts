/**
 * Knowledge 知识号 — 绿色学院风、表格规整、Step 卡像教材。
 * 适合:科普/教程/读书笔记/技术文。
 */

import type { WechatTemplate } from "./types.js";
import { esc, inline } from "./types.js";

const ACCENT = "#2BB97A";
const ACCENT_DEEP = "#0F6F45";
const ACCENT_LIGHT = "#E5F7EE";
const INK = "#1F2937";
const MUTED = "#6B7280";
const PAPER = "#FAFCFB";

const TONE: Record<string, { bar: string; bg: string; fg: string }> = {
  info: { bar: "#0EA5E9", bg: "#EAF6FC", fg: "#0B6C93" },
  warning: { bar: "#D97706", bg: "#FDF1DD", fg: "#92580A" },
  success: { bar: ACCENT, bg: ACCENT_LIGHT, fg: ACCENT_DEEP },
  danger: { bar: "#E5484D", bg: "#FCEBEC", fg: "#A3262B" },
  brand: { bar: ACCENT, bg: ACCENT_LIGHT, fg: ACCENT_DEEP },
};

const HIGHLIGHT_TONE: Record<string, { bg: string; fg: string; bar: string }> = {
  brand: { bg: ACCENT_LIGHT, fg: ACCENT_DEEP, bar: ACCENT },
  warm: { bg: "#FFF5E3", fg: "#92580A", bar: "#D97706" },
  cool: { bg: "#EAF6FC", fg: "#0B6C93", bar: "#0EA5E9" },
  neutral: { bg: "#F4F5F8", fg: "#3A4154", bar: "#646E80" },
};

const inl = (s: string) => inline(s, { highlightColor: "#FFE070", accent: ACCENT });

export const knowledgeTemplate: WechatTemplate = {
  id: "knowledge",
  label: "知识号",
  tagline: "学院绿 · 表格规整 · 适合教程/科普",
  shell() {
    return {
      rootStyle: `font-family:-apple-system,'PingFang SC','Microsoft YaHei',Georgia,serif;font-size:16px;color:${INK};line-height:1.85;max-width:680px;margin:0 auto;padding:4px 2px;background:${PAPER};`,
      titleStyle: `display:block;font-size:25px;font-weight:700;color:${ACCENT_DEEP};border-bottom:3px double ${ACCENT};padding:0 0 10px;margin:0 0 8px;line-height:1.4;`,
      subtitleStyle: `font-size:15px;color:${MUTED};margin:0 0 22px;line-height:1.6;font-style:italic;`,
    };
  },
  renderBlock(b) {
    switch (b.type) {
      case "heading": {
        if (b.level === 1) return `<h1 style="font-size:22px;font-weight:700;color:${ACCENT_DEEP};margin:34px 0 18px;border-bottom:2px solid ${ACCENT_LIGHT};padding-bottom:8px;">${inl(b.text)}</h1>`;
        if (b.level === 2) return `<h2 style="font-size:19px;font-weight:700;color:#18181f;margin:30px 0 16px;padding:6px 12px;background:${ACCENT_LIGHT};border-radius:6px;display:inline-block;">${inl(b.text)}</h2>`;
        return `<h3 style="font-size:16px;font-weight:700;color:${ACCENT_DEEP};margin:24px 0 12px;">▸ ${inl(b.text)}</h3>`;
      }
      case "paragraph":
        return `<p style="font-size:16px;line-height:1.9;color:${INK};margin:0 0 18px;">${inl(b.text)}</p>`;
      case "quote":
        return `<blockquote style="margin:0 0 20px;padding:14px 18px;background:${ACCENT_LIGHT};border-left:4px solid ${ACCENT};border-radius:0 8px 8px 0;color:${ACCENT_DEEP};font-size:15px;line-height:1.85;">${inl(b.text)}${b.source ? `<br><span style="color:${MUTED};font-size:13px;">—— ${inl(b.source)}</span>` : ""}</blockquote>`;
      case "figure_quote": {
        const initial = esc(b.source.charAt(0) || "Q");
        const avatar = b.avatarUrl
          ? `<img src="${esc(b.avatarUrl)}" alt="${esc(b.source)}" style="width:40px;height:40px;border-radius:50%;display:inline-block;margin-right:10px;vertical-align:middle;" />`
          : `<span style="display:inline-block;width:40px;height:40px;border-radius:50%;background:${ACCENT};color:#fff;text-align:center;line-height:40px;font-weight:700;font-size:16px;margin-right:10px;vertical-align:middle;">${initial}</span>`;
        return `<section style="margin:0 0 22px;padding:14px 16px;background:#fff;border-left:3px solid ${ACCENT};border-radius:0 8px 8px 0;"><p style="margin:0 0 8px;color:${INK};font-size:15px;line-height:1.85;">"${inl(b.text)}"</p><div>${avatar}<span style="color:${ACCENT_DEEP};font-weight:600;font-size:13.5px;">— ${esc(b.source)}</span></div></section>`;
      }
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        const items = b.items.map((it) => `<li style="font-size:16px;line-height:1.85;color:${INK};margin:0 0 8px;">${inl(it)}</li>`).join("");
        return `<${tag} style="margin:0 0 20px;padding-left:24px;">${items}</${tag}>`;
      }
      case "divider":
        return `<section style="margin:28px 0;text-align:center;color:#dcdce6;font-size:14px;letter-spacing:6px;">· · ·</section>`;
      case "fancy_divider":
        return `<section style="margin:32px 0;text-align:center;color:${ACCENT};font-size:16px;letter-spacing:6px;">━━━ ❦ ━━━</section>`;
      case "callout": {
        const t = TONE[b.tone] ?? TONE.brand;
        return `<section style="margin:0 0 20px;padding:14px 16px;background:${t.bg};border-left:4px solid ${t.bar};border-radius:0 8px 8px 0;">${b.title ? `<p style="margin:0 0 6px;font-weight:700;color:${t.fg};font-size:15px;">${inl(b.title)}</p>` : ""}<p style="margin:0;color:${t.fg};font-size:15px;line-height:1.85;">${inl(b.text)}</p></section>`;
      }
      case "highlight": {
        const t = HIGHLIGHT_TONE[b.tone ?? "brand"];
        return `<section style="margin:0 0 22px;padding:14px 18px;background:${t.bg};border:1px dashed ${t.bar};border-radius:8px;">${b.title ? `<p style="margin:0 0 8px;font-weight:700;color:${t.fg};font-size:15.5px;">📌 ${inl(b.title)}</p>` : ""}<p style="margin:0;color:${t.fg};font-size:15px;line-height:1.85;">${inl(b.text)}</p></section>`;
      }
      case "step": {
        const num = String(b.number).padStart(2, "0");
        return `<section style="margin:0 0 22px;padding:14px 16px;background:#fff;border-left:5px solid ${ACCENT};border-radius:0 8px 8px 0;"><div style="display:flex;align-items:center;margin-bottom:8px;"><span style="display:inline-block;padding:2px 10px;background:${ACCENT};color:#fff;font-weight:700;font-size:13px;border-radius:4px;margin-right:10px;letter-spacing:0.06em;">STEP&nbsp;${num}</span><h3 style="margin:0;font-size:16px;font-weight:700;color:${INK};">${inl(b.title)}</h3></div>${b.text ? `<p style="margin:0;font-size:15px;line-height:1.85;color:${INK};">${inl(b.text)}</p>` : ""}</section>`;
      }
      case "table": {
        const head = b.headers.map((h, i) => {
          const al = b.align?.[i] ?? "left";
          return `<th style="padding:10px 14px;text-align:${al};border-bottom:2px solid ${ACCENT_DEEP};color:#fff;font-weight:700;font-size:14px;background:${ACCENT};">${esc(h)}</th>`;
        }).join("");
        const rows = b.rows.map((r, ri) => {
          const cells = r.map((c, ci) => {
            const al = b.align?.[ci] ?? "left";
            return `<td style="padding:9px 14px;text-align:${al};border-bottom:1px solid #e5e7eb;color:${INK};font-size:14.5px;">${inl(c)}</td>`;
          }).join("");
          return `<tr style="background:${ri % 2 === 0 ? "#fff" : ACCENT_LIGHT};">${cells}</tr>`;
        }).join("");
        return `<section style="margin:0 0 22px;overflow-x:auto;"><table style="width:100%;border-collapse:collapse;border-radius:6px;overflow:hidden;">${head ? `<thead><tr>${head}</tr></thead>` : ""}<tbody>${rows}</tbody></table></section>`;
      }
      case "cta": {
        const map: Record<string, string> = { comment: "评论区聊聊", share: "转给同行", follow: "持续更新,点个关注", subscribe: "订阅", buy: "了解详情", save: "存档" };
        const label = b.text?.trim() || map[b.intent] || "";
        return `<section style="margin:28px 0;text-align:center;"><span style="display:inline-block;padding:10px 22px;background:#fff;color:${ACCENT_DEEP};font-size:14.5px;font-weight:700;border-radius:999px;border:2px solid ${ACCENT};">${inl(label)} →</span></section>`;
      }
      case "image_slot":
        return `<section style="margin:0 0 20px;padding:24px 16px;background:${PAPER};border:1px dashed ${ACCENT};border-radius:8px;text-align:center;color:${ACCENT_DEEP};font-size:13px;">[ 配图 · ${esc(b.purpose)} ]${b.caption ? `<br>${inl(b.caption)}` : ""}</section>`;
      default:
        return "";
    }
  },
};
