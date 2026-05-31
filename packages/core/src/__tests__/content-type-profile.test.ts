import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CONTENT_TYPE_PROFILES,
  getContentTypeProfile,
  listContentTypeProfiles,
} from "../content-type/profile.js";
import { loadSkill } from "../skills/registry.js";

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../skills");

describe("content type profiles", () => {
  it("exposes built-in profiles incl. novel and the article/newsletter types", () => {
    const ids = listContentTypeProfiles().map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "novel",
        "wechat_article",
        "xiaohongshu_note",
        "zhihu_answer",
        "x_thread",
        "newsletter",
      ]),
    );
  });

  it("novel profile uses the legacy pipeline and publishes to no social platform", () => {
    const novel = getContentTypeProfile("novel")!;
    expect(novel.usesLegacyNovelPipeline).toBe(true);
    expect(novel.platforms).toEqual([]);
    expect(novel.roles.length).toBeGreaterThan(0);
  });

  it("article profiles target a real renderer platform and have roles", () => {
    for (const id of ["wechat_article", "xiaohongshu_note", "zhihu_answer", "x_thread", "newsletter"]) {
      const p = getContentTypeProfile(id)!;
      expect(p.platforms.length).toBeGreaterThan(0);
      expect(p.roles.length).toBeGreaterThan(0);
    }
  });

  it("newsletter profile maps to the newsletter renderer and platform skill", () => {
    const p = getContentTypeProfile("newsletter")!;
    expect(p.projectType).toBe("newsletter");
    expect(p.platforms).toEqual(["newsletter"]);
    expect(p.skills).toContain("platform/newsletter");
    expect(p.lengthHint).toEqual({ min: 1000, max: 3500 });
  });

  it("xiaohongshu profile mounts the dedicated mobile note skill", () => {
    const p = getContentTypeProfile("xiaohongshu_note")!;
    expect(p.platforms).toEqual(["xiaohongshu"]);
    expect(p.skills).toContain("platform/xiaohongshu-note");
    expect(p.lengthHint).toEqual({ min: 250, max: 1200 });
  });

  it("every skill referenced by a profile actually exists in the registry (no dangling refs)", async () => {
    for (const profile of CONTENT_TYPE_PROFILES) {
      for (const skillId of profile.skills) {
        const skill = await loadSkill(SKILLS_DIR, skillId);
        expect(skill, `profile "${profile.id}" references missing skill "${skillId}"`).not.toBeNull();
      }
    }
  });

  it("returns undefined for unknown profile id", () => {
    expect(getContentTypeProfile("nope")).toBeUndefined();
  });
});
