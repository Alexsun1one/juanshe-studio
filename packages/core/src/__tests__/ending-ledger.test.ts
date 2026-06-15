import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTextDiversityBrief,
  extractEndingSignature,
  upsertEndingLedgerFile,
} from "../utils/ending-ledger.js";
import { analyzeLongSpanFatigue } from "../utils/long-span-fatigue.js";

const roots: string[] = [];

async function createBookDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const bookDir = join(root, "book");
  await mkdir(join(bookDir, "story"), { recursive: true });
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  return bookDir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ending ledger / text diversity engine", () => {
  it("extracts and persists ending shape, register, tempo, protagonist tic, and side portrait", async () => {
    const bookDir = await createBookDir("autow-ending-ledger-extract-");
    const storyDir = join(bookDir, "story");
    const signature = extractEndingSignature({
      chapterNumber: 1,
      language: "zh",
      content: [
        "# 第1章 旧账",
        "",
        "穿工装的男人站在货架边，指甲缝里嵌着黑油污，说自己攒钱攒了三年。",
        "沈砚攥着纸条，没有接话。",
        "门把手转动了。",
      ].join("\n"),
    });

    expect(signature.endingShape).toBe("动作悬念");
    expect(signature.protagonistActions).toContain("攥纸条");
    expect(signature.sidePortraits).toContain("工装/油污/攒钱");

    await upsertEndingLedgerFile({ storyDir, signature, language: "zh" });
    const ledger = await readFile(join(storyDir, "ending_ledger.md"), "utf-8");
    expect(ledger).toContain("| 1 | 动作悬念");
    expect(ledger).toContain("攥纸条");
    expect(ledger).toContain("工装/油污/攒钱");

    const brief = await buildTextDiversityBrief({
      storyDir,
      currentChapter: 2,
      keepRecent: 10,
      language: "zh",
    });
    expect(brief).toContain("文本多样性 / 结尾账本");
    expect(brief).toContain("动作悬念");
    expect(brief).toContain("攥纸条");
    expect(brief).toContain("工装/油污/攒钱");
    expect(brief).toContain("register=");
  });

  it("raises soft cadence pressure for repeated ending shape, register, and tempo", async () => {
    const bookDir = await createBookDir("autow-ending-ledger-cadence-");
    await writeFile(join(bookDir, "story", "ending_ledger.md"), [
      "# 结尾账本",
      "",
      "| 章节 | 结尾形状 | 结尾签名 | Register | Tempo | 主角外化动作 | 客人/配角画像 | 结尾摘录 |",
      "|------|----------|----------|----------|----------|--------------|----------------|----------|",
      "| 1 | 残句留白 | 残句留白：他没有回头。 | 阴郁内省 | 慢观察 | 沉默观察 |  | 他没有回头。 |",
      "| 2 | 残句留白 | 残句留白：他没有开口。 | 阴郁内省 | 慢观察 | 沉默观察 |  | 他没有开口。 |",
      "",
    ].join("\n"), "utf-8");

    const result = await analyzeLongSpanFatigue({
      bookDir,
      chapterNumber: 3,
      chapterContent: "他想起昨夜的雨，记得柜台边那盏灯，也意识到自己已经看了很久。沈砚沉默着站在门口，慢慢把视线挪开。最后，他没有回头。",
      language: "zh",
    });

    expect(result.issues.some((issue) => issue.category === "结尾形状重复")).toBe(true);
    expect(result.issues.some((issue) => issue.category === "文本气质单调")).toBe(true);
    expect(result.issues.some((issue) => issue.category === "节奏档位单调")).toBe(true);
  });

  it("raises soft cadence pressure when the protagonist tic repeats", async () => {
    const bookDir = await createBookDir("autow-ending-ledger-action-");
    await writeFile(join(bookDir, "story", "ending_ledger.md"), [
      "# 结尾账本",
      "",
      "| 章节 | 结尾形状 | 结尾签名 | Register | Tempo | 主角外化动作 | 客人/配角画像 | 结尾摘录 |",
      "|------|----------|----------|----------|----------|--------------|----------------|----------|",
      "| 1 | 明确落点 | 明确落点：账本留下。 | 中性推进 | 中 | 擦柜台 |  | 账本留下。 |",
      "",
    ].join("\n"), "utf-8");

    const result = await analyzeLongSpanFatigue({
      bookDir,
      chapterNumber: 2,
      chapterContent: "沈砚擦着柜台，抹布从收银台边缘压过去。他把账本递给来人。最后，门外有人敲响玻璃。",
      language: "zh",
    });

    expect(result.issues.some((issue) => issue.category === "招牌小动作重复")).toBe(true);
  });

  it("raises soft cadence pressure when side-character portrait templates repeat", async () => {
    const bookDir = await createBookDir("autow-ending-ledger-portrait-");
    await writeFile(join(bookDir, "story", "ending_ledger.md"), [
      "# 结尾账本",
      "",
      "| 章节 | 结尾形状 | 结尾签名 | Register | Tempo | 主角外化动作 | 客人/配角画像 | 结尾摘录 |",
      "|------|----------|----------|----------|----------|--------------|----------------|----------|",
      "| 1 | 明确落点 | 明确落点：他把钱留下。 | 中性推进 | 中 |  | 工装/油污/攒钱 | 他把钱留下。 |",
      "",
    ].join("\n"), "utf-8");

    const result = await analyzeLongSpanFatigue({
      bookDir,
      chapterNumber: 2,
      chapterContent: "新来的客人穿着洗得发白的工装，指甲缝里还有黑油污。他说自己攒钱攒了很久，只想买一封像样的信。最后，沈砚把纸推回去。",
      language: "zh",
    });

    expect(result.issues.some((issue) => issue.category === "配角画像重复")).toBe(true);
  });

  it("no-ops gracefully for old books without ending_ledger.md", async () => {
    const bookDir = await createBookDir("autow-ending-ledger-noop-");
    const storyDir = join(bookDir, "story");

    await expect(buildTextDiversityBrief({
      storyDir,
      currentChapter: 7,
      keepRecent: 10,
      language: "zh",
    })).resolves.toBeUndefined();

    const result = await analyzeLongSpanFatigue({
      bookDir,
      chapterNumber: 7,
      chapterContent: "沈砚把信放下。门外雨停了。",
      language: "zh",
    });

    expect(result.issues.some((issue) =>
      ["结尾形状重复", "文本气质单调", "节奏档位单调", "招牌小动作重复", "配角画像重复"].includes(issue.category),
    )).toBe(false);
  });
});
