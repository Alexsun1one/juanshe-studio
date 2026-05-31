/**
 * 卷舍 · 引擎数据模型(第一层 / 全新实现)
 *
 * 这里定义"一个 AI 编辑部写作产品"在运行时需要管理的核心实体:
 * 发布平台、题材、作品、章节、质量评分、LLM 接入配置、编辑部角色。
 * 全部用 zod 描述,既得到运行时校验,又顺带导出 TS 类型(单一事实来源)。
 *
 * 设计原则:数据形状服务于"产品要做的事",不是任何上游实现的镜像。
 */
import { z } from "zod"

// ─────────────────────────────────────────────────────────────
// 发布平台 —— 内容最终要投向哪
// ─────────────────────────────────────────────────────────────
export const PLATFORM_IDS = [
  "wechat", // 公众号
  "xiaohongshu", // 小红书
  "zhihu", // 知乎
  "x", // X / Twitter
  "newsletter", // 邮件通讯
  "webnovel", // 网文连载站(起点等)
  "generic", // 通用 / 未指定
] as const
export const PlatformId = z.enum(PLATFORM_IDS)
export type PlatformId = z.infer<typeof PlatformId>

export const Platform = z.object({
  id: PlatformId,
  label: z.string(),
  /** 该平台单篇的建议字数区间(用于"合身"判断) */
  lengthRange: z.tuple([z.number().int(), z.number().int()]).optional(),
  /** 该平台的体裁倾向描述(给适配层参考) */
  formatHint: z.string().optional(),
})
export type Platform = z.infer<typeof Platform>

// ─────────────────────────────────────────────────────────────
// 题材 —— 决定写作风格与读者预期的赛道
// ─────────────────────────────────────────────────────────────
export const Genre = z.object({
  id: z.string(),
  name: z.string(),
  /** 写作语言 */
  language: z.enum(["zh", "en"]).default("zh"),
  /** 赛道一句话定位(用于规划与风格基线) */
  premise: z.string().optional(),
})
export type Genre = z.infer<typeof Genre>

// ─────────────────────────────────────────────────────────────
// LLM 接入配置 —— BYOK:用户自带 key
// ─────────────────────────────────────────────────────────────
export const LlmConfig = z.object({
  provider: z.string(), // openai-compatible / anthropic / deepseek / ...
  model: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** 额外请求头 / 透传参数 */
  extraHeaders: z.record(z.string(), z.string()).optional(),
})
export type LlmConfig = z.infer<typeof LlmConfig>

// ─────────────────────────────────────────────────────────────
// 质量评分 —— 多维度 + 综合分(决定能否签发/续写)
// ─────────────────────────────────────────────────────────────
export const QualityScore = z.object({
  overall: z.number().min(0).max(100),
  dimensions: z.object({
    consistency: z.number().min(0).max(100), // 一致性
    pacing: z.number().min(0).max(100), // 节奏感
    emotion: z.number().min(0).max(100), // 情感张力
    prose: z.number().min(0).max(100), // 文笔质量
    deAiTell: z.number().min(0).max(100), // 去 AI 味
  }),
  /** 达标门槛(默认 85);overall ≥ 它即视为可签发 */
  passThreshold: z.number().min(0).max(100).default(85),
})
export type QualityScore = z.infer<typeof QualityScore>

// ─────────────────────────────────────────────────────────────
// 章节
// ─────────────────────────────────────────────────────────────
export const ChapterStatus = z.enum([
  "planned", // 已规划未写
  "drafting", // 写作中
  "revising", // 修订中
  "done", // 完成
  "blocked", // 卡在质量线
])
export type ChapterStatus = z.infer<typeof ChapterStatus>

export const Chapter = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  content: z.string().default(""),
  wordCount: z.number().int().nonnegative().default(0),
  status: ChapterStatus.default("planned"),
  quality: QualityScore.optional(),
  updatedAt: z.string().optional(), // ISO
})
export type Chapter = z.infer<typeof Chapter>

// ─────────────────────────────────────────────────────────────
// 作品(配置 + 运行态)
// ─────────────────────────────────────────────────────────────
export const BookStatus = z.enum([
  "creating", // 建书中(架构生成)
  "ready", // 可写作
  "writing", // 写作进行中
  "needs-foundation", // 缺地基(架构未完成)
  "stuck", // 建书中断
  "failed", // 失败
])
export type BookStatus = z.infer<typeof BookStatus>

export const Book = z.object({
  id: z.string(),
  title: z.object({ zh: z.string(), en: z.string().optional() }),
  genreId: z.string(),
  platform: PlatformId.default("generic"),
  status: BookStatus.default("creating"),
  /** 单章目标字数 */
  chapterWordCount: z.number().int().positive().default(3000),
  /** 续写/批量的过线分(与 QualityScore.passThreshold 对齐) */
  targetScore: z.number().min(0).max(100).default(85),
  /** 计划总章数(0 = 未设) */
  plannedChapters: z.number().int().nonnegative().default(0),
  createdAt: z.string().optional(),
})
export type Book = z.infer<typeof Book>

// ─────────────────────────────────────────────────────────────
// 项目(产品的顶层容器;小说是第一个项目类型)
// ─────────────────────────────────────────────────────────────
export const ProjectType = z.enum(["novel"]) // 后续可扩展:article / serial ...
export type ProjectType = z.infer<typeof ProjectType>

export const Project = z.object({
  id: z.string(),
  type: ProjectType.default("novel"),
  rootDir: z.string(), // 本地工作区路径
  llm: LlmConfig.optional(),
})
export type Project = z.infer<typeof Project>

// ─────────────────────────────────────────────────────────────
// 编辑部角色(引擎层只关心 id 与职责;UI 文案在前端)
// ─────────────────────────────────────────────────────────────
// 与 agents/prompts.ts(工作流产出)对齐的后端角色 ID;与现有前端映射层一致
export const AGENT_ROLE_IDS = [
  "market-radar", "architect", "foundation-reviewer",
  "planner", "writer", "chapter-analyzer",
  "continuity-reviewer", "reader-critic", "quality-reporter",
  "reviser", "length-governor", "polisher",
  "style-governor", "managing-editor", "editor-in-chief",
] as const
export const AgentRoleId = z.enum(AGENT_ROLE_IDS)
export type AgentRoleId = z.infer<typeof AgentRoleId>
