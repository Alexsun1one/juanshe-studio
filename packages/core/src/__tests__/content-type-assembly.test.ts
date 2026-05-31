import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  mountSkills,
  assembleContentType,
  buildWritingSystemPrompt,
} from "../content-type/assembly.js";

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../skills");

describe("mountSkills", () => {
  it("wraps each skill's content into an injectable block", async () => {
    const prompt = await mountSkills(SKILLS_DIR, ["style/de-ai-tone"]);
    expect(prompt).toContain("已挂载技能");
    expect(prompt).toContain('<skill id="style/de-ai-tone"');
    expect(prompt).toContain("去 AI 腔"); // 实际技能内容被注入
  });

  it("returns empty string when no skills", async () => {
    expect(await mountSkills(SKILLS_DIR, [])).toBe("");
  });
});

describe("assembleContentType", () => {
  it("wechat_article mounts style+platform skills and targets wechat renderer", async () => {
    const a = (await assembleContentType(SKILLS_DIR, "wechat_article"))!;
    expect(a).not.toBeNull();
    expect(a.platforms).toEqual(["wechat"]);
    expect(a.skillPrompt).toContain("卡兹克"); // kazike-narrative 被挂载
    expect(a.skillPrompt).toContain("去 AI 腔"); // de-ai-tone 被挂载
    expect(a.roles.length).toBeGreaterThan(0);
    // 未实现的编辑部角色 → 进入 missingRoles(诚实暴露)
    expect(a.missingRoles).toContain("topic-radar");
    // 已落地的编辑部角色(生成→评审→修订循环 + 总编裁决)→ 不应再出现在 missingRoles
    expect(a.missingRoles).not.toContain("editor-in-chief");
    expect(a.missingRoles).not.toContain("draft-writer");
    expect(a.missingRoles).not.toContain("prose-critic");
    expect(a.missingRoles).not.toContain("style-rewriter");
    expect(a.roles.map((r) => r.id)).toContain("prose-critic");
  });

  it("novel uses fully-implemented roles and mounts no extra skills", async () => {
    const a = (await assembleContentType(SKILLS_DIR, "novel"))!;
    expect(a.missingRoles).toEqual([]);
    expect(a.skillPrompt).toBe("");
    expect(a.profile.usesLegacyNovelPipeline).toBe(true);
  });

  it("newsletter mounts its platform skill and targets the newsletter renderer", async () => {
    const a = (await assembleContentType(SKILLS_DIR, "newsletter"))!;
    expect(a).not.toBeNull();
    expect(a.platforms).toEqual(["newsletter"]);
    expect(a.skillPrompt).toContain("Newsletter Platform");
    expect(a.skillPrompt).toContain("订阅");
    expect(a.profile.lengthHint).toEqual({ min: 1000, max: 3500 });
  });

  it("xiaohongshu mounts its platform skill and avoids rich markdown card syntax", async () => {
    const a = (await assembleContentType(SKILLS_DIR, "xiaohongshu_note"))!;
    expect(a.platforms).toEqual(["xiaohongshu"]);
    expect(a.skillPrompt).toContain("小红书笔记");
    const sys = buildWritingSystemPrompt({ profile: a.profile, skillPrompt: a.skillPrompt });
    expect(sys).toContain("小红书输出纪律");
    expect(sys).toContain("plainText 是主产物");
    expect(sys).not.toContain(":::callout");
  });

  it("returns null for unknown profile", async () => {
    expect(await assembleContentType(SKILLS_DIR, "nope")).toBeNull();
  });
});

describe("buildWritingSystemPrompt", () => {
  it("composes role + platform + length + mounted skills into a system prompt", async () => {
    const a = (await assembleContentType(SKILLS_DIR, "wechat_article"))!;
    const sys = buildWritingSystemPrompt({ profile: a.profile, skillPrompt: a.skillPrompt });
    expect(sys).toContain("公众号文章");
    expect(sys).toContain("wechat");
    expect(sys).toContain("已挂载技能");
    expect(sys).toContain("卡兹克");
  });

  it("composes newsletter platform and length into the writing system prompt", async () => {
    const a = (await assembleContentType(SKILLS_DIR, "newsletter"))!;
    const sys = buildWritingSystemPrompt({ profile: a.profile, skillPrompt: a.skillPrompt });
    expect(sys).toContain("Newsletter");
    expect(sys).toContain("newsletter");
    expect(sys).toContain("1000–3500");
  });

  it("teaches article-type LLMs the rich markdown extensions (callout/step/highlight/table/figure_quote)", async () => {
    const a = (await assembleContentType(SKILLS_DIR, "wechat_article"))!;
    const sys = buildWritingSystemPrompt({ profile: a.profile, skillPrompt: a.skillPrompt });
    expect(sys).toContain("富 Markdown 扩展");
    expect(sys).toContain(":::callout");
    expect(sys).toContain(":::highlight");
    expect(sys).toContain(":::step");
    expect(sys).toContain("==高亮文字==");
    expect(sys).toContain("source:");
    expect(sys).toContain("* * *");
    // 必须强调克制,否则模型会把每段都包成卡片
    expect(sys).toMatch(/克制|不要把每段/);
  });

  it("novel (legacy pipeline) does NOT get the rich markdown extensions block", async () => {
    const a = (await assembleContentType(SKILLS_DIR, "novel"))!;
    const sys = buildWritingSystemPrompt({ profile: a.profile, skillPrompt: a.skillPrompt });
    expect(sys).not.toContain("富 Markdown 扩展");
    expect(sys).not.toContain(":::callout");
  });
});
