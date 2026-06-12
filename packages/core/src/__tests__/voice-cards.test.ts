import { describe, expect, it } from "vitest";
import {
  countAttributedDialogue,
  extractVoiceCards,
  renderVoiceCardAuditBlock,
  renderWriterVoiceCardBlock,
  selectActiveVoiceCards,
  selectVoiceCardsByMention,
} from "../agents/voice-cards.js";

const MATRIX = [
  "## 老周",
  "- **定位**: 配角",
  "- **说话**: 油滑、爱打太极、话里带钩子;动了真情就骂骂咧咧",
  "",
  "## 赵平",
  "- **定位**: 配角",
  "- **说话**: 官腔,先撇清再给半句",
  "",
  "## 哑巴",
  "- **定位**: 提及",
].join("\n");

describe("extractVoiceCards", () => {
  it("keeps only characters that carry a 「说话」 card, verbatim", () => {
    const cards = extractVoiceCards(MATRIX);
    expect(cards.map((c) => c.name)).toEqual(["老周", "赵平"]);
    expect(cards[0]!.voice).toBe("油滑、爱打太极、话里带钩子;动了真情就骂骂咧咧");
  });

  it("returns empty for missing-file placeholders", () => {
    expect(extractVoiceCards("(文件尚未创建)")).toEqual([]);
    expect(extractVoiceCards("")).toEqual([]);
  });
});

describe("selectActiveVoiceCards", () => {
  const chapter = [
    "老周把茶缸往桌上一墩：“你急什么？”",
    "“他跟你说了什么？”老周眯起眼。",
    "“明天去的时候，带上那台收音机。”老周说。",
    "赵平咳了一声：“你爸的事，我不说，是为你好。”",
    "巷子里没人说话。",
  ].join("\n");

  it("selects characters with enough attributed dialogue lines", () => {
    const active = selectActiveVoiceCards(extractVoiceCards(MATRIX), chapter, { minDialogueLines: 3 });
    expect(active.map((c) => c.name)).toEqual(["老周"]);
    expect(active[0]!.dialogueLines).toBe(3);
    expect(countAttributedDialogue(chapter, "赵平")).toBe(1);
  });
});

describe("selectVoiceCardsByMention", () => {
  const cards = extractVoiceCards(MATRIX);

  it("prefers characters named by the chapter intent", () => {
    const picked = selectVoiceCardsByMention(cards, "本章目标:赵平向主角摊牌");
    expect(picked.map((c) => c.name)).toEqual(["赵平"]);
  });

  it("falls back to all cards when the intent names nobody", () => {
    const picked = selectVoiceCardsByMention(cards, "本章目标:回收第3章的钩子");
    expect(picked.map((c) => c.name)).toEqual(["老周", "赵平"]);
  });
});

describe("render blocks", () => {
  const cards = [{ name: "老周", voice: "油滑、爱打太极", dialogueLines: 3 }];

  it("audit block quotes the card and demands violations be filed as 台词失真 issues", () => {
    const block = renderVoiceCardAuditBlock(cards, "zh");
    expect(block).toContain("声音卡验收");
    expect(block).toContain("老周:油滑、爱打太极");
    expect(block).toContain("台词失真");
    expect(renderVoiceCardAuditBlock([], "zh")).toBe("");
  });

  it("writer block binds dialogue to the cards with the mask-the-name test", () => {
    const block = renderWriterVoiceCardBlock(cards, "zh");
    expect(block).toContain("人物声音卡");
    expect(block).toContain("遮住人名");
    expect(renderWriterVoiceCardBlock([], "zh")).toBe("");
  });
});
