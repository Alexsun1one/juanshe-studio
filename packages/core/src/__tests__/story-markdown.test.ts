import { describe, it, expect } from "vitest";
import {
  parseMarkdownTableRows,
  parseCurrentStateFacts,
  isStateTableHeaderRow,
  isCurrentChapterLabel,
  inferFactSubject,
} from "../utils/story-markdown.js";

describe("parseMarkdownTableRows · 分隔行识别(回归:值含---的数据行绝不丢)", () => {
  it("跳过表格分隔行(两种风格),但保留值里含 --- 的真实数据行", () => {
    const md = [
      "| 字段 | 值 |",
      "| --- | --- |",
      "| 当前位置 | 城南旧货市场 |",
      "| 当前目标 | 查清1999---2001年的旧案真相 |", // 值含 --- —— 旧逻辑 includes('---') 会整行丢掉(丢状态事实=漂移)
      "|:---:|:---:|", // 对齐风格分隔行也要跳过
      "| 当前冲突 | 与组织对峙 |",
    ].join("\n");
    const rows = parseMarkdownTableRows(md);
    // 表头 + 3 个数据行(2 个分隔行被跳过),含 --- 的那行必须在
    expect(rows).toEqual([
      ["字段", "值"],
      ["当前位置", "城南旧货市场"],
      ["当前目标", "查清1999---2001年的旧案真相"],
      ["当前冲突", "与组织对峙"],
    ]);
  });

  it("无 | 开头的行、空行被忽略", () => {
    expect(parseMarkdownTableRows("随便一句话\n\n| a | b |\n| --- | --- |\n| 1 | 2 |")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseCurrentStateFacts · 不丢含---的状态事实(端到端)", () => {
  it("当前目标(值含 1999---2001)被正确解析成 fact,不被静默丢弃", () => {
    const md = [
      "| 字段 | 值 |",
      "| --- | --- |",
      "| 当前章节 | 9 |",
      "| 当前目标 | 查清1999---2001年的旧案真相 |",
    ].join("\n");
    const facts = parseCurrentStateFacts(md, 9);
    const goal = facts.find((f) => f.predicate === "当前目标");
    expect(goal).toBeDefined();
    expect(goal?.object).toBe("查清1999---2001年的旧案真相");
    expect(goal?.subject).toBe("protagonist");
    expect(goal?.sourceChapter).toBe(9);
  });
});

describe("story-markdown · 辅助判定", () => {
  it("isStateTableHeaderRow 识别字段/值表头(中英)", () => {
    expect(isStateTableHeaderRow(["字段", "值"])).toBe(true);
    expect(isStateTableHeaderRow(["field", "value"])).toBe(true);
    expect(isStateTableHeaderRow(["当前位置", "城南"])).toBe(false);
  });
  it("isCurrentChapterLabel 识别当前章节标签", () => {
    expect(isCurrentChapterLabel("当前章节")).toBe(true);
    expect(isCurrentChapterLabel("current chapter")).toBe(true);
    expect(isCurrentChapterLabel("当前目标")).toBe(false);
  });
  it("inferFactSubject 把'当前X'字段归到 protagonist,其余 current_state", () => {
    expect(inferFactSubject("当前位置")).toBe("protagonist");
    expect(inferFactSubject("主角状态")).toBe("protagonist");
    expect(inferFactSubject("当前敌我")).toBe("protagonist");
    expect(inferFactSubject("某个未知字段")).toBe("current_state");
  });
});
