import { describe, expect, it } from "vitest";
import {
  parseObserverLockedFacts,
  parseLockedFactsFile,
  mergeLockedFactsMarkdown,
} from "../utils/locked-facts.js";

describe("locked-facts · observer [锁定事实] 确定性解析", () => {
  it("解析内联多值格式并展开成多条,按白名单过滤", () => {
    const observations = [
      "[资源变化]",
      "- 沈砚 获得 收音机 (数量: 1)",
      "[锁定事实]",
      "- 王老五: 生死=已故",
      "- 沈砚: 血缘=沈鹤是沈砚的父亲 | 真实身份=听物者",
      "- 林晚: 当前位置=钟楼", // 非白名单谓词,必须丢弃
      "[时间]",
      "- 午夜后",
    ].join("\n");
    const facts = parseObserverLockedFacts(observations, 6);
    expect(facts).toEqual([
      { subject: "王老五", predicate: "生死", object: "已故", chapter: 6 },
      { subject: "沈砚", predicate: "血缘", object: "沈鹤是沈砚的父亲", chapter: 6 },
      { subject: "沈砚", predicate: "真实身份", object: "听物者", chapter: 6 },
    ]);
  });

  it("跳过占位/模板回显/未知值(绝不锁假 canon)", () => {
    const observations = [
      "[锁定事实]",
      "- A: 生死=<已故/存活>", // 模板占位
      "- B: 真实身份=未知",
      "- C: 血缘=", // 空值
      "- D: 永久=暂无",
    ].join("\n");
    expect(parseObserverLockedFacts(observations, 3)).toEqual([]);
  });

  it("没有 [锁定事实] 小节 / 空观察 → 空数组", () => {
    expect(parseObserverLockedFacts("[时间]\n- 黄昏", 1)).toEqual([]);
    expect(parseObserverLockedFacts("", 1)).toEqual([]);
  });

  it("同主同谓一章内只取首条(canon 首值为准)", () => {
    const observations = "[锁定事实]\n- 甲: 生死=存活\n- 甲: 生死=已故\n";
    expect(parseObserverLockedFacts(observations, 2)).toEqual([
      { subject: "甲", predicate: "生死", object: "存活", chapter: 2 },
    ]);
  });
});

describe("locked-facts · 文件读写与幂等合并", () => {
  it("merge 产出可重解析的文件,round-trip 一致", () => {
    const md = mergeLockedFactsMarkdown(
      "",
      [
        { subject: "王老五", predicate: "生死", object: "已故", chapter: 3 },
        { subject: "沈砚", predicate: "血缘", object: "沈鹤是沈砚的父亲", chapter: 6 },
      ],
      3,
    );
    // 只合并了 chapter===3 的事实(沈砚那条 chapter=6,不属于本次)
    const parsed = parseLockedFactsFile(md);
    expect(parsed).toEqual([{ subject: "王老五", predicate: "生死", object: "已故", chapter: 3 }]);
  });

  it("幂等:重写同一章不重复堆积,且不动其它章", () => {
    let md = mergeLockedFactsMarkdown("", [{ subject: "甲", predicate: "生死", object: "已故", chapter: 1 }], 1);
    md = mergeLockedFactsMarkdown(md, [{ subject: "乙", predicate: "真实身份", object: "卧底", chapter: 2 }], 2);
    // 重跑第 1 章(复修):第 1 章只应有一条,第 2 章保留
    md = mergeLockedFactsMarkdown(md, [{ subject: "甲", predicate: "生死", object: "已故", chapter: 1 }], 1);
    const parsed = parseLockedFactsFile(md);
    expect(parsed).toHaveLength(2);
    expect(parsed.filter((f) => f.chapter === 1)).toHaveLength(1);
    expect(parsed.some((f) => f.subject === "乙" && f.chapter === 2)).toBe(true);
  });

  it("解析文件行容忍中文冒号/等号与全角变体", () => {
    const parsed = parseLockedFactsFile("- [ch4] 钱二: 生死=已故\n- [ch4] 孙三：真实身份＝影子\n");
    expect(parsed).toEqual([
      { subject: "钱二", predicate: "生死", object: "已故", chapter: 4 },
      { subject: "孙三", predicate: "真实身份", object: "影子", chapter: 4 },
    ]);
  });
});

describe("locked-facts · 假锁防护边界(假 canon 比漏锁更危险)", () => {
  it("模板斜杠回显「已故/存活」「父/母/子/女」绝不锁(LLM 抹掉 <> 但留选项)", () => {
    const obs = [
      "[锁定事实]",
      "- 甲: 生死=已故/存活",      // 抹掉 <> 的选项回显
      "- 乙: 血缘=父/母/子/女",
      "- 丙: 真实身份=卧底/线人/普通人",
    ].join("\n");
    expect(parseObserverLockedFacts(obs, 1)).toEqual([]);
  });

  it("散文行(无 =,即便带冒号)不产生任何锁定事实", () => {
    const obs = "[锁定事实]\n- 这一章揭示了沈鹤是沈砚的生父\n- 重要真相: 沈鹤当年并没有死\n";
    expect(parseObserverLockedFacts(obs, 1)).toEqual([]);
  });

  it("散文带冒号带=但谓词非白名单(如「死亡=暂时假死」)不锁", () => {
    // 注意:这里谓词会被解析成"注:本章设定 死亡"之类,不在白名单 → 丢弃
    const obs = "[锁定事实]\n- 注: 本章设定 死亡=暂时假死\n";
    expect(parseObserverLockedFacts(obs, 1)).toEqual([]);
  });

  it("真实值含全角冒号(真实身份=代号：影子)要正确解析,不被误过滤", () => {
    const obs = "[锁定事实]\n- 沈砚: 真实身份=代号：影子\n";
    expect(parseObserverLockedFacts(obs, 1)).toEqual([
      { subject: "沈砚", predicate: "真实身份", object: "代号：影子", chapter: 1 },
    ]);
  });

  it("单一确定值(已故/沈鹤是沈砚的父亲)照常锁——斜杠过滤不误伤真实值", () => {
    const obs = "[锁定事实]\n- 甲: 生死=已故\n- 乙: 血缘=沈鹤是沈砚的父亲\n";
    expect(parseObserverLockedFacts(obs, 1)).toEqual([
      { subject: "甲", predicate: "生死", object: "已故", chapter: 1 },
      { subject: "乙", predicate: "血缘", object: "沈鹤是沈砚的父亲", chapter: 1 },
    ]);
  });
});
