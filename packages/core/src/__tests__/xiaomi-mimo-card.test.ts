import { describe, expect, it } from "vitest";
import { lookupModel } from "../llm/providers/lookup.js";

// 回归测试:mimo-v2.5-pro 必须有正确的模型卡。
// 没有卡时,createLLMClient 会用 UNKNOWN_MODEL_FALLBACK_MAX_TOKENS = 24576 当默认 max_tokens,
// 而 MiMo-V2.5-Pro 实际只接受 ≤16384 → 写章直接 400(写手停摆)。这条测试钉死这个回归。
describe("Xiaomi MiMo model card", () => {
  it("resolves mimo-v2.5-pro with the real 16384 output cap (not the 24576 fallback)", () => {
    const card = lookupModel("custom", "mimo-v2.5-pro");
    expect(card).toBeDefined();
    expect(card?.maxOutput).toBe(16384);
    expect(card!.maxOutput).toBeLessThan(24576); // 必须低于会触发 400 的 fallback
  });

  it("also resolves the larger mimo-v2.5 variant", () => {
    const card = lookupModel("custom", "mimo-v2.5");
    expect(card?.maxOutput).toBe(131072);
  });

  // 快/慢双轨:pro 卡声明 fastSibling 指向 flash,机械型 agent 才能自动降配。
  it("declares mimo-v2-flash as the fastSibling of the pro variants", () => {
    expect(lookupModel("custom", "mimo-v2.5-pro")?.fastSibling).toBe("mimo-v2-flash");
    expect(lookupModel("custom", "mimo-v2.5")?.fastSibling).toBe("mimo-v2-flash");
    expect(lookupModel("custom", "mimo-v2-pro")?.fastSibling).toBe("mimo-v2-flash");
    // flash 本体不应再指向别处(避免无限/无意义降配)
    expect(lookupModel("custom", "mimo-v2-flash")?.fastSibling).toBeUndefined();
  });
});
