import { describe, expect, it } from "vitest";
import { parseStoryFrame, findSection } from "../knowledge/story-frame.js";

const FRAME = `---
version: "1.0"
protagonist:
  name: 陆星河
prohibitions:
  - 无成本升级
  - 主角突然获得新能力解围
---

## 段 1：主题与基调

这本书讲的是一个被命运按进泥里的人。

## 段 3：世界观底色

这个世界的铁律有六条。第一，任何认知优势都必须付出代价。第二，信息不能凭空创造。第三，世界规则是向上兼容向下封印。第四，代价守恒是跨层铁律。第五，人类是被设计的生物人工智能。第六，大事件不改宏观结果。

这个世界的质感是湿的而不是干的。

## 段 4：终局方向

全书 Objective:陆星河建立可持续秩序。`;

describe("parseStoryFrame", () => {
  it("strips YAML frontmatter and splits prose sections", () => {
    const f = parseStoryFrame(FRAME);
    expect(f.frontmatter).toContain("protagonist");
    expect(f.sections.map((s) => s.title)).toEqual(["段 1：主题与基调", "段 3：世界观底色", "段 4：终局方向"]);
    expect(findSection(f, "终局")!.body).toContain("可持续秩序");
  });

  it("extracts the 世界铁律 enumeration into a rule list", () => {
    const f = parseStoryFrame(FRAME);
    expect(f.worldRules).toHaveLength(6);
    expect(f.worldRules[0]).toContain("认知优势");
    expect(f.worldRules[4]).toContain("生物人工智能");
    // 枚举只取铁律段落,不混入下一段
    expect(f.worldRules.join("")).not.toContain("质感是湿的");
  });

  it("returns empty shape for blank input", () => {
    const f = parseStoryFrame("");
    expect(f.sections).toEqual([]);
    expect(f.worldRules).toEqual([]);
  });
});
