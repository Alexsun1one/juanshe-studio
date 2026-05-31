import { BaseAgent } from "./base.js";

/**
 * StyleGovernorAgent — 风格指纹官(LLM 版本)
 *
 * 跟 `style-analyzer.ts`(纯统计/数值指纹)互补:
 *   - style-analyzer: 量化(平均句长 / 段落形状 / 词频),建书时算一次"作者声音"基线
 *   - style-governor:LLM 阅读本章 + 跟基线 + 跟前 N 章对比,**判断风格漂移**
 *
 * 4 个维度:
 *   1. voice_match(声音匹配度) — 跟"作者声音"基线是不是一脉相承
 *   2. tone_drift(语气漂移) — 跟前 N 章对比,语气有没有突变(过冷/过爆/过 AI)
 *   3. diction(用词层) — 词汇分布、用词丰富度、AI 标记词浓度
 *   4. cadence(节奏) — 长短句、段落形状、动作 vs 描写比例
 *
 * 输出 4 维 × 1-10 分 + drift_warnings 列表(具体漂移点)。
 */

export interface StyleGovernorInput {
  readonly chapterContent: string;
  readonly chapterNumber: number;
  /** 作者声音基线(从 style-analyzer 输出/手动设的"作者声音"段落)*/
  readonly voiceBaseline?: string;
  /** 前 N 章的精选样本(2-3 段),让 LLM 跟"近期作品"比 */
  readonly recentSamples?: ReadonlyArray<{ chapter: number; excerpt: string }>;
  readonly language?: "zh" | "en";
  readonly temperature?: number;
}

export interface StyleGovernorDimension {
  readonly score: number;
  readonly notes: string;
}

export interface StyleGovernorOutput {
  readonly voiceMatch: StyleGovernorDimension;
  readonly toneDrift: StyleGovernorDimension;
  readonly diction: StyleGovernorDimension;
  readonly cadence: StyleGovernorDimension;
  readonly overall: number;
  /** 具体的漂移点,可直接交给 reviser 修(空表示无漂移)*/
  readonly driftWarnings: ReadonlyArray<string>;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export class StyleGovernorAgent extends BaseAgent {
  get name(): string {
    return "style-governor";
  }

  async assess(input: StyleGovernorInput): Promise<StyleGovernorOutput> {
    const isEnglish = input.language === "en";
    const systemPrompt = isEnglish ? buildEnglishSystem() : buildChineseSystem();

    const baselineBlock = input.voiceBaseline
      ? isEnglish
        ? `\n\n## Author Voice Baseline (from style-analyzer at book setup)\n${input.voiceBaseline}`
        : `\n\n## 作者声音基线(建书时由 style-analyzer 抽取)\n${input.voiceBaseline}`
      : "";
    const samplesBlock = input.recentSamples && input.recentSamples.length > 0
      ? isEnglish
        ? `\n\n## Recent Chapter Samples (for tone-drift comparison)\n${input.recentSamples.map((s) => `### Ch ${s.chapter}\n${s.excerpt}`).join("\n\n")}`
        : `\n\n## 近期章节样本(用于语气漂移对比)\n${input.recentSamples.map((s) => `### 第 ${s.chapter} 章\n${s.excerpt}`).join("\n\n")}`
      : "";

    const chapterBlock = isEnglish
      ? `## Chapter ${input.chapterNumber} Under Review\n${input.chapterContent}`
      : `## 第 ${input.chapterNumber} 章待审风格\n${input.chapterContent}`;
    const taskBlock = isEnglish
      ? `\n\nScore this chapter on 4 style dimensions and list any concrete drift warnings.${baselineBlock}${samplesBlock}`
      : `\n\n请对本章按 4 个风格维度打分(1-10),并列出具体的漂移点。${baselineBlock}${samplesBlock}`;

    const response = await this.chat(
      [
        { role: "system", content: [{ text: systemPrompt, cache: true }] },
        { role: "user", content: [
          { text: chapterBlock, cache: true },
          { text: taskBlock },
        ] },
      ],
      { temperature: input.temperature ?? 0.2 },  // 风格评估要稳定,低温
    );

    const parsed = parseStyleGovernorOutput(response.content);
    return {
      ...parsed,
      tokenUsage: response.usage,
    };
  }
}

// ─── 解析 ───────────────────────────────────────────────────────────────

const ZERO_DIM: StyleGovernorDimension = { score: 5, notes: "" };

function parseStyleGovernorOutput(raw: string): Omit<StyleGovernorOutput, "tokenUsage"> {
  const json = extractJson(raw);
  if (!json) {
    return {
      voiceMatch: { ...ZERO_DIM, notes: "style-governor output not valid JSON" },
      toneDrift: ZERO_DIM,
      diction: ZERO_DIM,
      cadence: ZERO_DIM,
      overall: 5,
      driftWarnings: ["LLM 输出 schema 不匹配,请检查 prompt 或上游 LLM 行为"],
    };
  }
  const dim = (k1: string, k2?: string): StyleGovernorDimension => {
    const v = json[k1] ?? (k2 ? json[k2] : undefined);
    if (!v || typeof v !== "object") return ZERO_DIM;
    const score = clampScore((v as Record<string, unknown>).score);
    const notes = String((v as Record<string, unknown>).notes ?? "").slice(0, 280);
    return { score, notes };
  };
  const voiceMatch = dim("voiceMatch", "voice_match");
  const toneDrift = dim("toneDrift", "tone_drift");
  const diction = dim("diction");
  const cadence = dim("cadence");
  const overall = Number(((voiceMatch.score + toneDrift.score + diction.score + cadence.score) / 4).toFixed(1));
  const warnings = json.driftWarnings ?? json.drift_warnings ?? [];
  const driftWarnings = Array.isArray(warnings)
    ? warnings.map((w) => String(w).slice(0, 280)).filter(Boolean).slice(0, 12)
    : [];
  return { voiceMatch, toneDrift, diction, cadence, overall, driftWarnings };
}

function clampScore(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(10, Math.round(n)));
}

function extractJson(raw: string): Record<string, unknown> | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1] ?? raw;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first < 0 || last < first) return null;
  try {
    return JSON.parse(candidate.slice(first, last + 1));
  } catch {
    return null;
  }
}

// ─── prompts ────────────────────────────────────────────────────────────

function buildChineseSystem(): string {
  return `你是「风格指纹官」(LLM 版本)。你的工作是:**确保章节风格不漂移**。

## 跟其他 agent 的边界

- 审稿官关心:逻辑/连续性/规则
- 读者评审官关心:读不读爽
- **你只关心:风格 — 跟作者声音基线和最近章节比,这章有没有突然变腔**

## 4 个评分维度(1-10,7+ 合格)

1. **声音匹配度(voiceMatch)**:跟"作者声音基线"对比,这章是不是同一个写手写的?
   - 看:语气、视角、情绪密度、叙述距离
   - 漂移信号:基线偏冷克制 vs 本章突然热血煽情;基线偏 wry 幽默 vs 本章变正剧
2. **语气漂移(toneDrift)**:跟最近 2-3 章对比,语气有没有突变?
   - 看:开头几段的"情感温度";段落节奏快慢
   - 漂移信号:前几章节奏稳,本章突然急吼吼;前几章生活流,本章突然爽文化
3. **用词(diction)**:词汇分布、用词丰富度、AI 标记词浓度
   - 看:转折词频率("但是/然而/不过")、情绪中介词("仿佛/宛如/竟然/不禁")、形容词地毯
   - 漂移信号:AI 标记词超过基线 2 倍以上;形容词重复度高
4. **节奏(cadence)**:长短句搭配、段落形状、动作 vs 描写比例
   - 看:连续同结构句、段落是不是都 5-7 行(机械感)、动作和心理描写比例
   - 漂移信号:连续 5+ 句同主语开头;全段都心理活动没动作;段落都是 7 行

## 评分尺

- **10**:跟基线一脉相承,有亮点延伸,没漂移
- **8-9**:稳,1 个小苗头(可忽略)
- **7**:基本同框,合格但可以再收一下 — 合格线
- **5-6**:明显感觉是同一作者但状态不在
- **3-4**:像换了人写,或者像被 LLM 接管
- **1-2**:严重漂移,跟前几章完全不像

## drift_warnings(具体漂移点)

列出本章具体漂移的句子/段落,每条最多 280 字符。reviser 会拿这些去修。
没漂移就空数组。

## 输出契约

只返回 JSON,不要其他文字。结构:

\`\`\`json
{
  "voiceMatch":  { "score": 8, "notes": "<1 句话:声音对不对>" },
  "toneDrift":   { "score": 9, "notes": "<1 句话:跟前章对比>" },
  "diction":     { "score": 7, "notes": "<1 句话:词汇/AI 味浓度>" },
  "cadence":     { "score": 8, "notes": "<1 句话:节奏感>" },
  "driftWarnings": ["<具体漂移点 1>", "<具体漂移点 2>"]
}
\`\`\`

**严格但讲理**。漂移点要指到具体句子或段落,不要泛泛的"风格不一致"。`;
}

function buildEnglishSystem(): string {
  return `You are the Style Governor (LLM version). Your job: **detect style drift**.

## Boundary vs other agents

- Continuity auditor cares about logic / continuity / rules
- Reader critic cares about engagement
- **You only care about style — does this chapter sound like the same writer compared to baseline and recent chapters?**

## 4 dimensions (1-10, 7+ = pass)

1. **voiceMatch** — same writer voice as the baseline? (tone, POV, narrative distance)
2. **toneDrift** — sudden tone shift from recent chapters?
3. **diction** — vocabulary distribution, AI-tell density (transition words, hedge phrases, adjective carpet)
4. **cadence** — sentence variety, paragraph shape, action vs description ratio

## Score calibration

- 10: dead-on baseline, on-brand, no drift
- 7: passable, mild drift — pass line
- 3-4: feels like a different writer or LLM took over
- 1-2: severe drift

## driftWarnings

List concrete drift sentences/paragraphs (max 280 chars each). Reviser will use these.

## Output contract — JSON only

\`\`\`json
{
  "voiceMatch":  { "score": 8, "notes": "..." },
  "toneDrift":   { "score": 9, "notes": "..." },
  "diction":     { "score": 7, "notes": "..." },
  "cadence":     { "score": 8, "notes": "..." },
  "driftWarnings": ["...", "..."]
}
\`\`\``;
}
