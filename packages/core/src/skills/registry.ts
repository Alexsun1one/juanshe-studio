/**
 * Skill Registry 加载器 —— 读取 skills/ 下的能力库。
 *
 * 轻量、确定性、无第三方依赖:列出 / 读取 skill 文件,解析标题与来源署名。
 * 为「风格编辑 / 平台适配 Agent 运行时挂载 Skill」打底;完整的 prompt 注入是后续步骤。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type SkillCategory = "style" | "platform" | "genre" | "layout" | "editorial";

export const SKILL_CATEGORIES: readonly SkillCategory[] = [
  "style",
  "platform",
  "genre",
  "layout",
  "editorial",
];

export interface SkillMeta {
  /** 形如 "style/de-ai-tone" */
  readonly id: string;
  readonly category: SkillCategory;
  /** 文件名(无扩展名) */
  readonly name: string;
  /** 一级标题(去掉 "Skill: " 前缀) */
  readonly title: string;
  /** 引用块里的来源/署名行(若有) */
  readonly source?: string;
  /** 绝对路径 */
  readonly path: string;
}

export interface Skill extends SkillMeta {
  readonly content: string;
}

function parseTitle(content: string, fallback: string): string {
  const m = content.match(/^#\s+(.*\S)\s*$/m);
  if (!m) return fallback;
  return m[1].replace(/^Skill:\s*/i, "").trim();
}

function parseSource(content: string): string | undefined {
  const m = content.match(/^>\s*\*\*(?:来源\/署名|来源|参考)\*\*[：:]?\s*(.*\S)\s*$/m)
    ?? content.match(/^>\s*(?:来源|参考)[：:]\s*(.*\S)\s*$/m);
  return m ? m[1].trim() : undefined;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** 列出 skillsDir 下所有 skill 的元信息(可按 category 过滤)。 */
export async function listSkills(
  skillsDir: string,
  category?: SkillCategory,
): Promise<SkillMeta[]> {
  const cats = category ? [category] : SKILL_CATEGORIES;
  const out: SkillMeta[] = [];
  for (const cat of cats) {
    const catDir = join(skillsDir, cat);
    if (!(await dirExists(catDir))) continue;
    const files = (await readdir(catDir)).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const path = join(catDir, file);
      const name = file.replace(/\.md$/, "");
      let content = "";
      try {
        content = await readFile(path, "utf-8");
      } catch {
        continue;
      }
      out.push({
        id: `${cat}/${name}`,
        category: cat,
        name,
        title: parseTitle(content, name),
        source: parseSource(content),
        path,
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 按 id（"style/de-ai-tone"）读取单个 skill 全文。 */
export async function loadSkill(skillsDir: string, id: string): Promise<Skill | null> {
  const [category, name] = id.split("/");
  if (!category || !name || !SKILL_CATEGORIES.includes(category as SkillCategory)) {
    return null;
  }
  const path = join(skillsDir, category, `${name}.md`);
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  return {
    id,
    category: category as SkillCategory,
    name,
    title: parseTitle(content, name),
    source: parseSource(content),
    path,
    content,
  };
}
