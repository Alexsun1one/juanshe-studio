import { BaseAgent } from "./base.js";
import type { ChapterMemo } from "../models/input-governance.js";

/**
 * ReaderCriticAgent — 读者评审官
 *
 * 跟 ContinuityAuditor(审稿官)的"逻辑/连续性/规则"视角互补,
 * 这个 agent 假装自己是一个**真读者**,只回答 4 个问题:
 *   1. 沉浸感(immersion):有没有被拽进去?哪里出戏?
 *   2. 期待感(anticipation):读完想不想点下一章?为什么?
 *   3. 动机清晰度(motivation):主角这章为什么做这事?读者看懂了吗?
 *   4. 情感共鸣(emotional):有没有让我"嗯"一下的瞬间?
 *
 * 不评连续性/事实/字数 — 那是审稿官的事。
 * 输出 4 个维度 × 1-10 分 + overall + verdict + 一段 reader voice(第一人称)。
 *
 * 用法:在 review-cycle 之后,作为"高质量模式"开关触发;Anthropic prompt caching
 * 复用 chapter content,token 成本低。
 */

export interface ReaderCriticInput {
  readonly chapterContent: string;
  readonly chapterNumber: number;
  readonly chapterMemo?: ChapterMemo;
  /** 上一章末尾的"读者期待"概要,用于"上钩有没有兑现"评估(可选) */
  readonly prevHookSummary?: string;
  readonly language?: "zh" | "en";
  readonly temperature?: number;
}

export interface ReaderCriticDimension {
  readonly score: number;    // 1-10
  readonly notes: string;    // 一句话原因
}

export interface ReaderCriticOutput {
  readonly immersion: ReaderCriticDimension;
  readonly anticipation: ReaderCriticDimension;
  readonly motivation: ReaderCriticDimension;
  readonly emotional: ReaderCriticDimension;
  /** 4 维平均 → overall(1-10) */
  readonly overall: number;
  /** verdict:pass = ≥ 7,otherwise needs-revise */
  readonly verdict: "pass" | "needs-revise";
  /** "我是读者"第一人称感受,1-2 句话 */
  readonly readerVoice: string;
  /** 必须修的具体点(LLM 写,空表示没痛点) */
  readonly painPoints: ReadonlyArray<string>;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export class ReaderCriticAgent extends BaseAgent {
  get name(): string {
    return "reader-critic";
  }

  async assess(input: ReaderCriticInput): Promise<ReaderCriticOutput> {
    const isEnglish = input.language === "en";
    const systemPrompt = isEnglish ? buildEnglishSystem() : buildChineseSystem();

    const memoBlock = input.chapterMemo
      ? isEnglish
        ? `\n\n## Chapter Memo (what writer was promising)\n${input.chapterMemo.body}`
        : `\n\n## 章节备忘(写手承诺要兑现的)\n${input.chapterMemo.body}`
      : "";
    const hookBlock = input.prevHookSummary
      ? isEnglish
        ? `\n\n## Previous chapter's hook (did this chapter pay it off?)\n${input.prevHookSummary}`
        : `\n\n## 上一章末的钩子(本章兑现了吗?)\n${input.prevHookSummary}`
      : "";

    const chapterBlock = isEnglish
      ? `## Chapter ${input.chapterNumber} (read as a real reader)\n${input.chapterContent}`
      : `## 第 ${input.chapterNumber} 章正文(假装你是真读者读完)\n${input.chapterContent}`;
    const taskBlock = isEnglish
      ? `\n\nScore the chapter on 4 reader-facing dimensions and write a 1-2 sentence first-person reaction.${memoBlock}${hookBlock}`
      : `\n\n请对本章按 4 个读者视角维度打分(1-10),并写一段 1-2 句的第一人称感受。${memoBlock}${hookBlock}`;

    const response = await this.chat(
      [
        // system 标 cache — 长读者评审规则,跨多章复用
        { role: "system", content: [{ text: systemPrompt, cache: true }] },
        { role: "user", content: [
          { text: chapterBlock, cache: true },  // chapter cache:同章 reaudit / multi-pass 复用
          { text: taskBlock },
        ] },
      ],
      { temperature: input.temperature ?? 0.6 },  // 略高:鼓励"真读者"风的话
    );

    const parsed = parseReaderCriticOutput(response.content);
    return {
      ...parsed,
      tokenUsage: response.usage,
    };
  }
}

// ─── 输出 schema 解析 ────────────────────────────────────────────────────

const ZERO_DIM: ReaderCriticDimension = { score: 5, notes: "" };

function parseReaderCriticOutput(raw: string): Omit<ReaderCriticOutput, "tokenUsage"> {
  // 期待格式:JSON 块。但 LLM 经常返回带前后缀的 JSON,做容错。
  const json = extractJson(raw);
  if (!json) {
    return fallback("reader-critic output not a valid JSON object");
  }
  const dim = (k: string): ReaderCriticDimension => {
    const v = json[k];
    if (!v || typeof v !== "object") return ZERO_DIM;
    const score = clampScore((v as Record<string, unknown>).score);
    const notes = String((v as Record<string, unknown>).notes ?? "").slice(0, 240);
    return { score, notes };
  };
  const immersion = dim("immersion");
  const anticipation = dim("anticipation");
  const motivation = dim("motivation");
  const emotional = dim("emotional");
  const overall = Number(((immersion.score + anticipation.score + motivation.score + emotional.score) / 4).toFixed(1));
  const verdict: "pass" | "needs-revise" = overall >= 7 ? "pass" : "needs-revise";
  const readerVoice = String(json.readerVoice ?? json.reader_voice ?? "").slice(0, 320);
  const painPointsRaw = json.painPoints ?? json.pain_points ?? [];
  const painPoints = Array.isArray(painPointsRaw)
    ? painPointsRaw.map((p) => String(p).slice(0, 240)).filter(Boolean).slice(0, 8)
    : [];
  return { immersion, anticipation, motivation, emotional, overall, verdict, readerVoice, painPoints };
}

function fallback(reason: string): Omit<ReaderCriticOutput, "tokenUsage"> {
  return {
    immersion: { ...ZERO_DIM, notes: reason },
    anticipation: ZERO_DIM,
    motivation: ZERO_DIM,
    emotional: ZERO_DIM,
    overall: 5,
    verdict: "needs-revise",
    readerVoice: "",
    painPoints: [reason],
  };
}

function clampScore(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(10, Math.round(n)));
}

function extractJson(raw: string): Record<string, unknown> | null {
  // 1) ```json ... ``` 块
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1] ?? raw;
  // 2) 找第一个 { 到最后一个 }
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first < 0 || last < first) return null;
  try {
    return JSON.parse(candidate.slice(first, last + 1));
  } catch {
    return null;
  }
}

// ─── prompts ─────────────────────────────────────────────────────────────

function buildChineseSystem(): string {
  return `你是「读者评审官」—— 一位代表真实付费读者的评审人。

## 你的视角(不同于审稿官)

审稿官在乎逻辑、连续性、事实、字数、规则。**你不在乎那些**,你只在乎一件事:**作为读者,我读爽了吗?**

## 4 个评分维度(1-10 分,7 分以上才合格)

1. **沉浸感(immersion)**:这章读着有没有被拽进去?有没有"觉得自己在场"的瞬间?哪里出戏(说教/旁白/AI 味)?
2. **期待感(anticipation)**:读完想不想立刻点下一章?写手有没有埋好钩子?上一章的钩子兑现了吗?
3. **动机清晰度(motivation)**:主角这章为什么做这些事?读者第一遍能看懂吗?有没有"莫名其妙"或"为了推进而推进"?
4. **情感共鸣(emotional)**:有没有让你"嗯"一下/"我懂"/"心头一紧"的瞬间?具体在哪段?

## 评分尺(校准用)

- **10**:看到尾巴会立刻找下一章,有金句/名场面
- **8-9**:读起来稳,有 1-2 个亮点
- **7**:能读完,没让我合上 — 合格线
- **5-6**:读到一半想刷手机
- **3-4**:出戏严重 / 莫名其妙
- **1-2**:看不下去 / 弃文

## reader voice(第一人称感受)

写 1-2 句"我作为读者读完这章的真实感觉",可以带情绪,可以挑刺,可以夸。**不要写"本章如何如何"那种第三人称评论。**

例:
- "读到她终于把那封信烧掉的那一下,我心里咯噔一下。但中段那段回忆插叙有点长,我跳读了。"
- "前半段节奏特别好,但后半段那个'终于明白了什么是力量'的旁白让我出戏。"

## pain points(必须修的具体点)

如果有让读者出戏 / 看不懂 / 跳读的具体位置,列出来(最多 8 条)。没问题就空数组。

## 输出契约

只返回 JSON,不要其他任何文字。结构:

\`\`\`json
{
  "immersion":     { "score": 8, "notes": "<1 句话:被什么拽住或被什么出戏>" },
  "anticipation":  { "score": 7, "notes": "<1 句话:章末钩子工不工>" },
  "motivation":    { "score": 9, "notes": "<1 句话:主角动机清不清>" },
  "emotional":     { "score": 8, "notes": "<1 句话:哪段有触动>" },
  "readerVoice":   "<1-2 句第一人称感受>",
  "painPoints":    ["<具体出戏点 1>", "<具体出戏点 2>"]
}
\`\`\`

记住:你代表 100 个会扫码付费的真读者。**严格但讲理**。`;
}

function buildEnglishSystem(): string {
  return `You are the Reader Critic — a stand-in for real paying readers.

## Your perspective (different from the continuity auditor)

The auditor cares about logic, continuity, facts, length, rules. **You don't care about those.** You care about one thing: **as a reader, did I enjoy this?**

## 4 scoring dimensions (1-10, 7+ = pass)

1. **immersion** — did the chapter pull you in? where did it break the spell (preaching / narrator voiceover / AI tells)?
2. **anticipation** — do you want to click "next chapter" immediately? did the previous hook get paid off?
3. **motivation** — why did the protagonist do these things? clear on first read?
4. **emotional** — any "hm" / "I feel that" / "ouch" moments? where exactly?

## Score calibration

- **10**: would binge next chapter immediately, has gold-line moments
- **8-9**: steady read with 1-2 highlights
- **7**: I finished, didn't close — pass line
- **5-6**: scrolling phone halfway through
- **3-4**: broke immersion / confusing
- **1-2**: drop the book

## reader voice (first person)

1-2 sentences of how you actually felt. Subjective, with emotion. **No third-person "this chapter is X" critique.**

## Output contract

Return ONLY JSON:

\`\`\`json
{
  "immersion":    { "score": 8, "notes": "..." },
  "anticipation": { "score": 7, "notes": "..." },
  "motivation":   { "score": 9, "notes": "..." },
  "emotional":    { "score": 8, "notes": "..." },
  "readerVoice":  "...",
  "painPoints":   ["...", "..."]
}
\`\`\``;
}
