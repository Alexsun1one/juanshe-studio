import { describe, expect, it } from "vitest";
import { emptyAccountStyle, evolveStyleProfile, buildAccountVoicePrompt, type AccountStyleProfile } from "../editorial/account-style.js";
import { parseCritiqueReport } from "../editorial/article-pipeline.js";

const crit = (issues: { severity: string; problem: string; fix?: string }[], score = 70) =>
  parseCritiqueReport(JSON.stringify({ overall: "", score, issues }));

describe("account-style self-evolution", () => {
  it("learns rules from significant/critical issues", () => {
    let p = emptyAccountStyle("wechat_article");
    p = evolveStyleProfile(p, crit([
      { severity: "significant", problem: "信源含糊", fix: "点名具体理论或数据" },
      { severity: "minor", problem: "比喻冗余", fix: "删一个" }, // minor 不进化
    ]), { now: "2026-05-22T00:00:00Z" });
    expect(p.version).toBe(1);
    expect(p.learnedRules).toHaveLength(1);
    expect(p.learnedRules[0]!.rule).toContain("信源含糊");
    expect(p.learnedRules[0]!.hits).toBe(1);
  });

  it("accumulates hits for recurring issues across rounds", () => {
    let p = emptyAccountStyle("x");
    const c = crit([{ severity: "significant", problem: "信源含糊,显得空泛", fix: "点名来源" }]);
    p = evolveStyleProfile(p, c, { now: "t1" });
    p = evolveStyleProfile(p, c, { now: "t2" });
    p = evolveStyleProfile(p, c, { now: "t3" });
    expect(p.version).toBe(3);
    expect(p.learnedRules).toHaveLength(1);
    expect(p.learnedRules[0]!.hits).toBe(3); // 同类合并累加
  });

  it("no-op for clean / unparsed critique", () => {
    const p0 = emptyAccountStyle("x");
    expect(evolveStyleProfile(p0, crit([], 95)).version).toBe(0); // 无 significant
    expect(evolveStyleProfile(p0, parseCritiqueReport("garbage")).version).toBe(0);
  });

  it("buildAccountVoicePrompt surfaces voice + recurring rules (hits>=2)", () => {
    let p: AccountStyleProfile = { ...emptyAccountStyle("x"), voice: "过来人认真聊", forbidden: ["喊口号"] };
    const c = crit([{ severity: "critical", problem: "开头是教科书腔", fix: "改成具体场景" }]);
    p = evolveStyleProfile(p, c); p = evolveStyleProfile(p, c); // hits=2
    const prompt = buildAccountVoicePrompt(p);
    expect(prompt).toContain("过来人认真聊");
    expect(prompt).toContain("喊口号");
    expect(prompt).toContain("反复出现的问题");
    expect(prompt).toContain("教科书腔");
    expect(prompt).toContain("2 次");
  });
});
