/**
 * Story 故事号 — 暖橙调、段落首字下沉、装饰分割,引文小卡像台词卡。
 * 适合:小说连载/人物特写/纪实故事。
 */

import type { WechatTemplate } from "./types.js";
import { esc, inline } from "./types.js";

const ACCENT = "#D97706";
const ACCENT_DEEP = "#8A4F00";
const ACCENT_LIGHT = "#FFF3DC";
const INK = "#26221C";
const MUTED = "#8B7E68";
const PAPER = "#FFFBF2";

const TONE: Record<string, { bar: string; bg: string; fg: string }> = {
  info: { bar: "#0EA5E9", bg: "#EAF6FC", fg: "#0B6C93" },
  warning: { bar: ACCENT, bg: ACCENT_LIGHT, fg: ACCENT_DEEP },
  success: { bar: "#16A34A", bg: "#E7F6ED", fg: "#0F7A37" },
  danger: { bar: "#E5484D", bg: "#FCEBEC", fg: "#A3262B" },
  brand: { bar: ACCENT, bg: ACCENT_LIGHT, fg: ACCENT_DEEP },
};

const HIGHLIGHT_TONE: Record<string, { bg: string; fg: string }> = {
  brand: { bg: ACCENT_LIGHT, fg: ACCENT_DEEP },
  warm: { bg: "#FDEEDD", fg: "#7A3D00" },
  cool: { bg: "#EAF1F8", fg: "#1F4F7A" },
  neutral: { bg: "#F2EFE8", fg: "#3A3528" },
};

const inl = (s: string) => inline(s, { highlightColor: "#FFD97A", accent: ACCENT });

export const storyTemplate: WechatTemplate = {
  id: "story",
  label: "故事号",
  tagline: "暖橙古典 · 首字下沉 · 适合故事/连载",
  shell() {
    return {
      rootStyle: `font-family:'PingFang SC','Songti SC','Source Han Serif SC',Georgia,serif;font-size:16px;color:${INK};line-height:1.95;max-width:677px;margin:0 auto;padding:8px 4px;background:${PAPER};`,
      titleStyle: `display:block;font-size:26px;font-weight:700;color:${INK};text-align:center;margin:18px 0 6px;letter-spacing:0.05em;line-height:1.4;`,
      subtitleStyle: `font-size:14px;color:${MUTED};margin:0 0 26px;line-height:1.6;text-align:center;letter-spacing:0.08em;`,
    };
  },
  renderBlock(b, index) {
    switch (b.type) {
      case "heading": {
        if (b.level === 1) return `<h1 style="font-size:22px;font-weight:700;color:${INK};margin:34px 0 18px;text-align:center;">『 ${inl(b.text)} 』</h1>`;
        if (b.level === 2) return `<h2 style="font-size:19px;font-weight:700;color:${ACCENT_DEEP};margin:30px 0 16px;padding-left:14px;border-left:4px solid ${ACCENT};">${inl(b.text)}</h2>`;
        return `<h3 style="font-size:17px;font-weight:700;color:${INK};margin:24px 0 12px;font-style:italic;">${inl(b.text)}</h3>`;
      }
      case "paragraph": {
        // 首段首字下沉(古典报刊感)
        const isFirst = index === 0;
        if (isFirst && b.text.length > 6) {
          const first = b.text.charAt(0);
          const rest = b.text.slice(1);
          return `<p style="font-size:16.5px;line-height:1.95;color:${INK};margin:0 0 20px;letter-spacing:0.03em;"><span style="float:left;font-size:48px;line-height:0.9;color:${ACCENT_DEEP};padding:6px 8px 0 0;font-weight:700;font-family:'Songti SC',Georgia,serif;">${esc(first)}</span>${inl(rest)}</p>`;
        }
        return `<p style="font-size:16.5px;line-height:1.95;color:${INK};margin:0 0 20px;letter-spacing:0.03em;text-indent:2em;">${inl(b.text)}</p>`;
      }
      case "quote":
        return `<blockquote style="margin:0 0 22px;padding:14px 18px 14px 22px;background:${ACCENT_LIGHT};border-left:3px double ${ACCENT_DEEP};color:${ACCENT_DEEP};font-size:16px;line-height:1.9;font-style:italic;">「 ${inl(b.text)} 」${b.source ? `<br><span style="color:${MUTED};font-size:13px;font-style:normal;">—— ${inl(b.source)}</span>` : ""}</blockquote>`;
      case "figure_quote": {
        const initial = esc(b.source.charAt(0) || "○");
        const avatar = b.avatarUrl
          ? `<img src="${esc(b.avatarUrl)}" alt="${esc(b.source)}" style="width:48px;height:48px;border-radius:50%;display:inline-block;margin-right:12px;vertical-align:middle;border:2px solid ${ACCENT};" />`
          : `<span style="display:inline-block;width:48px;height:48px;border-radius:50%;background:${ACCENT};color:#fff;text-align:center;line-height:48px;font-weight:700;font-size:20px;margin-right:12px;vertical-align:middle;font-family:'Songti SC',serif;">${initial}</span>`;
        return `<section style="margin:0 0 24px;padding:18px 20px;background:#fff;border:1px solid ${ACCENT_LIGHT};border-radius:10px;box-shadow:0 4px 12px rgba(217,119,6,0.10);position:relative;"><span style="position:absolute;top:8px;left:14px;font-size:38px;color:${ACCENT};line-height:1;font-family:Georgia,serif;opacity:0.4;">"</span><p style="margin:0 0 12px 16px;color:${INK};font-size:16px;line-height:1.85;font-style:italic;">${inl(b.text)}</p><div style="display:flex;align-items:center;border-top:1px dashed ${ACCENT_LIGHT};padding-top:10px;">${avatar}<span style="color:${ACCENT_DEEP};font-weight:700;font-size:14px;font-family:'Songti SC',serif;">— ${esc(b.source)}</span></div></section>`;
      }
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        const items = b.items.map((it) => `<li style="font-size:16px;line-height:1.85;color:${INK};margin:0 0 8px;">${inl(it)}</li>`).join("");
        return `<${tag} style="margin:0 0 20px;padding-left:28px;">${items}</${tag}>`;
      }
      case "divider":
        return `<section style="margin:30px 0;text-align:center;color:${ACCENT};font-size:16px;letter-spacing:8px;">~ · ~</section>`;
      case "fancy_divider":
        return `<section style="margin:36px 0;text-align:center;color:${ACCENT_DEEP};font-size:18px;letter-spacing:8px;">━━ ❀ ━━</section>`;
      case "callout": {
        const t = TONE[b.tone] ?? TONE.brand;
        return `<section style="margin:0 0 22px;padding:14px 18px;background:${t.bg};border-left:3px solid ${t.bar};border-radius:0 6px 6px 0;">${b.title ? `<p style="margin:0 0 6px;font-weight:700;color:${t.fg};font-size:15.5px;">${inl(b.title)}</p>` : ""}<p style="margin:0;color:${t.fg};font-size:15px;line-height:1.85;">${inl(b.text)}</p></section>`;
      }
      case "highlight": {
        const t = HIGHLIGHT_TONE[b.tone ?? "brand"];
        return `<section style="margin:0 0 22px;padding:16px 20px;background:${t.bg};border-radius:8px;text-align:center;">${b.title ? `<p style="margin:0 0 8px;font-weight:700;color:${t.fg};font-size:15.5px;letter-spacing:0.06em;">— ${inl(b.title)} —</p>` : ""}<p style="margin:0;color:${t.fg};font-size:15.5px;line-height:1.9;font-style:italic;">${inl(b.text)}</p></section>`;
      }
      case "step": {
        return `<section style="margin:0 0 22px;padding:14px 18px;background:#fff;border:1px solid ${ACCENT_LIGHT};border-radius:8px;"><div style="display:flex;align-items:center;margin-bottom:10px;"><span style="display:inline-block;font-family:'Songti SC',serif;font-size:24px;font-weight:700;color:${ACCENT};margin-right:14px;">第 ${b.number} 章</span><h3 style="margin:0;font-size:17px;font-weight:700;color:${INK};">${inl(b.title)}</h3></div>${b.text ? `<p style="margin:0;font-size:15.5px;line-height:1.9;color:${INK};text-indent:2em;">${inl(b.text)}</p>` : ""}</section>`;
      }
      case "table": {
        const head = b.headers.map((h, i) => {
          const al = b.align?.[i] ?? "left";
          return `<th style="padding:10px 14px;text-align:${al};border-bottom:2px solid ${ACCENT};color:${ACCENT_DEEP};font-weight:700;font-size:14px;">${esc(h)}</th>`;
        }).join("");
        const rows = b.rows.map((r) => {
          const cells = r.map((c, ci) => {
            const al = b.align?.[ci] ?? "left";
            return `<td style="padding:10px 14px;text-align:${al};border-bottom:1px solid #ECE2D0;color:${INK};font-size:14.5px;">${inl(c)}</td>`;
          }).join("");
          return `<tr>${cells}</tr>`;
        }).join("");
        return `<section style="margin:0 0 22px;overflow-x:auto;"><table style="width:100%;border-collapse:collapse;">${head ? `<thead><tr>${head}</tr></thead>` : ""}<tbody>${rows}</tbody></table></section>`;
      }
      case "cta": {
        const map: Record<string, string> = { comment: "评论区告诉我你的故事", share: "转发给故事里的他/她", follow: "听我继续讲下去", subscribe: "追更", buy: "了解更多", save: "收藏慢读" };
        const label = b.text?.trim() || map[b.intent] || "";
        return `<section style="margin:30px 0;text-align:center;"><span style="display:inline-block;padding:10px 24px;background:${ACCENT};color:#fff;font-size:15px;font-weight:600;border-radius:4px;letter-spacing:0.04em;">${inl(label)}</span></section>`;
      }
      case "image_slot":
        return `<section style="margin:0 0 22px;padding:36px 18px;background:#fff;border:1px dashed ${ACCENT};border-radius:6px;text-align:center;color:${MUTED};font-size:13px;font-family:'Songti SC',serif;">[ 配图 · ${esc(b.purpose)} ]${b.caption ? `<br>${inl(b.caption)}` : ""}</section>`;
      default:
        return "";
    }
  },
};
