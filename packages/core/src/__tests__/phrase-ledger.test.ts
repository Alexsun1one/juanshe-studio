import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPhraseLedgerIssues,
  collectOverusedPhrases,
  extractPhraseCounts,
  loadOverusedPhrases,
  renderOverusedPhraseNotice,
  updatePhraseLedger,
} from "../pipeline/phrase-ledger.js";

describe("extractPhraseCounts", () => {
  it("counts clause-bounded n-grams and skips entity names", () => {
    const content = "他手指悬在屏幕上方，像在确认什么。林晚没说话。";
    const counts = extractPhraseCounts(content, ["林晚"]);
    expect(counts.get("悬在屏幕上方")).toBe(1);
    expect(counts.get("像在确认什么")).toBe(1);
    // 含实体名的 n-gram 不进账本
    for (const phrase of counts.keys()) {
      expect(phrase.includes("林晚")).toBe(false);
    }
  });

  it("filters neutral fragments and stop-char edges", () => {
    const counts = extractPhraseCounts("他走的时候看了一下窗外的天色。");
    expect(counts.has("的时候")).toBe(false);
    expect(counts.has("了一下")).toBe(false);
    for (const phrase of counts.keys()) {
      expect(phrase.startsWith("的")).toBe(false);
      expect(phrase.endsWith("的")).toBe(false);
    }
  });
});

describe("phrase ledger roundtrip", () => {
  it("accumulates once-per-chapter tics across chapters and stays idempotent per chapter", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "phrase-ledger-"));
    try {
      const tic = "手指悬在屏幕上方";
      for (let ch = 1; ch <= 4; ch++) {
        await updatePhraseLedger({
          bookDir,
          chapterNumber: ch,
          content: `第${ch}章的事。他${tic}，没点下去。`,
        });
      }
      // 同章重写:整章替换计数,不重复累计
      await updatePhraseLedger({
        bookDir,
        chapterNumber: 4,
        content: `第4章重写。他${tic}，还是没点下去。`,
      });

      const overused = await loadOverusedPhrases(bookDir);
      const hit = overused.find((p) => tic.includes(p.phrase) || p.phrase.includes("悬在屏幕"));
      expect(hit).toBeDefined();
      expect(hit!.count).toBe(4);
      expect(hit!.chapters).toBe(4);
    } finally {
      await rm(bookDir, { recursive: true, force: true });
    }
  });

  it("uses the character_matrix entity dictionary to keep names out of the ledger", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "phrase-ledger-entity-"));
    try {
      await mkdir(join(bookDir, "story"), { recursive: true });
      await writeFile(
        join(bookDir, "story", "character_matrix.md"),
        "## 陆沉舟\n- **定位**: 主角\n- **说话**: 短句,带电台腔\n",
        "utf-8",
      );
      for (let ch = 1; ch <= 4; ch++) {
        await updatePhraseLedger({
          bookDir,
          chapterNumber: ch,
          content: "陆沉舟点头。陆沉舟点头。",
        });
      }
      const overused = await loadOverusedPhrases(bookDir);
      expect(overused.some((p) => p.phrase.includes("陆沉舟"))).toBe(false);
    } finally {
      await rm(bookDir, { recursive: true, force: true });
    }
  });
});

describe("collectOverusedPhrases (in-memory, engine path)", () => {
  it("reports cross-chapter tics with minN=4", () => {
    const texts = Array.from({ length: 4 }, (_, i) => `第${i + 1}章。他像在确认什么，又把手机翻扣在桌面。`);
    const overused = collectOverusedPhrases(texts, { minN: 4 });
    expect(overused.length).toBeGreaterThan(0);
    expect(overused.some((p) => p.phrase.includes("确认") || p.phrase.includes("翻扣"))).toBe(true);
  });

  it("drops name-like grams that spike inside a single chapter when no entity dict is given", () => {
    const texts = ["陆沉舟说完，陆沉舟说完，陆沉舟说完，陆沉舟说完。", "别的章没有这个串。"];
    const overused = collectOverusedPhrases(texts, { minN: 4 });
    expect(overused.some((p) => p.phrase.includes("陆沉舟"))).toBe(false);
  });
});

describe("downstream rendering", () => {
  const overused = [{ phrase: "像在确认什么", count: 6, chapters: 6 }];

  it("renders the banned-expression notice for the writer context", () => {
    const notice = renderOverusedPhraseNotice(overused, "zh");
    expect(notice).toContain("已用滥");
    expect(notice).toContain("像在确认什么");
    expect(renderOverusedPhraseNotice([], "zh")).toBe("");
  });

  it("emits deterministic issues only when the new draft actually hits a banned phrase", () => {
    const hitIssues = buildPhraseLedgerIssues("他像在确认什么。她也像在确认什么。", overused, "zh");
    expect(hitIssues).toHaveLength(1);
    expect(hitIssues[0]!.severity).toBe("warning");
    expect(hitIssues[0]!.category).toBe("复读账本");
    expect(hitIssues[0]!.description).toContain("2 次");
    expect(buildPhraseLedgerIssues("干净的一章。", overused, "zh")).toHaveLength(0);
  });
});
