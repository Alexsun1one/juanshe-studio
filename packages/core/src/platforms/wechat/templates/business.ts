/**
 * Business 商业号 — 干净专业、紫蓝品牌色、Step 卡显眼。
 * 适合:工具/SaaS/B2B/产品发布/方法论。
 */

import type { WechatTemplate } from "./types.js";
import { esc, inline } from "./types.js";

const ACCENT = "#5b5bd6";
const ACCENT_DEEP = "#3d3aa8";
const ACCENT_LIGHT = "#eeecff";
const INK = "#1f2433";
const MUTED = "#8a8a99";

const TONE: Record<string, { bar: string; bg: string; fg: string }> = {
  info: { bar: "#0ea5e9", bg: "#e6f4fc", fg: "#0b6c93" },
  warning: { bar: "#d97706", bg: "#fdf1dd", fg: "#92580a" },
  success: { bar: "#16a34a", bg: "#e7f6ed", fg: "#0f7a37" },
  danger: { bar: "#e5484d", bg: "#fcebec", fg: "#a3262b" },
  brand: { bar: ACCENT, bg: ACCENT_LIGHT, fg: ACCENT_DEEP },
};

const HIGHLIGHT_TONE: Record<string, { bar: string; bg: string; fg: string; ring: string }> = {
  brand: { bar: ACCENT, bg: ACCENT_LIGHT, fg: ACCENT_DEEP, ring: "rgba(91,91,214,0.15)" },
  warm: { bar: "#d97706", bg: "#fff5e3", fg: "#92580a", ring: "rgba(217,119,6,0.15)" },
  cool: { bar: "#0ea5e9", bg: "#eaf6fc", fg: "#0b6c93", ring: "rgba(14,165,233,0.15)" },
  neutral: { bar: "#646E80", bg: "#f4f5f8", fg: "#3a4154", ring: "rgba(100,110,128,0.12)" },
};

const inl = (s: string) => inline(s, { highlightColor: "#FFE45A", accent: ACCENT });

export const businessTemplate: WechatTemplate = {
  id: "business",
  label: "商业号",
  tagline: "紫蓝主色 · Step 卡 · 适合产品/方法论",
  shell(doc) {
    void doc;
    return {
      rootStyle: `font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;font-size:16px;color:${INK};line-height:1.85;max-width:677px;margin:0 auto;padding:4px 2px;`,
      // 渐变 H1 banner
      titleStyle: `display:block;font-size:26px;font-weight:800;color:#ffffff;background:linear-gradient(135deg,${ACCENT} 0%,${ACCENT_DEEP} 100%);padding:18px 20px;border-radius:12px;margin:0 0 8px;letter-spacing:-0.01em;line-height:1.4;`,
      subtitleStyle: `font-size:15px;color:${MUTED};margin:0 0 22px;line-height:1.6;padding:0 4px;`,
    };
  },
  renderBlock(b) {
    switch (b.type) {
      case "heading": {
        if (b.level === 1) {
          return `<h1 style="font-size:22px;font-weight:800;color:${ACCENT_DEEP};line-height:1.4;margin:34px 0 18px;letter-spacing:-0.01em;">${inl(b.text)}</h1>`;
        }
        if (b.level === 2) {
          return `<h2 style="font-size:19px;font-weight:700;color:#18181f;line-height:1.4;margin:30px 0 16px;padding-left:11px;border-left:4px solid ${ACCENT};">${inl(b.text)}</h2>`;
        }
        return `<h3 style="font-size:16px;font-weight:700;color:#2a2a31;line-height:1.5;margin:24px 0 12px;">${inl(b.text)}</h3>`;
      }
      case "paragraph":
        return `<p style="font-size:16px;line-height:1.85;color:${INK};margin:0 0 20px;letter-spacing:0.02em;">${inl(b.text)}</p>`;
      case "quote":
        return `<blockquote style="margin:0 0 20px;padding:12px 16px;background:#f7f7fb;border-left:3px solid ${ACCENT};border-radius:0 8px 8px 0;color:#55555f;font-size:15px;line-height:1.8;">${inl(b.text)}${b.source ? `<br><span style="color:${MUTED};font-size:13px;">—— ${inl(b.source)}</span>` : ""}</blockquote>`;
      case "figure_quote": {
        const avatar = b.avatarUrl
          ? `<img src="${esc(b.avatarUrl)}" alt="${esc(b.source)}" style="width:44px;height:44px;border-radius:50%;display:inline-block;margin-right:12px;vertical-align:middle;" />`
          : `<span style="display:inline-block;width:44px;height:44px;border-radius:50%;background:${ACCENT_LIGHT};color:${ACCENT_DEEP};text-align:center;line-height:44px;font-weight:700;font-size:18px;margin-right:12px;vertical-align:middle;">${esc(b.source.charAt(0) || "Q")}</span>`;
        return `<section style="margin:0 0 22px;padding:16px 18px;background:#ffffff;border:1px solid ${ACCENT_LIGHT};border-radius:12px;box-shadow:0 4px 14px rgba(91,91,214,0.08);"><p style="margin:0 0 10px;color:${INK};font-size:16px;line-height:1.8;font-style:italic;">"${inl(b.text)}"</p><div style="display:flex;align-items:center;">${avatar}<span style="color:${ACCENT_DEEP};font-weight:600;font-size:14px;">— ${esc(b.source)}</span></div></section>`;
      }
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        const items = b.items.map((it) => `<li style="font-size:16px;line-height:1.8;color:${INK};margin:0 0 8px;">${inl(it)}</li>`).join("");
        return `<${tag} style="margin:0 0 20px;padding-left:24px;">${items}</${tag}>`;
      }
      case "divider":
        return `<section style="margin:28px 0;text-align:center;color:#dcdce6;font-size:14px;letter-spacing:6px;">• • •</section>`;
      case "fancy_divider":
        return `<section style="margin:32px 0;text-align:center;color:${ACCENT};font-size:18px;letter-spacing:8px;">━━━━&nbsp;&nbsp;✦&nbsp;&nbsp;━━━━</section>`;
      case "callout": {
        const t = TONE[b.tone] ?? TONE.brand;
        return `<section style="margin:0 0 20px;padding:14px 16px;background:${t.bg};border-left:4px solid ${t.bar};border-radius:0 8px 8px 0;">${b.title ? `<p style="margin:0 0 6px;font-weight:700;color:${t.fg};font-size:15px;">${inl(b.title)}</p>` : ""}<p style="margin:0;color:${t.fg};font-size:15px;line-height:1.8;">${inl(b.text)}</p></section>`;
      }
      case "highlight": {
        const t = HIGHLIGHT_TONE[b.tone ?? "brand"];
        return `<section style="margin:0 0 22px;padding:16px 18px;background:${t.bg};border:1px solid ${t.ring};border-left:4px solid ${t.bar};border-radius:0 10px 10px 0;box-shadow:0 2px 10px ${t.ring};">${b.title ? `<p style="margin:0 0 8px;font-weight:700;color:${t.fg};font-size:16px;">⭐ ${inl(b.title)}</p>` : ""}<p style="margin:0;color:${t.fg};font-size:15.5px;line-height:1.85;font-weight:500;">${inl(b.text)}</p></section>`;
      }
      case "step": {
        const num = String(b.number).padStart(2, "0");
        return `<section style="margin:0 0 22px;padding:14px 16px;background:#ffffff;border:1px solid ${ACCENT_LIGHT};border-radius:12px;"><div style="display:flex;align-items:center;margin-bottom:10px;"><span style="display:inline-block;width:36px;height:36px;line-height:36px;text-align:center;font-family:'SF Mono',Consolas,monospace;font-size:18px;font-weight:800;color:#ffffff;background:linear-gradient(135deg,${ACCENT},${ACCENT_DEEP});border-radius:8px;margin-right:12px;">${num}</span><h3 style="margin:0;font-size:17px;font-weight:700;color:${ACCENT_DEEP};line-height:1.4;">${inl(b.title)}</h3></div>${b.text ? `<p style="margin:0;font-size:15px;line-height:1.85;color:${INK};">${inl(b.text)}</p>` : ""}</section>`;
      }
      case "table": {
        const cols = b.headers.length || 1;
        const headHtml = b.headers.map((h, i) => {
          const al = b.align?.[i] ?? "left";
          return `<th style="padding:10px 14px;text-align:${al};border-bottom:2px solid ${ACCENT};color:${ACCENT_DEEP};font-weight:700;font-size:14px;background:${ACCENT_LIGHT};">${esc(h)}</th>`;
        }).join("");
        const rowsHtml = b.rows.map((r, ri) => {
          const cells = r.map((c, ci) => {
            const al = b.align?.[ci] ?? "left";
            return `<td style="padding:10px 14px;text-align:${al};border-bottom:1px solid #ececf2;color:${INK};font-size:14.5px;line-height:1.65;">${inl(c)}</td>`;
          }).join("");
          return `<tr style="background:${ri % 2 === 0 ? "#ffffff" : "#fafafe"};">${cells}</tr>`;
        }).join("");
        void cols;
        return `<section style="margin:0 0 22px;overflow-x:auto;"><table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden;"><thead><tr>${headHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></section>`;
      }
      case "cta": {
        const labelMap: Record<string, string> = {
          comment: "留言聊聊你的看法",
          share: "转发给需要的朋友",
          follow: "点个关注不迷路",
          subscribe: "订阅以获取更新",
          buy: "点此了解 / 购买",
          save: "收藏起来慢慢看",
        };
        const label = b.text?.trim() || labelMap[b.intent] || "";
        return `<section style="margin:28px 0;text-align:center;"><span style="display:inline-block;padding:12px 26px;background:linear-gradient(135deg,${ACCENT},${ACCENT_DEEP});color:#ffffff;font-size:15px;font-weight:700;border-radius:999px;box-shadow:0 4px 14px rgba(91,91,214,0.35);">${inl(label)}</span></section>`;
      }
      case "image_slot":
        return `<section style="margin:0 0 20px;padding:28px 16px;background:#fafafe;border:1px dashed #cfcfdb;border-radius:10px;text-align:center;color:${MUTED};font-size:13px;">[ 配图占位 · ${esc(b.purpose)} ]${b.caption ? `<br>${inl(b.caption)}` : ""}${b.prompt ? `<br><span style="font-size:12px;">提示:${inl(b.prompt)}</span>` : ""}</section>`;
      default:
        return "";
    }
  },
};
