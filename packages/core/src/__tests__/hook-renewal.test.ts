import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maybeRenewCoreHooks } from "../utils/hook-renewal.js";
import { parsePendingHooksMarkdown } from "../utils/story-markdown.js";
import type { StoredHook } from "../state/memory-db.js";

function hook(overrides: Partial<StoredHook> = {}): StoredHook {
  return {
    hookId: "H001",
    startChapter: 1,
    type: "core",
    status: "open",
    lastAdvancedChapter: 1,
    expectedPayoff: "核心谜团",
    notes: "",
    coreHook: true,
    promoted: true,
    ...overrides,
  };
}

describe("maybeRenewCoreHooks", () => {
  it("appends new promoted core hooks when the active core pool is exhausted with two future volumes left", async () => {
    const root = await mkdtemp(join(tmpdir(), "hook-renewal-"));
    try {
      const storyDir = join(root, "story");
      await mkdir(storyDir, { recursive: true });
      await writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "| hook_id | start_chapter | type | status | last_advanced | expected_payoff | payoff_timing | depends_on | pays_off_in_arc | core_hook | half_life | promoted | notes |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
          "| H001 | 1 | core | resolved | 20 | 已回收 | mid-arc | none | 第一卷 | true | 12 | true | old core |",
        ].join("\n"),
        "utf-8",
      );

      const count = await maybeRenewCoreHooks({
        storyDir,
        chapterNumber: 24,
        targetChapters: 120,
        volumeMap: "第一卷 1-30章\n第二卷 31-60章\n第三卷 61-90章\n第四卷 91-120章",
        activeHooks: [hook({ status: "resolved", lastAdvancedChapter: 20 })],
        currentFocus: "主角刚拿到旧账本，但发现账本背后还有制度层黑手。",
        storyFrame: "",
        authorIntent: "",
        language: "zh",
      });

      expect(count).toBe(3);
      const updated = parsePendingHooksMarkdown(await readFile(join(storyDir, "pending_hooks.md"), "utf-8"));
      const renewalHooks = updated.filter((item) => /auto-renewal/.test(item.notes));
      expect(renewalHooks).toHaveLength(3);
      expect(renewalHooks.every((item) => item.coreHook === true && item.promoted === true)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does nothing when two active promoted core hooks remain", async () => {
    const root = await mkdtemp(join(tmpdir(), "hook-renewal-stable-"));
    try {
      const storyDir = join(root, "story");
      await mkdir(storyDir, { recursive: true });
      await writeFile(join(storyDir, "pending_hooks.md"), "# Hooks\n", "utf-8");

      const count = await maybeRenewCoreHooks({
        storyDir,
        chapterNumber: 24,
        targetChapters: 120,
        volumeMap: "第一卷 1-30章\n第二卷 31-60章\n第三卷 61-90章\n第四卷 91-120章",
        activeHooks: [
          hook({ hookId: "H001" }),
          hook({ hookId: "H002" }),
        ],
        currentFocus: "",
        storyFrame: "",
        authorIntent: "",
        language: "zh",
      });

      expect(count).toBe(0);
      await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8"))
        .resolves.toBe("# Hooks\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
