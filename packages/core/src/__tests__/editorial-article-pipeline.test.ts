import { describe, expect, it } from "vitest";
import {
  buildCriticSystemPrompt,
  buildReviserSystemPrompt,
  parseCritiqueReport,
  critiqueWantsRevision,
  critiquePasses,
} from "../editorial/article-pipeline.js";
import { getContentTypeProfile } from "../content-type/profile.js";

const wechat = getContentTypeProfile("wechat_article")!;

describe("editorial article pipeline", () => {
  it("critic prompt is adversarial, JSON-only, severity-graded", () => {
    const p = buildCriticSystemPrompt(wechat);
    expect(p).toContain("公众号文章");
    expect(p).toContain("哪里不成立");
    expect(p).toContain("公众号专项");
    expect(p).toContain("前 3 段");
    expect(p).toMatch(/critical/);
    expect(p).toMatch(/只输出 JSON/);
  });

  it("critic prompt includes xiaohongshu-specific review criteria", () => {
    const xhs = getContentTypeProfile("xiaohongshu_note")!;
    const p = buildCriticSystemPrompt(xhs);
    expect(p).toContain("小红书专项");
    expect(p).toContain("标题是否 1 秒内");
    expect(p).toContain("标签是否集中在末尾");
  });

  it("reviser prompt mounts skill block and forbids wrapper talk", () => {
    const p = buildReviserSystemPrompt({ profile: wechat, skillPrompt: "<skill id=\"x\">规则</skill>" });
    expect(p).toContain("修订编辑");
    expect(p).toContain("去 AI 腔");
    expect(p).toContain("小红书保持短段");
    expect(p).toContain("<skill id=\"x\">");
  });

  it("parses a clean JSON critique with score", () => {
    const raw = JSON.stringify({
      overall: "开头偏弱",
      score: 72,
      issues: [
        { severity: "critical", where: "第一段", problem: "信息倾倒", fix: "从具体场景切入" },
        { severity: "minor", where: "结尾", problem: "略平", fix: "留个钩子" },
      ],
    });
    const r = parseCritiqueReport(raw);
    expect(r.parsed).toBe(true);
    expect(r.issues).toHaveLength(2);
    expect(r.score).toBe(72);
    expect(r.issues[0]!.severity).toBe("critical");
    expect(critiqueWantsRevision(r)).toBe(true);
  });

  it("critiquePasses: gate on score + no critical (多轮停止条件)", () => {
    // 高分无硬伤 → 通过(停止循环)
    expect(critiquePasses(parseCritiqueReport(JSON.stringify({ overall: "", score: 91, issues: [] })))).toBe(true);
    // 低于阈值 → 不通过(继续修)
    expect(critiquePasses(parseCritiqueReport(JSON.stringify({ overall: "", score: 80, issues: [] })))).toBe(false);
    // 有 critical 无论分数都不过
    expect(critiquePasses(parseCritiqueReport(JSON.stringify({ overall: "", score: 95, issues: [{ severity: "critical", problem: "硬伤", fix: "改" }] })))).toBe(false);
    // 无分数:看有无 significant
    expect(critiquePasses(parseCritiqueReport(JSON.stringify({ overall: "", issues: [{ severity: "minor", problem: "x", fix: "y" }] })))).toBe(true);
    expect(critiquePasses(parseCritiqueReport(JSON.stringify({ overall: "", issues: [{ severity: "significant", problem: "x", fix: "y" }] })))).toBe(false);
    // 自定义阈值
    expect(critiquePasses(parseCritiqueReport(JSON.stringify({ overall: "", score: 86, issues: [] })), 85)).toBe(true);
    // 解析失败 → 停止(不空转)
    expect(critiquePasses(parseCritiqueReport("garbage"))).toBe(true);
  });

  it("parses JSON wrapped in code fence", () => {
    const raw = "```json\n" + JSON.stringify({ overall: "ok", issues: [] }) + "\n```";
    const r = parseCritiqueReport(raw);
    expect(r.parsed).toBe(true);
    expect(r.issues).toHaveLength(0);
    expect(critiqueWantsRevision(r)).toBe(false);
  });

  it("recovers JSON embedded in prose (brace slice)", () => {
    const raw = "这是我的评审:\n{\"overall\":\"还行\",\"issues\":[{\"severity\":\"significant\",\"where\":\"中段\",\"problem\":\"节奏拖\",\"fix\":\"删两段\"}]}\n以上。";
    const r = parseCritiqueReport(raw);
    expect(r.parsed).toBe(true);
    expect(r.issues).toHaveLength(1);
    expect(critiqueWantsRevision(r)).toBe(true);
  });

  it("degrades safely on unparseable output", () => {
    const r = parseCritiqueReport("模型挂了,什么都没有");
    expect(r.parsed).toBe(false);
    expect(r.issues).toHaveLength(0);
    expect(critiqueWantsRevision(r)).toBe(false);
  });

  it("drops malformed issues and normalizes unknown severity", () => {
    const raw = JSON.stringify({
      overall: "",
      issues: [
        { severity: "BOGUS", where: "x", problem: "有问题", fix: "改" },
        { severity: "critical" },
        "not-an-object",
      ],
    });
    const r = parseCritiqueReport(raw);
    expect(r.parsed).toBe(true);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.severity).toBe("minor");
  });
});
