import { describe, expect, it } from "vitest";
import {
  AGENT_CONTRACTS,
  getAgentContract,
  nextAgents,
  validateHandoff,
  upstreamProducersOf,
} from "../pipeline/agent-contracts.js";

describe("agent contracts", () => {
  it("forms a connected agent chain (backend roster)", () => {
    expect(AGENT_CONTRACTS).toHaveLength(17);
    expect(getAgentContract("radar")).toBeTruthy();
    expect(getAgentContract("prompt-governor")).toBeTruthy();
    expect(getAgentContract("writer")!.requires).toContain("chapter_intent");
    expect(nextAgents("writer")).toContain("auditor");
    // 每个 handoffTo 目标(除 human)都能在契约里找到
    for (const c of AGENT_CONTRACTS) {
      for (const to of c.handoffTo) {
        if (to === "human") continue;
        expect(getAgentContract(to), `${c.id} → ${to} 目标缺失`).toBeTruthy();
      }
    }
  });

  it("validateHandoff passes when upstream artifacts present", () => {
    const r = validateHandoff("writer", {
      chapter_intent: "本章意图…",
      context_package: { foo: 1 },
      rule_stack: ["r1"],
    });
    expect(r.ok).toBe(true);
    expect(r.missing).toHaveLength(0);
  });

  it("validateHandoff fails with missing list + attribution", () => {
    const r = validateHandoff("writer", { chapter_intent: "", context_package: null });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["chapter_intent", "context_package"]);
    expect(r.reason).toContain("planner"); // 归因到产出方 planner
  });

  it("treats empty string / empty array as missing", () => {
    const r = validateHandoff("reviser", { chapter_draft: "   ", audit_result: [] });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["chapter_draft", "audit_result"]);
  });

  it("upstreamProducersOf maps artifacts back to producing agents", () => {
    expect(upstreamProducersOf(["chapter_draft"])).toContain("writer");
    expect(upstreamProducersOf(["story_frame"])).toContain("architect");
    expect(upstreamProducersOf(["prompt_governance"])).toContain("prompt-governor");
  });

  it("unknown agent reports not-ok", () => {
    expect(validateHandoff("nope", {}).ok).toBe(false);
  });
});
