/**
 * 故事框架解析(knowledge/)—— outline/story_frame.md 是权威世界观源(散文 `## 段N` + 顶部 YAML frontmatter)。
 * 世界观「法则」以散文枚举存在(段3:"世界铁律有六条。第一,… 第二,…"),这里把它提取成列表;
 * 同时切出主题/冲突/底色/终局分节。**势力/道具未 itemized**(该存没存),由调用方另取(hooks/wiki)。
 */

export interface StoryFrameSection {
  readonly title: string;
  readonly body: string;
}

export interface ParsedStoryFrame {
  /** 顶部 YAML frontmatter 原文(去 --- 围栏);无则空串。 */
  readonly frontmatter: string;
  readonly sections: readonly StoryFrameSection[];
  /** 世界铁律枚举(第一…第二…)。 */
  readonly worldRules: readonly string[];
}

function splitFrontmatter(md: string): { frontmatter: string; body: string } {
  const m = md.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) return { frontmatter: (m[1] ?? "").trim(), body: m[2] ?? "" };
  return { frontmatter: "", body: md };
}

function splitSections(body: string): StoryFrameSection[] {
  const lines = body.split(/\r?\n/);
  const sections: StoryFrameSection[] = [];
  let title = "";
  let buf: string[] = [];
  const flush = () => {
    if (title) sections.push({ title, body: buf.join("\n").trim() });
  };
  for (const line of lines) {
    const h = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (h) {
      flush();
      title = (h[1] ?? "").trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

/** 从含"铁律"的段落里把"第一,…第二,…"枚举拆成规则列表。 */
function extractWorldRules(md: string): string[] {
  const paras = md.split(/\r?\n\s*\r?\n/);
  const para = paras.find((p) => /铁律|世界规则|世界观/.test(p) && /第一[，,、]/.test(p));
  if (!para) return [];
  const idx = para.search(/第一[，,、]/);
  if (idx < 0) return [];
  return para
    .slice(idx)
    .split(/第[一二三四五六七八九十]+[，,、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseStoryFrame(md: string): ParsedStoryFrame {
  if (!md || !md.trim()) return { frontmatter: "", sections: [], worldRules: [] };
  const { frontmatter, body } = splitFrontmatter(md);
  return {
    frontmatter,
    sections: splitSections(body),
    worldRules: extractWorldRules(md),
  };
}

/** 便捷:按标题关键词找一节(主题/冲突/底色/终局)。 */
export function findSection(frame: ParsedStoryFrame, keyword: string): StoryFrameSection | undefined {
  return frame.sections.find((s) => s.title.includes(keyword));
}
