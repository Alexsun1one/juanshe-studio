import { describe, it, expect } from "vitest";
import { isHardContinuityCritical, computeChapterQualityScore } from "./server.js";

// Path B 回归测试:critical 分级(硬伤 ×16+门禁+封顶 / LLM 软 critical ×5)。
// 这块没有专门测试时,对抗审查抓到过假阴性(审稿官写"牺牲/殒命"漏网)+ 复修空转两个真 bug,
// 这里把"硬/软判定"和"硬软打分差异"钉死,防回归。

const crit = (category: string, zh: string) => ({ severity: "critical", category, message: { zh } });

describe("isHardContinuityCritical · 混合+偏保守分类", () => {
  it("审稿官真实措辞的硬伤一律判硬(死亡同义词/时间线/设定相悖/英文)", () => {
    const hard = [
      crit("连续性", "主角A在第5章明明已牺牲,本章又出现"),
      crit("连续性", "殒命的配角又开口说话"),
      crit("时间线", "时间对不上,昨夜的事写成三天前"),
      crit("设定", "父亲设定和第二卷冲突,之前说是孤儿"),
      crit("设定", "和已建立的魔法规则相悖,之前说不能瞬移"),
      crit("逻辑", "动机和前文对不上,逻辑断裂"),
      crit("continuity", "character resurrected in chapter 6 but died in chapter 3"),
      crit("伏笔", "埋下的线索至今没回收,断线了"),
    ];
    for (const issue of hard) expect(isHardContinuityCritical(issue)).toBe(true);
  });

  it("明确的写作 craft 点评判软(节奏/文笔/沉浸/对话自然度)", () => {
    const soft = [
      crit("节奏", "这段对话节奏略拖"),
      crit("文笔", "文笔平淡,缺乏张力"),
      crit("沉浸", "沉浸感不足,感官细节偏少"),
      crit("描写", "这段描写画面感不够生动"),
    ];
    for (const issue of soft) expect(isHardContinuityCritical(issue)).toBe(false);
  });

  it("含糊/不认识的措辞默认按硬(偏保守,绝不放过疑似矛盾)", () => {
    expect(isHardContinuityCritical(crit("其他", "这里读起来怪怪的,说不清"))).toBe(true);
    expect(isHardContinuityCritical(crit("", "需要再看看"))).toBe(true);
  });

  it("字段健壮:message 为字符串/数组/只有 en/缺失,都不崩且能命中硬伤", () => {
    expect(isHardContinuityCritical("[critical] 王五复活了")).toBe(true); // 纯字符串 issue
    expect(isHardContinuityCritical({ severity: "critical", category: "x", message: ["王五", "复活了"] })).toBe(true);
    expect(isHardContinuityCritical({ severity: "critical", message: { en: "the dead character speaks again" } })).toBe(true);
    expect(isHardContinuityCritical({ severity: "critical", category: "节奏" })).toBe(false); // 无 message,category=节奏→软
  });
});

describe("computeChapterQualityScore · Path B 端到端", () => {
  // 足够长的正文,避开 too-short / 长度罚;给 report 避开 missing-quality-report。
  const content = ("沈砚走进那间堆满旧物的屋子。窗帘拉得很严，灰尘在斜进来的光里浮动。他没有说话，只是慢慢看着桌上那台收音机。" +
    "赵平坐在对面，手指在桌沿轻轻敲着。两个人都没有先开口，空气里只有钟摆的声音。" +
    "“你爸当年也是这样，”赵平终于说，“坐在这儿，一句话不说，盯着这台机器看了很久。”" +
    "沈砚伸手把收音机往自己这边挪了挪，金属底座蹭过木桌，发出一声轻响。他抬眼。" +
    "“那盘带子，”他说，“在你这儿，对吗。”赵平没有否认，只是站起来，走向卧室。" +
    "抽屉拉开的声音，金属碰撞，然后是一段很长的安静。沈砚的呼吸放慢了。他知道，接下来听到的东西，会改变很多。").repeat(2);
  const base = { content, report: "风格指纹 88 · 嗓音贴合度良好。", targetWordCount: 800, status: "ready-for-review", gateTarget: 80 };

  it("硬伤 critical:连续性 ×16 + critical-audit 门禁 + 84 封顶", () => {
    const r = computeChapterQualityScore({ ...base, auditIssues: [crit("连续性", "已死的王五本章复活出场")] });
    expect(r.stats.hardCriticals).toBe(1);
    expect(r.stats.softCriticals).toBe(0);
    expect(r.gate.blockers).toContain("critical-audit");
    expect(r.total).toBeLessThanOrEqual(84);
  });

  it("纯软 critical:不进门禁、不封顶,连续性分明显高于同内容的硬伤版", () => {
    const soft = computeChapterQualityScore({ ...base, auditIssues: [crit("节奏", "对话节奏略拖"), crit("文笔", "用词偏平淡")] });
    const hard = computeChapterQualityScore({ ...base, auditIssues: [crit("连续性", "已死的王五本章复活出场")] });
    expect(soft.stats.hardCriticals).toBe(0);
    expect(soft.stats.softCriticals).toBe(2);
    expect(soft.gate.blockers).not.toContain("critical-audit");
    // 2 软 critical(×5×2=10)应明显轻于 1 硬伤(×16),连续性分更高
    expect(soft.metrics.continuity).toBeGreaterThan(hard.metrics.continuity);
    // 纯软不触发 84 封顶(总分不会被 Math.min(rawTotal,84) 焊死)
    expect(soft.gate.blockers.filter((b: string) => b === "critical-audit")).toHaveLength(0);
  });

  it("无 critical:连续性接近满分(96 基线),不进 critical-audit 门禁", () => {
    const r = computeChapterQualityScore({ ...base, auditIssues: [] });
    expect(r.stats.hardCriticals).toBe(0);
    expect(r.metrics.continuity).toBeGreaterThanOrEqual(90);
    expect(r.gate.blockers).not.toContain("critical-audit");
  });
});
