import { describe, expect, it } from "vitest";
import { WriterAgent } from "../agents/writer.js";
import { buildPlannerUserMessage } from "../agents/planner-prompts.js";
import { buildLengthSpec } from "../utils/length-metrics.js";

function createWriterAgent(): WriterAgent {
  return new WriterAgent({
    client: {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      defaults: {
        temperature: 0.7,
        maxTokens: 4096,
        thinkingBudget: 0,
        extra: {},
      },
    },
    model: "test-model",
    projectRoot: "/tmp/autow-opening-ledger-prompt-test",
  });
}

describe("opening ledger prompt injection", () => {
  it("injects used opening imagery into governed writer prompts", () => {
    const agent = createWriterAgent();
    const prompt = (agent as unknown as {
      buildGovernedUserPrompt(params: {
        readonly chapterNumber: number;
        readonly chapterMemo: {
          readonly chapter: number;
          readonly goal: string;
          readonly isGoldenOpening: boolean;
          readonly body: string;
          readonly threadRefs: readonly string[];
        };
        readonly contextPackage: { readonly chapter: number; readonly selectedContext: readonly [] };
        readonly ruleStack: {
          readonly layers: readonly [];
          readonly sections: { readonly hard: readonly string[]; readonly soft: readonly string[]; readonly diagnostic: readonly string[] };
          readonly overrideEdges: readonly [];
          readonly activeOverrides: readonly [];
        };
        readonly lengthSpec: ReturnType<typeof buildLengthSpec>;
        readonly language?: "zh" | "en";
        readonly openingLedgerBrief?: string;
      }): string;
    }).buildGovernedUserPrompt({
      chapterNumber: 6,
      chapterMemo: {
        chapter: 6,
        goal: "把巷尾灯火线索钉住",
        isGoldenOpening: false,
        body: "## 当前任务\n承接上一章推进巷尾线索。",
        threadRefs: [],
      },
      contextPackage: { chapter: 6, selectedContext: [] },
      ruleStack: {
        layers: [],
        sections: { hard: [], soft: [], diagnostic: [] },
        overrideEdges: [],
        activeOverrides: [],
      },
      lengthSpec: buildLengthSpec(1200, "zh"),
      language: "zh",
      openingLedgerBrief: "## 已用开篇/意象账本（硬避让）\n最近已用招牌意象：抹布、积水、路灯、便利店\n本章要求：必须换一种开篇类型。",
    });

    expect(prompt).toContain("已用开篇/意象账本");
    expect(prompt).toContain("抹布、积水、路灯、便利店");
    expect(prompt).toContain("必须换一种开篇类型");
  });

  it("injects the same opening ledger facts into planner user messages", () => {
    const message = buildPlannerUserMessage({
      chapterNumber: 6,
      previousChapterEndingExcerpt: "上一章停在沈砚看见巷尾灯火。",
      recentSummaries: "| 5 | 雨停以前 | 沈砚 | 擦柜台时看见巷尾灯火 | 怀疑加深 | H03 planted | 阴郁 | transition |",
      openingLedgerBrief: "## 已用开篇/意象账本（硬避让）\n最近已用招牌意象：抹布、积水、路灯、便利店",
      currentArcProse: "H03 正在推进。",
      protagonistMatrixRow: "沈砚 | 谨慎 | 被旧账本牵住",
      opponentRows: "无",
      collaboratorRows: "无",
      relevantThreads: "H03 | 巷尾灯火",
      recyclableHooks: "（无）",
      isGoldenOpening: false,
      bookRulesRelevant: "（暂无 book_rules 条目）",
      language: "zh",
    });

    expect(message).toContain("开篇多样化");
    expect(message).toContain("已用开篇/意象账本");
    expect(message).toContain("抹布、积水、路灯、便利店");
  });
});
