/**
 * Literary 文艺号 — 深灰墨色、宋体、留白多、装饰极简。
 * 适合:散文/评论/书评/影评/随笔。
 */

import type { WechatTemplate } from "./types.js";
import { esc, inline } from "./types.js";

const ACCENT = "#3C3633";
const ACCENT_DEEP = "#1A1614";
const ACCENT_LIGHT = "#F2EFEA";
const INK = "#1A1614";
const MUTED = "#7A7066";
const PAPER = "#FBF9F5";

const TONE: Record<string, { bar: string; bg: string; fg: string }> = {
  info: { bar: "#506B82", bg: "#EAEFF4", fg: "#2E4858" },
  warning: { bar: "#A07730", bg: "#F5EBD8", fg: "#664A1C" },
  success: { bar: "#5C7A52", bg: "#E8EFE3", fg: "#3A4F32" },
  danger: { bar: "#8A3838", bg: "#F4E3E3", fg: "#5C2424" },
  brand: { bar: ACCENT, bg: ACCENT_LIGHT, fg: ACCENT_DEEP },
};

const HIGHLIGHT_TONE: Record<string, { bg: string; fg: string }> = {
  brand: { bg: ACCENT_LIGHT, fg: ACCENT_DEEP },
  warm: { bg: "#F5EBD8", fg: "#664A1C" },
  cool: { bg: "#EAEFF4", fg: "#2E4858" },
  neutral: { bg: "#F0EEEA", fg: "#3C3633" },
};

const inl = (s: string) => inline(s, { highlightColor: "#E8DCC0", accent: ACCENT });

export const literaryTemplate: WechatTemplate = {
  id: "literary",
  label: "文艺号",
  tagline: "宋体墨色 · 留白克制 · 适合散文/书评",
  shell() {
    return {
      rootStyle: `font-family:'PingFang SC','Songti SC','Source Han Serif SC',Georgia,serif;font-size:16px;color:${INK};line-height:2.0;max-width:640px;margin:0 auto;padding:8px 8px;background:${PAPER};`,
      titleStyle: `display:block;font-size:24px;font-weight:400;color:${INK};text-align:center;margin:30px 0 4px;letter-spacing:0.12em;line-height:1.5;font-family:'Songti SC','Source Han Serif SC',Georgia,serif;`,
      subtitleStyle: `font-size:13px;color:${MUTED};margin:0 0 36px;line-height:1.6;text-align:center;letter-spacing:0.2em;font-style:italic;`,
    };
  },
  renderBlock(b) {
    switch (b.type) {
      case "heading": {
        if (b.level === 1) return `<h1 style="font-size:21px;font-weight:600;color:${INK};margin:38px 0 18px;text-align:center;letter-spacing:0.1em;">— ${inl(b.text)} —</h1>`;
        if (b.level === 2) return `<h2 style="font-size:18px;font-weight:600;color:${ACCENT_DEEP};margin:32px 0 16px;letter-spacing:0.05em;">${inl(b.text)}</h2>`;
        return `<h3 style="font-size:16px;font-weight:600;color:${ACCENT};margin:24px 0 12px;font-style:italic;">| ${inl(b.text)}</h3>`;
      }
      case "paragraph":
        return `<p style="font-size:16px;line-height:2.0;color:${INK};margin:0 0 22px;letter-spacing:0.05em;text-indent:2em;">${inl(b.text)}</p>`;
      case "quote":
        return `<blockquote style="margin:0 0 24px;padding:18px 24px;color:${ACCENT_DEEP};font-size:16px;line-height:1.95;text-align:center;font-style:italic;border-top:1px solid ${ACCENT_LIGHT};border-bottom:1px solid ${ACCENT_LIGHT};">「 ${inl(b.text)} 」${b.source ? `<br><br><span style="color:${MUTED};font-size:13px;font-style:normal;letter-spacing:0.1em;">— ${inl(b.source)}</span>` : ""}</blockquote>`;
      case "figure_quote": {
        return `<section style="margin:0 0 28px;padding:18px 24px;background:#fff;border-top:1px solid ${ACCENT};border-bottom:1px solid ${ACCENT};text-align:center;"><p style="margin:0 0 12px;color:${INK};font-size:17px;line-height:2.0;font-style:italic;letter-spacing:0.04em;">「 ${inl(b.text)} 」</p><span style="color:${MUTED};font-weight:400;font-size:13px;letter-spacing:0.1em;">— ${esc(b.source)}</span></section>`;
      }
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        const items = b.items.map((it) => `<li style="font-size:16px;line-height:1.95;color:${INK};margin:0 0 10px;">${inl(it)}</li>`).join("");
        return `<${tag} style="margin:0 0 22px;padding-left:24px;">${items}</${tag}>`;
      }
      case "divider":
        return `<section style="margin:36px 0;text-align:center;color:${ACCENT};font-size:14px;letter-spacing:12px;">·</section>`;
      case "fancy_divider":
        return `<section style="margin:42px 0;text-align:center;color:${ACCENT};font-size:16px;letter-spacing:10px;">~ • ~</section>`;
      case "callout": {
        const t = TONE[b.tone] ?? TONE.brand;
        return `<section style="margin:0 0 22px;padding:14px 18px;background:${t.bg};border-left:2px solid ${t.bar};color:${t.fg};font-size:15px;line-height:1.9;">${b.title ? `<p style="margin:0 0 6px;font-weight:600;letter-spacing:0.04em;">${inl(b.title)}</p>` : ""}<p style="margin:0;">${inl(b.text)}</p></section>`;
      }
      case "highlight": {
        const t = HIGHLIGHT_TONE[b.tone ?? "brand"];
        return `<section style="margin:0 0 24px;padding:20px 24px;background:${t.bg};text-align:center;letter-spacing:0.04em;">${b.title ? `<p style="margin:0 0 10px;font-weight:600;color:${t.fg};font-size:14px;letter-spacing:0.15em;">${inl(b.title)}</p>` : ""}<p style="margin:0;color:${t.fg};font-size:15.5px;line-height:1.95;font-style:italic;">${inl(b.text)}</p></section>`;
      }
      case "step": {
        return `<section style="margin:0 0 24px;padding:14px 18px;background:#fff;"><div style="margin-bottom:8px;"><span style="display:inline-block;font-family:'Songti SC',Georgia,serif;font-size:14px;color:${MUTED};letter-spacing:0.15em;margin-right:14px;">其 ${b.number}</span><span style="font-size:17px;font-weight:600;color:${INK};">${inl(b.title)}</span></div>${b.text ? `<p style="margin:0;font-size:15.5px;line-height:1.95;color:${INK};text-indent:2em;">${inl(b.text)}</p>` : ""}</section>`;
      }
      case "table": {
        const head = b.headers.map((h, i) => {
          const al = b.align?.[i] ?? "left";
          return `<th style="padding:10px 14px;text-align:${al};border-bottom:1px solid ${ACCENT};color:${ACCENT_DEEP};font-weight:600;font-size:14px;letter-spacing:0.05em;">${esc(h)}</th>`;
        }).join("");
        const rows = b.rows.map((r) => {
          const cells = r.map((c, ci) => {
            const al = b.align?.[ci] ?? "left";
            return `<td style="padding:10px 14px;text-align:${al};border-bottom:1px solid ${ACCENT_LIGHT};color:${INK};font-size:14.5px;">${inl(c)}</td>`;
          }).join("");
          return `<tr>${cells}</tr>`;
        }).join("");
        return `<section style="margin:0 0 24px;overflow-x:auto;"><table style="width:100%;border-collapse:collapse;">${head ? `<thead><tr>${head}</tr></thead>` : ""}<tbody>${rows}</tbody></table></section>`;
      }
      case "cta": {
        const map: Record<string, string> = { comment: "聊几句", share: "转给愿意读的朋友", follow: "下一篇见", subscribe: "持续关注", buy: "了解", save: "存档" };
        const label = b.text?.trim() || map[b.intent] || "";
        return `<section style="margin:36px 0;text-align:center;"><span style="display:inline-block;padding:8px 24px;color:${ACCENT_DEEP};font-size:14px;font-weight:400;border-top:1px solid ${ACCENT};border-bottom:1px solid ${ACCENT};letter-spacing:0.15em;">${inl(label)}</span></section>`;
      }
      case "image_slot":
        return `<section style="margin:0 0 24px;padding:40px 18px;background:#fff;text-align:center;color:${MUTED};font-size:12px;letter-spacing:0.2em;">[ ${esc(b.purpose)} ]${b.caption ? `<br>${inl(b.caption)}` : ""}</section>`;
      default:
        return "";
    }
  },
};
