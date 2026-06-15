import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 把 LLM 压缩这一步换成确定性桩,使本测试不依赖任何真实模型(也不受 MiMo 400 影响)。
vi.mock("../llm/provider.js", () => ({
  chatCompletion: vi.fn(async () => ({
    content: "【卷一压缩】陆星河重生归位,以家庭逆袭与首个钩子收束第一卷。",
    usage: {},
  })),
}));

import { ConsolidatorAgent } from "../agents/consolidator.js";

describe("ConsolidatorAgent.consolidate (端到端 · 桩化 LLM)", () => {
  let bookDir: string;

  beforeEach(async () => {
    bookDir = await mkdtemp(join(tmpdir(), "consolidate-"));
    const storyDir = join(bookDir, "story");
    await mkdir(join(storyDir, "outline"), { recursive: true });
    // 跨行 范围 写法(就是真实 volume_map.md 的格式),约 2 章一卷便于触发"已完成卷"
    await writeFile(
      join(storyDir, "outline", "volume_map.md"),
      [
        "# 卷纲地图",
        "",
        "## 第一卷：退烧之始",
        "- 范围：第 1-2 章",
        "- KR1：陆星河重生归位",
        "- KR2：沈清禾获得安全感",
        "- KR3：第一个钩子完成首轮兑现",
        "- 第 1 章：退烧",
        "",
        "## 第二卷：更大的风暴",
        "- 范围：第 3-4 章",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(storyDir, "chapter_summaries.md"),
      [
        "| 章节 | 标题 | 出场人物 | 关键事件 |",
        "|---|---|---|---|",
        "| 1 | 退烧 | 陆星河 | 重生归位 |",
        "| 2 | 选择 | 陆星河,沈清禾 | 第一次反杀 |",
        "| 3 | 旧账 | 陆星河 | 风暴起 |",
        "",
      ].join("\n"),
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(bookDir, { recursive: true, force: true });
  });

  it("把已完成卷压成 volume_summaries.md、归档明细、并把 chapter_summaries.md 收敛到当前卷", async () => {
    const agent = new ConsolidatorAgent({
      client: { provider: "test" } as unknown as ConstructorParameters<typeof ConsolidatorAgent>[0]["client"],
      model: "test-model",
      projectRoot: bookDir,
    });

    const result = await agent.consolidate(bookDir);

    // 第一卷(1-2)已完成(maxChapter=3 ≥ 2);第二卷(3-4)未完成,保留逐章明细
    expect(result.archivedVolumes).toBe(1);
    expect(result.retainedChapters).toBe(1);

    // 卷级压缩落盘,含卷名与桩摘要
    const volSummaries = await readFile(join(bookDir, "story", "volume_summaries.md"), "utf-8");
    expect(volSummaries).toContain("第一卷");
    expect(volSummaries).toContain("【卷一压缩】");

    // 全程明细仍在归档里(冷存,可回溯)——压缩不等于丢失
    const archived = await readdir(join(bookDir, "story", "summaries_archive"));
    expect(archived).toContain("vol_1-2.md");

    // 关键:chapter_summaries.md 只剩未完成卷的逐章(ch3),ch1/ch2 已移出 → 每章注入恒定有界,不随章数膨胀
    const trimmed = await readFile(join(bookDir, "story", "chapter_summaries.md"), "utf-8");
    expect(trimmed).toContain("| 3 |");
    expect(trimmed).not.toContain("| 1 |");
    expect(trimmed).not.toContain("| 2 |");

    const cadence = await readFile(join(bookDir, "story", "volume_chapter_cadence.md"), "utf-8");
    expect(cadence).toContain("卷内章级节奏细纲");
    expect(cadence).toContain("| 4 |");
    const krProgress = JSON.parse(await readFile(join(bookDir, "story", "progress_against_volume_kr.json"), "utf-8")) as {
      next_chapter: number;
      kr_progress: Array<{ kr_id: string }>;
    };
    expect(krProgress.next_chapter).toBe(4);
    expect(krProgress.kr_progress.map((kr) => kr.kr_id)).toEqual(["KR1", "KR2", "KR3"]);
  });
});
