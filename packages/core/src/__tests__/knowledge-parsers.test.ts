import { describe, expect, it } from "vitest";
import {
  parseCharacterMatrix,
  parseRoleFile,
  classifyRole,
} from "../knowledge/character-matrix.js";
import { parseEmotionalArcs, groupArcsByCharacter } from "../knowledge/emotional-arcs.js";

// 真实运行库格式样本(星尘邮局)
const MATRIX = `## 陆星河
- **定位**: 主角
- **标签**: 核心反差设定者、前工程研究员、核心能力模块持有者、护家人
- **反差**: 一个能用核心能力模块完成成人级现场勘察的孩子，会买两个馒头递一个给盟友。
- **说话**: 简洁、克制、沉。
- **性格**: 温厚下面压着冷静。
- **动机**: 找到林烨，确认矿难真相。
- **当前**: 找人确认药渣，天黑后与谢沉舟会合。
- **关系**: 谢沉舟（合作者/信任升级/Ch15）| 沈清禾（母亲/默契加深/Ch15）| 林烨（目标/从目击者深化为在逃弱证人/Ch15）
- **已知**: 林烨是矿难目击者；林烨在照顾病孩林小雨；旧信物在晨露中微热过。
- **未知**: 林烨现在在哪；矿难的真正原因。

## 谢沉舟
- **定位**: 盟友（双男主）
- **标签**: 冷冽的执行者、认死理
- **动机**: 找出父亲死亡真相。
- **关系**: 陆星河（合作者/信任再升级/Ch15）| 11号女人（监视对象/调查目标/Ch15）
`;

describe("parseCharacterMatrix", () => {
  it("parses every character block with fields", () => {
    const chars = parseCharacterMatrix(MATRIX);
    expect(chars).toHaveLength(2);
    const lin = chars[0]!;
    expect(lin.name).toBe("陆星河");
    expect(lin.role).toBe("主角");
    expect(lin.roleKind).toBe("protagonist");
    expect(lin.tags).toContain("核心能力模块持有者");
    expect(lin.tags).toHaveLength(4);
    expect(lin.motivation).toContain("林烨");
    expect(lin.current).toContain("谢沉舟");
  });

  it("parses relations with target/type/note (fullwidth parens)", () => {
    const chars = parseCharacterMatrix(MATRIX);
    const lin = chars[0]!;
    expect(lin.relations).toHaveLength(3);
    const xie = lin.relations.find((r) => r.target === "谢沉舟")!;
    expect(xie.type).toBe("合作者");
    expect(xie.note).toContain("信任升级");
    expect(xie.note).toContain("Ch15");
  });

  it("splits known/unknown by fullwidth semicolons", () => {
    const lin = parseCharacterMatrix(MATRIX)[0]!;
    expect(lin.known).toHaveLength(3);
    expect(lin.unknown).toHaveLength(2);
  });

  it("classifies role kinds", () => {
    expect(classifyRole("主角")).toBe("protagonist");
    expect(classifyRole("盟友（双男主）")).toBe("deuteragonist");
    expect(classifyRole("导师")).toBe("mentor");
    expect(classifyRole("反派")).toBe("antagonist");
    expect(classifyRole("身份未明")).toBe("mystery");
    expect(classifyRole("配角")).toBe("supporting");
  });

  it("returns empty array for blank input", () => {
    expect(parseCharacterMatrix("")).toEqual([]);
  });
});

describe("parseRoleFile", () => {
  it("splits prose role file into titled sections", () => {
    const md = `## 核心标签\n温厚、克制、机警。\n\n## 主角弧线\n起点弱小，终点秩序缔造者。`;
    const secs = parseRoleFile(md);
    expect(secs).toHaveLength(2);
    expect(secs[0]!.title).toBe("核心标签");
    expect(secs[0]!.body).toContain("温厚");
    expect(secs[1]!.title).toBe("主角弧线");
  });
});

const ARCS = `| 角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向 |
| --- | --- | --- | --- | --- | --- |
| 陆星河 | 第15章 | 平静→警觉→专注 | 旧信物微热 | 8（第一次触碰他人苦难） | 从冷推演转向理解并行动 |
| 谢沉舟 | 第15章 | 克制→脆弱→信任 | 提及父亲往事 | 7 | 从保留转向共担信任 |`;

describe("parseEmotionalArcs", () => {
  it("parses table rows, skipping header & separator", () => {
    const pts = parseEmotionalArcs(ARCS);
    expect(pts).toHaveLength(2);
    expect(pts[0]!.character).toBe("陆星河");
    expect(pts[0]!.chapter).toBe(15);
    expect(pts[0]!.intensity).toBe(8);
    expect(pts[0]!.direction).toContain("理解并行动");
  });

  it("groups arcs by character sorted by chapter", () => {
    const grouped = groupArcsByCharacter(parseEmotionalArcs(ARCS));
    expect(Object.keys(grouped)).toContain("陆星河");
    expect(grouped["陆星河"]).toHaveLength(1);
  });

  it("returns empty for blank input", () => {
    expect(parseEmotionalArcs("")).toEqual([]);
  });
});
