/**
 * 编辑部文章流水线(第3层 editorial/)—— 把单次生成升级成「生成 → 评审 → 修订」小循环所需的
 * 提示词构造与评审解析。**纯函数,不调 LLM**;真正的 LLM 调用由 studio 端点用 core 的 llm 抽象完成。
 *
 * 评审方法蒸馏自 haowjy/creative-writing-skills 的 prose-critique(Apache-2.0):
 * 对抗式阅读「找哪里不成立」,按 critical/significant/minor 分级,每条可定位、有理由、可执行。
 */

import type { ContentTypeProfile } from "../content-type/profile.js";

export type CritiqueSeverity = "critical" | "significant" | "minor";

export interface CritiqueIssue {
  readonly severity: CritiqueSeverity;
  /** 定位:段落 / 句子 / 小标题。 */
  readonly where: string;
  /** 问题:它让读者付出什么代价。 */
  readonly problem: string;
  /** 可执行修改建议。 */
  readonly fix: string;
}

export interface CritiqueReport {
  /** 一句话总体判断。 */
  readonly overall: string;
  readonly issues: readonly CritiqueIssue[];
  /** 整体质量分(0-100);模型未给则 null。用于多轮"复评分→低于阈值再修"。 */
  readonly score: number | null;
  /** 是否成功解析模型 JSON(false = 降级,调用方可跳过修订)。 */
  readonly parsed: boolean;
}

/** 多轮评审-修订的默认通过线(综合质量分);可被调用方覆盖。 */
export const DEFAULT_ARTICLE_PASS_SCORE = 85;

const SEVERITIES: readonly CritiqueSeverity[] = ["critical", "significant", "minor"];

function platformCriticChecklist(profile: ContentTypeProfile): string {
  const platform = profile.platforms[0];
  if (platform === "wechat") {
    return [
      "公众号专项:",
      "- 标题/前 3 段是否有真实钩子,还是只在交代背景。",
      "- H2 是否能串起主线;是否每 600-900 字有一次节奏换气。",
      "- 重点块是否克制(2-4 个),有没有把每段都包装成卡片。",
      "- 是否有摘要、封面建议或可复制到编辑器的结构。",
    ].join("\n");
  }
  if (platform === "xiaohongshu") {
    return [
      "小红书专项:",
      "- 标题是否 1 秒内说明收益/痛点/反差,前 3 行是否直接抓人。",
      "- 正文是否短段可扫读,是否有一个值得收藏的清单/步骤/模板。",
      "- 标签是否集中在末尾且覆盖搜索词+场景词,有没有乱堆热门词。",
      "- 有没有公众号式长段、复杂 Markdown、假亲历或过密 emoji。",
    ].join("\n");
  }
  if (platform === "newsletter") {
    return [
      "Newsletter 专项:",
      "- 首屏摘要是否说明本期主题与读者收益。",
      "- 小标题是否便于邮件扫读;段落是否短而完整。",
      "- 结尾是否有轻 CTA(回复/转发/订阅),而不是硬广。",
    ].join("\n");
  }
  if (platform === "zhihu") {
    return [
      "知乎专项:",
      "- 是否先回答问题,再展开论证;有没有避开营销腔。",
      "- 事实/案例/引用是否可核实,不确定处是否标注。",
      "- 结论是否能经受反驳,而不是只堆态度。",
    ].join("\n");
  }
  return "";
}

/** 评审官系统提示:对抗式 prose 评审,只输出 JSON。 */
export function buildCriticSystemPrompt(profile: ContentTypeProfile): string {
  const platformChecklist = platformCriticChecklist(profile);
  return [
    `你是「${profile.label.zh}」的资深评审编辑。对抗式阅读:找出**哪里不成立**,而不是夸哪里好——作者已经认为稿子可以了,你的职责是挑战这个假设。`,
    "",
    "评审维度(按对该平台的伤害排序):",
    "- 结构:逻辑、节奏、信息密度、铺垫与兑现。",
    "- 声音:开头是否抓人、是否有 AI 腔、句式是否同构、是否 telling 而非 showing。",
    "- 真实性:有没有空泛拔高、含糊归因、编造的具体细节。",
    "- 平台适配:是否贴合该平台读者的阅读习惯。",
    platformChecklist ? `\n${platformChecklist}` : "",
    "",
    "每条问题必须:可定位(指到段落 / 句子)、有理由(说清让读者付出什么代价)、可执行(作者读完知道怎么改)。只报你能落到具体读者代价的问题。",
    "按严重度分级:critical(破坏阅读 / 硬伤,必须改)、significant(明显削弱)、minor(可改可不改)。",
    "",
    "再给一个整体质量分 score(0-100):90+=可直接发布,85-89=小修即可,70-84=有明显问题需改,<70=结构性问题需重写。",
    "",
    "只输出 JSON,不要 Markdown,不要解释。结构:",
    `{"overall":"一句话总体判断","score":0,"issues":[{"severity":"critical|significant|minor","where":"定位","problem":"读者代价","fix":"可执行修改"}]}`,
    "如果稿子确实没有值得改的问题,返回空 issues 数组(但 score 仍要给)。",
  ].join("\n");
}

/** 修订官系统提示:按评审意见修订 + 去 AI 腔,保事实 / 结构不变,只输出正文 Markdown。 */
export function buildReviserSystemPrompt(input: {
  readonly profile: ContentTypeProfile;
  readonly skillPrompt: string;
}): string {
  const { profile, skillPrompt } = input;
  const parts = [
    `你是「${profile.label.zh}」的修订编辑。任务:按评审意见修订稿子,优先处理 critical 与 significant。`,
    "硬约束:",
    "- 只改表达与被点名的问题,**不改变核心事实、信息与结构骨架**(除非评审明确要求结构改动)。",
    "- 同时执行去 AI 腔:删意义注水 / purple prose / 命名情绪 / 句式同构 / 对话腔泄漏。",
    "- 平台形态不能修坏:公众号保留可精排结构;小红书保持短段、标签与收藏结构;Newsletter 保留邮件扫读节奏。",
    "- 不编造亲历、数据、案例、来源或平台规则;缺来源的具体断言要改成可承担的观察/判断。",
    "- 直接输出修订后的正文 Markdown,不要任何解释、不要「以下是修订版」之类的话、不要用代码块包裹整篇。",
  ];
  if (skillPrompt) parts.push("", skillPrompt);
  return parts.join("\n");
}

/** 把评审 LLM 的原始输出容错解析成 CritiqueReport。 */
export function parseCritiqueReport(raw: string): CritiqueReport {
  const empty = (parsed: boolean, overall = ""): CritiqueReport => ({ overall, issues: [], score: null, parsed });
  if (!raw || !raw.trim()) return empty(false);
  const obj = extractFirstJsonObject(raw);
  if (!obj || typeof obj !== "object") return empty(false, raw.trim().slice(0, 400));
  const rec = obj as Record<string, unknown>;
  const overall = typeof rec.overall === "string" ? rec.overall.trim() : "";
  const scoreNum = Number(rec.score);
  const score = Number.isFinite(scoreNum) ? Math.max(0, Math.min(100, scoreNum)) : null;
  const rawIssues = Array.isArray(rec.issues) ? rec.issues : [];
  const issues: CritiqueIssue[] = [];
  for (const it of rawIssues) {
    if (!it || typeof it !== "object") continue;
    const r = it as Record<string, unknown>;
    const sev = String(r.severity ?? "").toLowerCase();
    const severity: CritiqueSeverity = SEVERITIES.includes(sev as CritiqueSeverity)
      ? (sev as CritiqueSeverity)
      : "minor";
    const where = typeof r.where === "string" ? r.where.trim() : "";
    const problem = typeof r.problem === "string" ? r.problem.trim() : "";
    const fix = typeof r.fix === "string" ? r.fix.trim() : "";
    if (!problem && !fix) continue;
    issues.push({ severity, where, problem, fix });
  }
  return { overall, issues, score, parsed: true };
}

/** 评审是否值得触发修订(有 critical/significant)。 */
export function critiqueWantsRevision(report: CritiqueReport): boolean {
  if (!report.parsed) return false;
  return report.issues.some((i) => i.severity === "critical" || i.severity === "significant");
}

/**
 * 稿子是否已达标(可停止多轮循环):解析成功 + 无 critical + (分数缺失则看无 significant;有分数则 ≥ 阈值)。
 * 用于「评审 → 修订 → 复评分,低于阈值再修一轮」。
 */
export function critiquePasses(report: CritiqueReport, threshold: number = DEFAULT_ARTICLE_PASS_SCORE): boolean {
  if (!report.parsed) return true; // 解析失败 → 无法判定,停止循环(交还当前稿,不空转)
  if (report.issues.some((i) => i.severity === "critical")) return false;
  if (report.score == null) {
    return !report.issues.some((i) => i.severity === "significant");
  }
  return report.score >= threshold;
}

function extractFirstJsonObject(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fence) t = (fence[1] ?? t).trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through to brace slice */
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      /* ignore */
    }
  }
  return null;
}
