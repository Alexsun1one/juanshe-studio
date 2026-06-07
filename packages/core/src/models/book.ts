import { z } from "zod";

export const PlatformSchema = z.enum(["tomato", "feilu", "qidian", "other"]);
export type Platform = z.infer<typeof PlatformSchema>;

export function normalizePlatformId(platform: unknown): Platform | undefined {
  if (typeof platform !== "string") {
    return undefined;
  }

  const raw = platform.trim();
  if (!raw) {
    return undefined;
  }

  const lowered = raw.toLowerCase();
  const compact = lowered.replace(/[\s_-]+/g, "");

  if (compact === "tomato" || compact === "fanqie" || compact === "fanqienovel" || raw.includes("番茄")) {
    return "tomato";
  }
  if (compact === "qidian" || compact === "qidianzhongwenwang" || raw.includes("起点")) {
    return "qidian";
  }
  if (compact === "feilu" || raw.includes("飞卢")) {
    return "feilu";
  }
  if (compact === "other" || compact === "others" || raw.includes("其他") || raw.includes("其它")) {
    return "other";
  }

  return "other";
}

export function normalizePlatformOrOther(platform: unknown): Platform {
  return normalizePlatformId(platform) ?? "other";
}

export const GenreSchema = z.string().min(1);
export type Genre = z.infer<typeof GenreSchema>;

export const BookStatusSchema = z.enum([
  "incubating",
  "outlining",
  "active",
  "paused",
  "completed",
  "dropped",
]);
export type BookStatus = z.infer<typeof BookStatusSchema>;

export const FanficModeSchema = z.enum(["canon", "au", "ooc", "cp"]);
export type FanficMode = z.infer<typeof FanficModeSchema>;

export const BookConfigSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  platform: PlatformSchema,
  genre: GenreSchema,
  status: BookStatusSchema,
  targetChapters: z.number().int().min(1).default(200),
  chapterWordCount: z.number().int().min(1000).default(3000),
  language: z.enum(["zh", "en"]).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  parentBookId: z.string().optional(),
  fanficMode: FanficModeSchema.optional(),
  /** 用户的原始命题/核心承诺（题材、主角身份、核心爽点、长期目标）。
      建书时写入，是全书最高优先级的"主设定保真锚点"——每章写作都重申，
      防止"局部场景合理、全局题材/人设漂移"（如都市言情写着写着变成网络安全惊悚）。
      之前只存在 book.json 但被 schema 剥掉，下游（planner/writer）都看不到 → 漂移失控根因之一。 */
  brief: z.string().optional(),
  /** 用户为本书设定的达标分数（60-98）。默认 90（出版级）；
      <90 时 craft-floor / 89 封顶降级为提示，让已发布章节也能 pass。
      所有 repair/batch/write 默认走这个值；前端 ChapterQualityPanel 写入。 */
  qualityTargetScore: z.number().int().min(60).max(98).optional(),
});

export type BookConfig = z.infer<typeof BookConfigSchema>;
