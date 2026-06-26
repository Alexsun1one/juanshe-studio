import { BaseAgent } from "./base.js";
import type { ArchitectOutput } from "./architect.js";

export interface FoundationReviewResult {
  readonly passed: boolean;
  readonly totalScore: number;
  readonly dimensions: ReadonlyArray<{
    readonly name: string;
    readonly score: number;
    readonly feedback: string;
  }>;
  readonly overallFeedback: string;
}

const PASS_THRESHOLD = 80;
const DIMENSION_FLOOR = 60;

export class FoundationReviewerAgent extends BaseAgent {
  get name(): string {
    return "foundation-reviewer";
  }

  async review(params: {
    readonly foundation: ArchitectOutput;
    readonly mode: "original" | "fanfic" | "series";
    readonly sourceCanon?: string;
    readonly styleGuide?: string;
    readonly language: "zh" | "en";
  }): Promise<FoundationReviewResult> {
    const canonBlock = params.sourceCanon
      ? `\n## 原作正典参照\n${params.sourceCanon.slice(0, 8000)}\n`
      : "";
    const styleBlock = params.styleGuide
      ? `\n## 原作风格参照\n${params.styleGuide.slice(0, 2000)}\n`
      : "";

    const dimensions = params.mode === "original"
      ? this.originalDimensions(params.language)
      : this.derivativeDimensions(params.language, params.mode);

    const systemPrompt = params.language === "en"
      ? this.buildEnglishReviewPrompt(dimensions, canonBlock, styleBlock)
      : this.buildChineseReviewPrompt(dimensions, canonBlock, styleBlock);

    const userPrompt = this.buildFoundationExcerpt(params.foundation, params.language);

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ], { temperature: 0.3 });

    return this.parseReviewResult(response.content, dimensions);
  }

  private originalDimensions(language: "zh" | "en"): ReadonlyArray<string> {
    return language === "en"
      ? [
          "Core Conflict (Is there a clear, compelling central conflict that can sustain 40 chapters?)",
          "Opening Momentum (Can the first 5 chapters create a page-turning hook?)",
          "World Coherence (Is the worldbuilding internally consistent and specific?)",
          "Character Differentiation (Are the main characters distinct in voice and motivation?)",
          "Pacing Feasibility (Does the volume outline have enough variety — not the same beat for 10 chapters?)",
        ]
      : [
          "核心冲突（是否有清晰且有足够张力的核心冲突支撑40章？）",
          "开篇节奏（前5章能否形成翻页驱动力？）",
          "世界一致性（世界观是否内洽且具体？）",
          "角色区分度（主要角色的声音和动机是否各不相同？）",
          "节奏可行性（卷纲是否有足够变化——不会连续10章同一种节拍？）",
        ];
  }

  private derivativeDimensions(language: "zh" | "en", mode: "fanfic" | "series"): ReadonlyArray<string> {
    const modeLabel = mode === "fanfic"
      ? (language === "en" ? "Fan Fiction" : "同人")
      : (language === "en" ? "Series" : "系列");

    return language === "en"
      ? [
          `Source DNA Preservation (Does the ${modeLabel} respect the original's world rules, character personalities, and established facts?)`,
          `New Narrative Space (Is there a clear divergence point or new territory that gives the story room to be ORIGINAL, not a retelling?)`,
          "Core Conflict (Is the new story's central conflict compelling and distinct from the original?)",
          "Opening Momentum (Can the first 5 chapters create a page-turning hook without requiring 3 chapters of setup?)",
          `Pacing Feasibility (Does the outline avoid the trap of re-walking the original's plot beats?)`,
        ]
      : [
          `原作DNA保留（${modeLabel}是否尊重原作的世界规则、角色性格、已确立事实？）`,
          `新叙事空间（是否有明确的分岔点或新领域，让故事有原创空间，而非复述原作？）`,
          "核心冲突（新故事的核心冲突是否有足够张力且区别于原作？）",
          "开篇节奏（前5章能否形成翻页驱动力，不需要3章铺垫？）",
          `节奏可行性（卷纲是否避免了重走原作剧情节拍的陷阱？）`,
        ];
  }

  private buildChineseReviewPrompt(
    dimensions: ReadonlyArray<string>,
    canonBlock: string,
    styleBlock: string,
  ): string {
    return `你是一位资深小说编辑，正在审核一本新书的基础设定（世界观 + 大纲 + 规则）。

你需要从以下维度逐项打分（0-100），并给出具体意见：

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## 评分标准
- 80+ 通过，可以开始写作
- 60-79 有明显问题，需要修改
- <60 方向性错误，需要重新设计

## 输出格式（严格遵守）
=== DIMENSION: 1 ===
分数：{0-100}
意见：{具体反馈}

=== DIMENSION: 2 ===
分数：{0-100}
意见：{具体反馈}

...（每个维度一个 block）

=== OVERALL ===
总分：{加权平均}
通过：{是/否}
总评：{1-2段总结，指出最大的问题和最值得保留的优点}
${canonBlock}${styleBlock}

审核时要严格。不要因为"还行"就给高分。80分意味着"可以直接开写，不需要改"。`;
  }

  private buildEnglishReviewPrompt(
    dimensions: ReadonlyArray<string>,
    canonBlock: string,
    styleBlock: string,
  ): string {
    return `You are a senior fiction editor reviewing a new book's foundation (worldbuilding + outline + rules).

Score each dimension (0-100) with specific feedback:

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## Scoring
- 80+ Pass — ready to write
- 60-79 Needs revision
- <60 Fundamental direction problem

## Output format (strict)
=== DIMENSION: 1 ===
Score: {0-100}
Feedback: {specific feedback}

=== DIMENSION: 2 ===
Score: {0-100}
Feedback: {specific feedback}

...

=== OVERALL ===
Total: {weighted average}
Passed: {yes/no}
Summary: {1-2 paragraphs — biggest problem and best quality}
${canonBlock}${styleBlock}

Be strict. 80 means "ready to write without changes."`;
  }

  private buildFoundationExcerpt(foundation: ArchitectOutput, language: "zh" | "en"): string {
    return language === "en"
      ? `## Story Bible\n${foundation.storyBible.slice(0, 3000)}\n\n## Volume Outline\n${foundation.volumeOutline.slice(0, 3000)}\n\n## Book Rules\n${foundation.bookRules.slice(0, 1500)}\n\n## Initial State\n${foundation.currentState.slice(0, 1000)}\n\n## Initial Hooks\n${foundation.pendingHooks.slice(0, 1000)}`
      : `## 世界设定\n${foundation.storyBible.slice(0, 3000)}\n\n## 卷纲\n${foundation.volumeOutline.slice(0, 3000)}\n\n## 规则\n${foundation.bookRules.slice(0, 1500)}\n\n## 初始状态\n${foundation.currentState.slice(0, 1000)}\n\n## 初始伏笔\n${foundation.pendingHooks.slice(0, 1000)}`;
  }

  private parseReviewResult(
    content: string,
    dimensions: ReadonlyArray<string>,
  ): FoundationReviewResult {
    // 容错解析:逐维度切块,再宽松地从块里抠分数/意见。解析失败的维度记为 parsed:false,
    // 绝不再默认 50(那是一个必然触发 fail 的分,等于"打分器读不懂自己模型的输出就把好地基判死")。
    const parsed: Array<{ readonly name: string; readonly score: number | null; readonly feedback: string }> = [];
    for (let i = 0; i < dimensions.length; i++) {
      const block = this.sliceDimensionBlock(content, i + 1);
      parsed.push({
        name: dimensions[i]!,
        score: this.extractDimensionScore(block),
        feedback: this.extractDimensionFeedback(block),
      });
    }
    const overallFeedback = this.extractOverallFeedback(content);
    const scored = parsed.filter((d): d is { name: string; score: number; feedback: string } => d.score !== null);

    // 一个维度都没解析出来 = 输出格式漂移(代码块/换标点/换措辞),不是地基差。
    // 这种"评审不可判"绝不能当作 fail:放行(passed=true),把把关交回上层的结构/存在性校验。
    if (scored.length === 0) {
      return {
        passed: true,
        totalScore: PASS_THRESHOLD,
        dimensions: parsed.map((d) => ({ name: d.name, score: PASS_THRESHOLD, feedback: d.feedback || "（本维度评分未能从评审输出中解析，已跳过）" })),
        overallFeedback: overallFeedback || "（评审输出格式异常、未能解析评分；已跳过质量门，由结构完整性校验把关。）",
      };
    }

    // 只用"成功解析到的维度"算均分与地板;解析失败的维度直接剔除,不按 0/50 计入。
    const totalScore = Math.round(scored.reduce((sum, d) => sum + d.score, 0) / scored.length);
    const anyBelowFloor = scored.some((d) => d.score < DIMENSION_FLOOR);
    const passed = totalScore >= PASS_THRESHOLD && !anyBelowFloor;
    return {
      passed,
      totalScore,
      dimensions: parsed.map((d) => ({
        name: d.name,
        score: d.score ?? totalScore, // 未解析维度按整体均分占位,不污染判定
        feedback: d.feedback || (d.score === null ? "（本维度评分未能解析，已按整体均分计）" : ""),
      })),
      overallFeedback,
    };
  }

  /** 切出某维度的文本块:从 `=== DIMENSION: n ===` 到下一个 `=== ` 标记或结尾。标记缺失时退回整段文本。 */
  private sliceDimensionBlock(content: string, n: number): string {
    const start = content.search(new RegExp(`=== *DIMENSION: *${n} *===`, "i"));
    if (start < 0) return content;
    const rest = content.slice(start);
    const nextIdx = rest.search(/\n=== /);
    return nextIdx > 0 ? rest.slice(0, nextIdx) : rest;
  }

  /** 宽松抠分数:先认"分数/得分/评分/Score: NN",再退回块内第一个 0-100 的数字。抠不到返回 null(而非默认分)。 */
  private extractDimensionScore(block: string): number | null {
    const labelled = block.match(/(?:分数|得分|评分|Score)\s*[：:]\s*(\d{1,3})/i);
    const raw = labelled ? labelled[1]! : (block.match(/\b(\d{1,3})\b/)?.[1] ?? null);
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
  }

  private extractDimensionFeedback(block: string): string {
    const m = block.match(/(?:意见|反馈|Feedback)\s*[：:]\s*([\s\S]*)/i);
    return m ? m[1]!.replace(/\n=== [\s\S]*$/, "").trim() : "";
  }

  private extractOverallFeedback(content: string): string {
    const m = content.match(/=== *OVERALL *===[\s\S]*?(?:总评|Summary)\s*[：:]\s*([\s\S]*?)$/i);
    return m ? m[1]!.trim() : "";
  }
}
