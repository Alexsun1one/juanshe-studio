import { describe, expect, it } from "vitest";
import {
  parseEditorialVerdict,
  buildEditorInChiefUserMessage,
  DEFAULT_AI_TONE_FLOOR,
  type EditorInChiefSignals,
} from "../agents/editor-in-chief-prompts.js";
import { aiToneScore } from "../agents/ai-tells.js";

const passRaw = {
  verdict: "pass",
  editorialScore: 88,
  rationale: "节奏稳,人物动机清楚,可以签发。",
  strengths: ["开场有钩子"],
  risks: [],
  reworkTargets: [],
  nextDirection: "下一章给一个爆点。",
};

describe("aiToneScore", () => {
  it("clean varied prose scores high (>=90)", () => {
    const clean = "他一脚踩碎石板。碎石打在墙上,清脆作响。\n\n短暂的沉默。远处传来脚步声,越来越近。";
    expect(aiToneScore(clean, "zh")).toBeGreaterThanOrEqual(90);
  });

  it("AI-tell-heavy prose scores notably lower than clean", () => {
    // 多类痕迹叠加:套话意象(空气仿佛凝固/心跳漏了一拍)+ 公式化转折(然而 ×3)+
    // 直白命名情绪(感到恐惧/愤怒/绝望)+ 套话(似乎/或许/可能)。
    const aiish = [
      "空气仿佛凝固了,时间仿佛静止。他感到一阵恐惧,心头涌起一股愤怒。然而他似乎说不清这种感觉。",
      "无形的压力笼罩着房间。然而气氛凝重,落针可闻。他可能感到了绝望,内心深处涌起一丝不安。",
      "心跳漏了一拍。然而或许一切都已注定。他感到深深的悲伤,似乎命运早已写好。",
    ].join("\n\n");
    const clean = "他踢开门。雨水顺着屋檐砸下来,打湿了肩膀。\n\n屋里没人。桌上的茶还冒着热气。";
    const aiScore = aiToneScore(aiish, "zh");
    expect(aiScore).toBeLessThan(aiToneScore(clean, "zh"));
    expect(aiScore).toBeLessThan(DEFAULT_AI_TONE_FLOOR);
  });
});

describe("parseEditorialVerdict — AI 味签发硬门禁", () => {
  it("forces rework when aiTone below floor even if LLM said pass and gate passed", () => {
    const v = parseEditorialVerdict(passRaw, { gatePass: true, aiTone: 55, aiToneFloor: 70 })!;
    expect(v.verdict).toBe("rework");
    // 必须补一个 polisher 去 AI 味任务
    expect(v.reworkTargets.some((t) => t.agent === "polisher")).toBe(true);
    // risks 里要点出 AI 痕迹
    expect(v.risks.join(" ")).toMatch(/AI 痕迹|人味/);
  });

  it("passes through when aiTone is at/above floor and gate passed and LLM said pass", () => {
    const v = parseEditorialVerdict(passRaw, { gatePass: true, aiTone: 88, aiToneFloor: 70 })!;
    expect(v.verdict).toBe("pass");
    expect(v.reworkTargets).toHaveLength(0);
  });

  it("uses DEFAULT_AI_TONE_FLOOR (70) when no floor supplied", () => {
    const below = parseEditorialVerdict(passRaw, { gatePass: true, aiTone: 69 })!;
    expect(below.verdict).toBe("rework");
    const atFloor = parseEditorialVerdict(passRaw, { gatePass: true, aiTone: 70 })!;
    expect(atFloor.verdict).toBe("pass");
  });

  it("does not duplicate the polisher target if LLM already assigned one", () => {
    const withPolisher = {
      ...passRaw,
      verdict: "rework",
      reworkTargets: [{ agent: "polisher", what: "已有润色任务" }],
    };
    const v = parseEditorialVerdict(withPolisher, { gatePass: true, aiTone: 50 })!;
    const polisherTargets = v.reworkTargets.filter((t) => t.agent === "polisher");
    expect(polisherTargets).toHaveLength(1);
  });

  it("machine gate failure still forces rework regardless of aiTone (existing safety net)", () => {
    const v = parseEditorialVerdict(passRaw, { gatePass: false, aiTone: 95 })!;
    expect(v.verdict).toBe("rework");
  });

  it("does not block when aiTone is null/unknown (no gate without a score)", () => {
    const v = parseEditorialVerdict(passRaw, { gatePass: true, aiTone: null })!;
    expect(v.verdict).toBe("pass");
  });
});

describe("buildEditorInChiefUserMessage — 人味行", () => {
  const baseSignals: EditorInChiefSignals = {
    bookTitle: "测试书",
    chapterNumber: 9,
    chapterTitle: "县城老街",
    totalScore: 88,
    gateTarget: 85,
    gatePass: true,
    metrics: { continuity: 96, style: 86, length: 76 },
    auditIssues: [],
    wordCount: 2091,
    targetWordCount: 3000,
  };

  it("renders the 人味 line with a red-line warning when below floor", () => {
    const msg = buildEditorInChiefUserMessage({ ...baseSignals, aiTone: 55, aiToneFloor: 70 });
    expect(msg).toContain("人味指数");
    expect(msg).toMatch(/红线|必须返工/);
  });

  it("omits the 人味 line when aiTone not provided", () => {
    const msg = buildEditorInChiefUserMessage(baseSignals);
    expect(msg).not.toContain("人味指数");
  });
});
