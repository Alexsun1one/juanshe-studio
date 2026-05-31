/**
 * ContentTypeProfile —— "一个平台,做很多种内容" 的配置表。
 *
 * 用户选「做什么」(小说 / 公众号文章 / 小红书 / 知乎 / X …)→ 这里把内容类型映射到
 * 生产装配:配哪些角色(roles)、挂哪些技能(skills)、出哪些平台(platforms)。
 *
 * 本文件是**声明式蓝图**(纯数据):
 *   - skills 引用 skills/ registry 的真实 id(有测试强制存在)。
 *   - roles 是编辑部角色蓝图;novel 映射现有 15-agent pipeline,文章类角色按 §5 逐步实现后绑定。
 *   - 运行装配 / role→agent 绑定 / UI 选择 是后续层,不在本文件。
 */

import type { Platform } from "../content/ast.js";

export type ProjectType =
  | "novel"
  | "media_account"
  | "brand_content"
  | "newsletter"
  | "other";

export interface ContentTypeProfile {
  readonly id: string;
  readonly label: { readonly zh: string; readonly en: string };
  readonly description: string;
  readonly projectType: ProjectType;
  /** 参与的编辑部角色 id(蓝图)。 */
  readonly roles: readonly string[];
  /** 默认挂载的 Skill registry id(如 "style/de-ai-tone";必须真实存在)。 */
  readonly skills: readonly string[];
  /** 目标发布平台(对应 platforms/ 渲染器)。 */
  readonly platforms: readonly Platform[];
  /** 单篇字数区间提示。 */
  readonly lengthHint?: { readonly min: number; readonly max: number };
  /** true=走现有长篇引擎(novel),而非编辑部工作流。保证不破坏小说能力。 */
  readonly usesLegacyNovelPipeline?: boolean;
}

/** 现有长篇小说 pipeline 的核心角色(映射 packages/core/src/agents/*)。 */
const NOVEL_ROLES = [
  "architect",
  "planner",
  "writer",
  "reviser",
  "polisher",
  "continuity",
  "chapter-analyzer",
  "style-analyzer",
  "state-validator",
  "quality-auditor",
] as const;

/** 文章类(编辑部)角色蓝图(见 §5;部分待实现)。 */
const ARTICLE_ROLES = [
  "editor-in-chief",
  "topic-radar",
  "angle-editor",
  "researcher",
  "fact-checker",
  "outline-architect",
  "draft-writer",
  "structural-editor",
  "prose-critic",
  "style-rewriter",
  "copy-editor",
  "hook-title-editor",
  "platform-adapter",
  "layout-designer",
  "compliance-reviewer",
  "quality-auditor",
  "prompt-governor",
] as const;

const SHORT_ROLES = [
  "topic-radar",
  "angle-editor",
  "draft-writer",
  "style-rewriter",
  "platform-adapter",
  "compliance-reviewer",
  "prompt-governor",
] as const;

export const CONTENT_TYPE_PROFILES: readonly ContentTypeProfile[] = [
  {
    id: "novel",
    label: { zh: "长篇小说", en: "Novel" },
    description: "多智能体长篇连载:建书→规划→写作→审稿→修订→落库,质量门禁全程把关。",
    projectType: "novel",
    roles: NOVEL_ROLES,
    skills: [],
    platforms: [],
    lengthHint: { min: 2000, max: 6000 },
    usesLegacyNovelPipeline: true,
  },
  {
    id: "wechat_article",
    label: { zh: "公众号文章", en: "WeChat Article" },
    description: "深度/观点/故事长文:选题→角度→资料→大纲→初稿→结构/风格编辑→平台适配→精排→审核。",
    projectType: "media_account",
    roles: ARTICLE_ROLES,
    skills: ["style/kazike-narrative", "style/de-ai-tone", "platform/wechat-longform"],
    platforms: ["wechat"],
    lengthHint: { min: 1800, max: 6500 },
  },
  {
    id: "xiaohongshu_note",
    label: { zh: "小红书笔记", en: "Xiaohongshu Note" },
    description: "移动端速读图文:强痛点标题、前 3 行抓人、短段、可收藏、话题标签。",
    projectType: "media_account",
    roles: SHORT_ROLES,
    skills: ["style/de-ai-tone", "platform/xiaohongshu-note"],
    platforms: ["xiaohongshu"],
    lengthHint: { min: 250, max: 1200 },
  },
  {
    id: "zhihu_answer",
    label: { zh: "知乎回答", en: "Zhihu Answer" },
    description: "问题导向、论证充分、案例与可信度优先,少营销腔。",
    projectType: "media_account",
    roles: ARTICLE_ROLES,
    skills: ["style/de-ai-tone"],
    platforms: ["zhihu"],
    lengthHint: { min: 800, max: 4000 },
  },
  {
    id: "x_thread",
    label: { zh: "X / Twitter thread", en: "X Thread" },
    description: "强 hook、短句、每条独立可读、连续观点、结尾行动。",
    projectType: "media_account",
    roles: SHORT_ROLES,
    skills: ["style/de-ai-tone"],
    platforms: ["x"],
    lengthHint: { min: 100, max: 1500 },
  },
  {
    id: "newsletter",
    label: { zh: "Newsletter", en: "Newsletter" },
    description: "邮件订阅长文/专栏信:主题清晰、首屏摘要、段落克制、可转发、结尾有订阅或回复 CTA。",
    projectType: "newsletter",
    roles: ARTICLE_ROLES,
    skills: ["style/de-ai-tone", "platform/newsletter"],
    platforms: ["newsletter"],
    lengthHint: { min: 1000, max: 3500 },
  },
];

export function listContentTypeProfiles(): readonly ContentTypeProfile[] {
  return CONTENT_TYPE_PROFILES;
}

export function getContentTypeProfile(id: string): ContentTypeProfile | undefined {
  return CONTENT_TYPE_PROFILES.find((p) => p.id === id);
}
