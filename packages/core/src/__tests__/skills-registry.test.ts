import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listSkills, loadSkill } from "../skills/registry.js";

// __tests__ → 仓库根 skills/
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../skills");

describe("skill registry", () => {
  it("lists seeded style/platform skills with title and source", async () => {
    const skills = await listSkills(SKILLS_DIR);
    const ids = skills.map((s) => s.id);
    expect(ids).toContain("style/de-ai-tone");
    expect(ids).toContain("style/kazike-narrative");
    expect(ids).toContain("platform/wechat-longform");

    const deAi = skills.find((s) => s.id === "style/de-ai-tone")!;
    expect(deAi.category).toBe("style");
    expect(deAi.title).toContain("去 AI 腔");
    expect(deAi.source).toBeTruthy(); // 必须带署名
  });

  it("filters by category", async () => {
    const style = await listSkills(SKILLS_DIR, "style");
    expect(style.length).toBeGreaterThanOrEqual(2);
    expect(style.every((s) => s.category === "style")).toBe(true);
  });

  it("loads a single skill by id", async () => {
    const skill = await loadSkill(SKILLS_DIR, "platform/wechat-longform");
    expect(skill).not.toBeNull();
    expect(skill!.content).toContain("公众号");
    expect(skill!.content.length).toBeGreaterThan(100);
  });

  it("returns null for unknown id", async () => {
    expect(await loadSkill(SKILLS_DIR, "style/does-not-exist")).toBeNull();
    expect(await loadSkill(SKILLS_DIR, "bogus/x")).toBeNull();
  });
});
