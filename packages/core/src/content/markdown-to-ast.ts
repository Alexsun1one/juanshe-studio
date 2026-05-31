/**
 * 轻量 Markdown → Content AST。
 *
 * 基础:#/##/### 标题、> 引用、-/1. 列表、--- 分割线、段落。
 * 扩展(B8):
 *   - `:::callout info`...`:::`        callout(tone: info/warning/success/danger/brand)
 *   - `:::highlight brand`...`:::`     重点段卡(tone: brand/warm/cool/neutral)
 *   - `:::step 1 标题`\n内容`:::`      step 步骤卡
 *   - `> source: 出处 | https://avatar.url`(quote 最后一行)→ figure_quote
 *   - `| col |\n|---|\n| ... |`        markdown 表格
 *   - `~~~` / `* * *`                  fancy_divider(ornate)
 *   - `## Step 1: 标题`                step 简写
 */

import type { ContentBlock, ContentDocument } from "./ast.js";

const HR = /^\s*([-_])\1{2,}\s*$/;
const FANCY_HR = /^\s*\*\s*\*\s*\*\s*$|^\s*~{3,}\s*$/;
const HEADING = /^(#{1,3})\s+(.*\S)\s*$/;
const QUOTE = /^>\s?(.*)$/;
const QUOTE_SOURCE = /^source\s*[::]\s*(.+?)(?:\s*\|\s*(https?:\/\/\S+))?\s*$/i;
const UL = /^[-*+]\s+(.*\S)\s*$/;
const OL = /^\d+[.)]\s+(.*\S)\s*$/;
const FENCE_OPEN = /^:::\s*(callout|highlight|step)\s*(.*?)\s*$/;
const FENCE_CLOSE = /^:::\s*$/;
const STEP_INLINE = /^step\s+(\d+)\s*(?:[::]\s*)?(.*)$/i;
const TABLE_ROW = /^\|(.+)\|\s*$/;
const TABLE_SEP = /^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

type Tone = "info" | "warning" | "success" | "danger" | "brand";
type HighlightTone = "brand" | "warm" | "cool" | "neutral";

const VALID_TONES: Tone[] = ["info", "warning", "success", "danger", "brand"];
const VALID_HL_TONES: HighlightTone[] = ["brand", "warm", "cool", "neutral"];

export function markdownToContentDocument(
  markdown: string,
  meta?: ContentDocument["metadata"],
): ContentDocument {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: ContentBlock[] = [];

  let para: string[] = [];
  let listItems: string[] = [];
  let listOrdered = false;
  let inList = false;
  let quoteBuf: string[] = [];
  let title: string | undefined;

  let fenceKind: "callout" | "highlight" | "step" | null = null;
  let fenceArgs = "";
  let fenceBuf: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: "paragraph", text: para.join(" ").trim() });
      para = [];
    }
  };
  const flushList = () => {
    if (inList && listItems.length) {
      blocks.push({ type: "list", ordered: listOrdered, items: [...listItems] });
    }
    listItems = [];
    inList = false;
  };
  const flushQuote = () => {
    if (quoteBuf.length === 0) return;
    const lastIdx = quoteBuf.length - 1;
    const last = quoteBuf[lastIdx];
    const srcMatch = QUOTE_SOURCE.exec(last);
    if (srcMatch && quoteBuf.length > 1) {
      const text = quoteBuf.slice(0, lastIdx).join(" ").trim();
      blocks.push({
        type: "figure_quote",
        text,
        source: srcMatch[1].trim(),
        ...(srcMatch[2] ? { avatarUrl: srcMatch[2] } : {}),
      });
    } else {
      blocks.push({ type: "quote", text: quoteBuf.join(" ").trim() });
    }
    quoteBuf = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  const closeFence = () => {
    if (!fenceKind) return;
    const text = fenceBuf.join("\n").trim();
    if (fenceKind === "callout") {
      const tone = (VALID_TONES.find((t) => fenceArgs.toLowerCase().includes(t)) ?? "brand") as Tone;
      const titleMatch = fenceArgs.match(/title\s*[::]\s*(.+)$/);
      blocks.push({ type: "callout", tone, text, ...(titleMatch ? { title: titleMatch[1].trim() } : {}) });
    } else if (fenceKind === "highlight") {
      const tone = (VALID_HL_TONES.find((t) => fenceArgs.toLowerCase().includes(t)) ?? "brand") as HighlightTone;
      const titleMatch = fenceArgs.match(/title\s*[::]\s*(.+)$/);
      blocks.push({ type: "highlight", text, tone, ...(titleMatch ? { title: titleMatch[1].trim() } : {}) });
    } else if (fenceKind === "step") {
      const m = STEP_INLINE.exec(fenceArgs.trim()) || /^(\d+)\s+(.+)$/.exec(fenceArgs.trim());
      const number = m ? Number(m[1]) || 1 : 1;
      const stepTitle = m ? (m[2] ?? "").trim() : fenceArgs.trim();
      blocks.push({ type: "step", number, title: stepTitle, text });
    }
    fenceKind = null;
    fenceArgs = "";
    fenceBuf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");

    if (fenceKind) {
      if (FENCE_CLOSE.test(line.trim())) {
        closeFence();
      } else {
        fenceBuf.push(raw);
      }
      continue;
    }

    const fenceOpen = FENCE_OPEN.exec(line.trim());
    if (fenceOpen) {
      flushAll();
      fenceKind = fenceOpen[1] as "callout" | "highlight" | "step";
      fenceArgs = fenceOpen[2] ?? "";
      fenceBuf = [];
      continue;
    }

    // 表格(本行 `| col |` + 下行分隔线)
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1].trim())) {
      flushAll();
      const headers = parseTableRow(line);
      const sep = lines[i + 1].trim();
      const align = parseTableAlign(sep);
      i += 1;
      const rows: string[][] = [];
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1].trim())) {
        rows.push(parseTableRow(lines[i + 1].trim()));
        i += 1;
      }
      blocks.push({ type: "table", headers, rows, align });
      continue;
    }

    if (line.trim() === "") {
      flushAll();
      continue;
    }
    if (HR.test(line)) {
      flushAll();
      blocks.push({ type: "divider" });
      continue;
    }
    if (FANCY_HR.test(line)) {
      flushAll();
      blocks.push({ type: "fancy_divider", style: "ornate" });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flushAll();
      const level = h[1].length as 1 | 2 | 3;
      const text = h[2].trim();
      if (level === 1 && !title) {
        title = text;
        continue;
      }
      const sm = STEP_INLINE.exec(text);
      if (sm && level >= 2) {
        blocks.push({
          type: "step",
          number: Number(sm[1]) || 1,
          title: (sm[2] ?? "").trim() || `Step ${sm[1]}`,
          text: "",
        });
        continue;
      }
      blocks.push({ type: "heading", level, text });
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      flushPara();
      flushList();
      quoteBuf.push(q[1].trim());
      continue;
    } else if (quoteBuf.length > 0) {
      flushQuote();
    }
    const ol = OL.exec(line);
    const ul = UL.exec(line);
    if (ol || ul) {
      flushPara();
      flushQuote();
      const ordered = Boolean(ol);
      if (!inList || listOrdered !== ordered) {
        flushList();
        inList = true;
        listOrdered = ordered;
      }
      listItems.push((ol ?? ul)![1].trim());
      continue;
    }
    flushList();
    flushQuote();
    para.push(line.trim());
  }
  if (fenceKind) closeFence();
  flushAll();

  return { title, blocks, metadata: meta };
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((s) => s.trim());
}

function parseTableAlign(sepLine: string): ("left" | "center" | "right")[] {
  const cells = sepLine.replace(/^\|/, "").replace(/\|$/, "").split("|").map((s) => s.trim());
  return cells.map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    if (l && r) return "center";
    if (r) return "right";
    return "left";
  });
}
