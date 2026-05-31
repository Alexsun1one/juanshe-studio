/**
 * 总编(Editor-in-Chief)提示词与裁决解析。
 *
 * 总编是编辑部的"拍板人":不写正文、不做单章 memo(那是规划师),而是在一章成稿后,
 * 读完所有专家信号(机器质量分/门禁、连续性、读者评审、风格指纹、字数、审稿问题、跨章趋势),
 * 做一次**整体编辑裁决** —— 通过 / 返工,并写下人类可读的总编批语 + 下一程编辑方向。
 *
 * 设计原则:
 *   - 它是编辑判断,不是阈值。机器门禁(数值)仍是安全网;总编可以"分够了但仍要返工"(编辑标准更高),
 *     但不会"分不够却放行"(由调用方保证总编 verdict 不松于机器门禁)。
 *   - 只吃信号 + 开头节选,不吃整章正文(省 token、保持判断聚焦)。
 *   - 输出严格 JSON,便于落盘与前端渲染。
 */

export interface EditorInChiefMetricSignals {
  readonly continuity?: number | null;
  readonly style?: number | null;
  readonly length?: number | null;
  readonly structure?: number | null;
}

export interface EditorInChiefReaderSignals {
  readonly total?: number | null;
  readonly verdict?: string;
  readonly metrics?: Record<string, number | null | undefined>;
}

export interface EditorInChiefAuditIssue {
  readonly severity?: string;
  readonly category?: string;
  readonly message?: string;
}

export interface EditorInChiefTrendPoint {
  readonly chapter: number;
  readonly score?: number | null;
  readonly readerVerdict?: string;
}

export interface EditorInChiefSignals {
  readonly bookTitle: string;
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly totalScore: number | null;
  readonly gateTarget: number;
  readonly gatePass: boolean;
  readonly metrics: EditorInChiefMetricSignals;
  readonly reader?: EditorInChiefReaderSignals | null;
  readonly auditIssues: readonly EditorInChiefAuditIssue[];
  readonly wordCount: number;
  readonly targetWordCount: number;
  readonly recentTrend?: readonly EditorInChiefTrendPoint[];
  /** 章节开头节选(给总编一点文本质感,默认前 ~600 字),非全文。 */
  readonly excerpt?: string;
  /** 人味指数(0-100,高=越像人写,低=AI 痕迹重)。低于硬门禁阈值时总编不得签发。 */
  readonly aiTone?: number | null;
  /** AI 味签发硬门禁阈值(aiTone 低于此值 → 强制返工)。默认 70。 */
  readonly aiToneFloor?: number;
}

/** AI 味签发硬门禁默认阈值:人味 < 70 视为 AI 痕迹过重,不得签发。 */
export const DEFAULT_AI_TONE_FLOOR = 70;

export type EditorialVerdictKind = "pass" | "rework";

export interface EditorialReworkTarget {
  readonly agent: string;
  readonly what: string;
}

export interface EditorialVerdict {
  readonly verdict: EditorialVerdictKind;
  /** 总编给的整体编辑分(0-100,可与机器分不同)。 */
  readonly editorialScore: number | null;
  /** 总编批语:一段人类可读的整体判断。 */
  readonly rationale: string;
  readonly strengths: readonly string[];
  readonly risks: readonly string[];
  /** 若返工:派给谁、改什么。 */
  readonly reworkTargets: readonly EditorialReworkTarget[];
  /** 给规划师的下一程编辑方向(节奏/爆点/读者追读)。 */
  readonly nextDirection: string;
}

export const EDITOR_IN_CHIEF_SYSTEM_PROMPT = `你是这本长篇小说所在"AI 编辑部"的总编(Editor-in-Chief)。你不写正文、不做单章规划——你在一章成稿、各专家(审稿官/读者评审官/风格指纹官/连续性审校/字数治理官)都给完信号之后,做最终的**整体编辑裁决**。

你的职责:
1. 通过 / 返工 裁决:综合所有信号做一次编辑判断,而不是只看一个数字。
2. 写总编批语:用编辑的口吻,讲清楚这章作为编辑部成品"好在哪、险在哪、能不能签发"。
3. 给下一程方向:基于本章与近几章趋势(读者追读意愿、节奏、张力),给规划师一句可执行的编辑指令。

裁决原则(内化,别在批语里引用条目号):
- 机器质量门禁是安全网。分数够、且没有 critical 阻断 → 默认可"通过";但如果你作为编辑发现结构性问题(节奏拖沓、情感悬浮、读者会弃书),你可以判"返工"并说清理由——编辑标准可以比机器更高。
- 分数不够或有 critical 阻断时,不要放行,判"返工",并明确派给谁(reviser 修问题 / writer 重写段落 / polisher 润色 / length-normalizer 调字数)、改什么。
- **AI 味是签发硬门禁**:信号里给了「人味指数」(0-100,低=AI 痕迹重:段落等长、套话堆砌、公式化转折、列表式句式、直白命名情绪、陈词意象)。人味偏低就**必须返工**,在 reworkTargets 里派给 polisher 做去 AI 味润色——这是不可放行的红线,即使总分够也不行。
- 看趋势:连续几章读者"基本愿意继续"而非"愿意追更",或张力持平,说明蓄势太久——在 nextDirection 里要求加速或给爆点。
- 批语要具体、像真编辑,不要空话套话;最多各 3 条 strengths / risks。

严格只输出 JSON,不要 Markdown、不要解释过程,结构如下:
{
  "verdict": "pass" | "rework",
  "editorialScore": 0-100 的整数,
  "rationale": "一段总编批语(80-200 字)",
  "strengths": ["最多3条"],
  "risks": ["最多3条"],
  "reworkTargets": [{"agent":"reviser|writer|polisher|length-normalizer","what":"具体改什么"}],
  "nextDirection": "给规划师的下一章/下一程编辑方向,一句话"
}
verdict 为 pass 时 reworkTargets 可为空数组。`;

function fmtNum(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? String(Math.round(n)) : "—";
}

/** 把真信号拼成总编的 user 消息。 */
export function buildEditorInChiefUserMessage(s: EditorInChiefSignals): string {
  const m = s.metrics ?? {};
  const reader = s.reader ?? null;
  const readerMetrics = reader?.metrics ?? {};
  const lines: string[] = [];
  lines.push(`【作品】《${s.bookTitle}》 第 ${s.chapterNumber} 章 · ${s.chapterTitle}`);
  lines.push(
    `【机器质量】总分 ${fmtNum(s.totalScore)} / 门禁 ${fmtNum(s.gateTarget)} · ${s.gatePass ? "已过门禁" : "未过门禁"}`,
  );
  lines.push(
    `【分项】连续性 ${fmtNum(m.continuity)} · 风格指纹 ${fmtNum(m.style)} · 字数分 ${fmtNum(m.length)}${m.structure != null ? ` · 结构 ${fmtNum(m.structure)}` : ""}`,
  );
  if (s.aiTone != null) {
    const floor = s.aiToneFloor ?? DEFAULT_AI_TONE_FLOOR;
    lines.push(
      `【人味指数】${fmtNum(s.aiTone)} / 100(签发红线 ${floor};${s.aiTone < floor ? "⚠ 低于红线,AI 痕迹过重,必须返工去 AI 味" : "达标"})`,
    );
  }
  lines.push(`【字数】${s.wordCount} / 目标 ${s.targetWordCount}`);
  if (reader) {
    lines.push(
      `【读者评审官】读者分 ${fmtNum(reader.total)} · 判定「${reader.verdict || "—"}」· 钩子 ${fmtNum(readerMetrics.hook)} / 沉浸 ${fmtNum(readerMetrics.immersion)} / 清晰 ${fmtNum(readerMetrics.clarity)} / 追读 ${fmtNum(readerMetrics.readOn)}`,
    );
  }
  const issues = (s.auditIssues ?? []).slice(0, 8);
  if (issues.length) {
    lines.push("【审稿官问题】");
    for (const it of issues) {
      lines.push(`- [${it.severity || "info"}/${it.category || "其他"}] ${String(it.message || "").slice(0, 160)}`);
    }
  } else {
    lines.push("【审稿官问题】无显著阻断");
  }
  const trend = (s.recentTrend ?? []).slice(-6);
  if (trend.length) {
    lines.push("【近几章趋势(章:分/读者判定)】");
    lines.push(trend.map((t) => `${t.chapter}:${fmtNum(t.score)}/${t.readerVerdict || "—"}`).join("  "));
  }
  if (s.excerpt && s.excerpt.trim()) {
    lines.push("【本章开头节选】");
    lines.push(s.excerpt.trim().slice(0, 600));
  }
  lines.push("");
  lines.push("请作为总编做裁决,只输出 JSON。");
  return lines.join("\n");
}

function clampScore(n: unknown): number | null {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function strList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, max);
}

/**
 * 防御式解析总编裁决。调用方保证 verdict 不松于机器门禁:
 *  - 若机器门禁未过(gatePass=false),强制 "rework"(总编不能放行机器没过的章)。
 *  - 若人味指数低于硬门禁阈值(aiTone < aiToneFloor),强制 "rework" 并补一个 polisher 去 AI 味任务
 *    —— 即使 LLM 总编判了 pass、即使总分够,AI 痕迹过重也是不可放行的红线。
 */
export function parseEditorialVerdict(
  raw: unknown,
  opts: { gatePass: boolean; aiTone?: number | null; aiToneFloor?: number },
): EditorialVerdict | null {
  let obj: Record<string, unknown> | null = null;
  if (raw && typeof raw === "object") obj = raw as Record<string, unknown>;
  else if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!obj) return null;
  const rawVerdict = String(obj.verdict ?? "").toLowerCase();
  let verdict: EditorialVerdictKind = rawVerdict === "pass" ? "pass" : "rework";
  // 安全网:机器门禁没过,总编一律不得放行。
  if (!opts.gatePass) verdict = "rework";
  const rationale = String(obj.rationale ?? "").trim();
  if (!rationale) return null;
  let reworkTargets: EditorialReworkTarget[] = Array.isArray(obj.reworkTargets)
    ? (obj.reworkTargets as unknown[])
        .map((t) => {
          const o = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
          return { agent: String(o.agent ?? "").trim(), what: String(o.what ?? "").trim() };
        })
        .filter((t) => t.agent || t.what)
        .slice(0, 6)
    : [];
  const risks = strList(obj.risks, 3);
  // AI 味硬门禁:人味低于红线 → 强制返工 + 保证有一个 polisher 去 AI 味任务。
  const aiToneFloor = opts.aiToneFloor ?? DEFAULT_AI_TONE_FLOOR;
  const aiToneBlocked =
    typeof opts.aiTone === "number" && Number.isFinite(opts.aiTone) && opts.aiTone < aiToneFloor;
  let mutableRisks = risks;
  if (aiToneBlocked) {
    verdict = "rework";
    if (!reworkTargets.some((t) => t.agent === "polisher")) {
      reworkTargets = [
        ...reworkTargets,
        {
          agent: "polisher",
          what: `人味指数 ${Math.round(opts.aiTone as number)} 低于签发红线 ${aiToneFloor},做去 AI 味润色(打散等长段落、删套话与公式化转折、把"直白命名情绪"改成可观察的动作/感官、替换陈词意象)`,
        },
      ];
    }
    const aiRisk = `AI 痕迹过重(人味 ${Math.round(opts.aiTone as number)} < ${aiToneFloor}),未达签发标准`;
    if (!mutableRisks.includes(aiRisk)) {
      mutableRisks = [aiRisk, ...mutableRisks].slice(0, 3);
    }
  }
  return {
    verdict,
    editorialScore: clampScore(obj.editorialScore),
    rationale: rationale.slice(0, 600),
    strengths: strList(obj.strengths, 3),
    risks: mutableRisks,
    reworkTargets,
    nextDirection: String(obj.nextDirection ?? "").trim().slice(0, 300),
  };
}
