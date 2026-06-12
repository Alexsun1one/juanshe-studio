/**
 * 复读账本 · 实体保护回归测试(expandEntityGuardTerms / collectOverusedPhrasesGuarded /
 * loadBookEntityNames / buildBookPriorContext 实体接线)
 * 锁:① 含人名(及其 ≥2 字子串)的候选短语被豁免,绝不进「本章禁用」清单——
 *       否则等于禁止写手提主角名,是质量事故级风险;
 *     ② 普通口头禅 tic 不受实体保护影响,照常命中;
 *     ③ 实体名单为空时行为与 core collectOverusedPhrases 现有启发式逐字节一致(降级安全);
 *     ④ 实体名单每书只读一次盘(缓存),矩阵缺失/非法 bookId 优雅退回空名单。
 */
import { describe, it, expect } from "vitest"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  expandEntityGuardTerms,
  collectOverusedPhrasesGuarded,
  loadBookEntityNames,
  buildBookPriorContext,
} from "../engine-bridge"
import { collectOverusedPhrases } from "@juanshe/core"
import type { BookPlan, ChapterSpec, ChapterResult } from "@juanshe/engine"

// 4 章成稿:每章各 1 次实体短语(「林晚秋抬起头来」)+ 1 次真 tic(「手指悬在屏幕上方」),
// 填充句各不相同——实体与 tic 全书均 4 次(达 ≥4 阈值)、单章均次 1(不触发内置疑似实体守卫),
// 即未接实体字典时两者都会被当 tic 报出,正是要修的事故场景。
const FILLERS = ["春雨敲着瓦片不停歇。", "夏蝉聒噪得叫人心烦。", "秋叶落满了青石台阶。", "冬雪压弯了山门松枝。"]
const TEXTS = FILLERS.map((filler) => `${filler}林晚秋抬起头来。手指悬在屏幕上方。`)

describe("expandEntityGuardTerms · 实体名展开守卫词", () => {
  it("名字展开全部 ≥2 字连续子串(候选 gram 常只含名字片段,只匹配全名会漏)", () => {
    const terms = expandEntityGuardTerms(["林晚秋"])
    expect(terms).toContain("林晚秋")
    expect(terms).toContain("林晚")
    expect(terms).toContain("晚秋")
    expect(terms.every((t) => t.length >= 2)).toBe(true) // 单字不收
  })
  it("「主名（别称/别称）」原文:主名与各别称都展开", () => {
    const terms = expandEntityGuardTerms(["沈清禾（清禾/阿禾）"])
    expect(terms).toContain("沈清禾")
    expect(terms).toContain("清禾")
    expect(terms).toContain("阿禾")
  })
  it("单字名/空串剔除,不产生守卫词", () => {
    expect(expandEntityGuardTerms(["周", "", "  "])).toEqual([])
  })
})

describe("collectOverusedPhrasesGuarded · 剔实体版收集", () => {
  it("未接实体字典时人名短语确实会被误报(事故场景成立性自检)", () => {
    const unguarded = collectOverusedPhrasesGuarded(TEXTS, [], { minN: 4 })
    expect(unguarded.some((p) => /林晚|晚秋/.test(p.phrase))).toBe(true)
  })
  it("含人名(及其 ≥2 字子串)的短语被豁免,普通 tic 仍命中", () => {
    const guarded = collectOverusedPhrasesGuarded(TEXTS, ["林晚秋"], { minN: 4 })
    expect(guarded.some((p) => /林晚|晚秋/.test(p.phrase))).toBe(false) // 实体豁免
    expect(guarded.some((p) => p.phrase.includes("悬在屏幕"))).toBe(true) // 真 tic 照报
  })
  it("实体为空:行为与 core collectOverusedPhrases 现有启发式完全一致(降级安全)", () => {
    expect(collectOverusedPhrasesGuarded(TEXTS, [], { minN: 4 }))
      .toEqual(collectOverusedPhrases(TEXTS, { minN: 4 }))
  })
})

// ── buildBookPriorContext 接线:实体名单透传进「已用滥表达」清单 ──────────────────
const spec = (n: number): ChapterSpec => ({
  number: n,
  title: `章名${n}`,
  goal: `目标${n}`,
  targetWordCount: 1000,
  dependsOn: n > 1 ? [n - 1] : [],
  plantForeshadowIds: [],
  payoffForeshadowIds: [],
  entityIds: [],
})

const plan: BookPlan = {
  bookId: "b",
  title: { zh: "测试书" },
  lang: "zh",
  bookBible: "",
  chapters: [1, 2, 3, 4, 5].map(spec),
  graph: { bookId: "b", entities: [], relations: [], foreshadows: [], timeline: [], chapterDeps: {} },
}

const result = (n: number, content: string): ChapterResult => ({
  chapterNumber: n,
  status: "completed",
  reason: "completed",
  finalState: { artifacts: { publishing: { chapter: { content } } } } as unknown as ChapterResult["finalState"],
  overall: 90,
})

describe("buildBookPriorContext · 实体名单接线", () => {
  const done = new Map(TEXTS.map((text, i) => [i + 1, result(i + 1, text)] as const))
  const noticeOf = (prior: string) => {
    const idx = prior.indexOf("【本书已用滥的表达】")
    return idx >= 0 ? prior.slice(idx) : ""
  }
  it("传实体名单:禁用清单不含人名短语,真 tic 照常入清单", () => {
    const prior = buildBookPriorContext(plan, spec(5), done, ["林晚秋"])
    const notice = noticeOf(prior)
    expect(notice).toBeTruthy()
    expect(notice).toContain("悬在屏幕")
    expect(/林晚|晚秋/.test(notice)).toBe(false)
  })
  it("不传实体名单(默认空):退回现有行为,清单会含人名短语(向后兼容口径)", () => {
    const notice = noticeOf(buildBookPriorContext(plan, spec(5), done))
    expect(/林晚|晚秋/.test(notice)).toBe(true)
  })
})

// ── loadBookEntityNames:每书一次读盘 + 缓存 + 各种失败降级 ───────────────────────
const MATRIX_MD = `## 林晚秋
- **定位**: 主角
- **关系**: 谢沉舟（盟友/Ch3）| 青云观（藏身处/Ch4）

## 谢沉舟
- **定位**: 盟友
- **动机**: 查清旧案真相。
`

describe("loadBookEntityNames · 实体名单加载与缓存", () => {
  it("读 story/character_matrix.md:主名 + 关系对象名(地点也在其中)都收", async () => {
    const root = await mkdtemp(join(tmpdir(), "autow-guard-"))
    const storyDir = join(root, "books", "book-a", "story")
    await mkdir(storyDir, { recursive: true })
    await writeFile(join(storyDir, "character_matrix.md"), MATRIX_MD, "utf-8")
    const names = await loadBookEntityNames(root, "book-a")
    expect(names).toContain("林晚秋")
    expect(names).toContain("谢沉舟")
    expect(names).toContain("青云观") // 关系对象=地点,一并保护
  })
  it("每书只读一次盘:首读后改写矩阵文件,再读仍取缓存结果", async () => {
    const root = await mkdtemp(join(tmpdir(), "autow-guard-"))
    const storyDir = join(root, "books", "book-b", "story")
    await mkdir(storyDir, { recursive: true })
    await writeFile(join(storyDir, "character_matrix.md"), MATRIX_MD, "utf-8")
    const first = await loadBookEntityNames(root, "book-b")
    await writeFile(join(storyDir, "character_matrix.md"), "## 顾长风\n- **定位**: 反派\n", "utf-8")
    const second = await loadBookEntityNames(root, "book-b")
    expect(second).toEqual(first) // 缓存命中,未重读盘
    expect(second).toContain("林晚秋")
  })
  it("矩阵缺失 → 空名单(调用方退回启发式),绝不抛错", async () => {
    const root = await mkdtemp(join(tmpdir(), "autow-guard-"))
    await expect(loadBookEntityNames(root, "no-such-book")).resolves.toEqual([])
  })
  it("非法 bookId(路径穿越)→ 空名单,不碰盘", async () => {
    const root = await mkdtemp(join(tmpdir(), "autow-guard-"))
    await expect(loadBookEntityNames(root, "../escape")).resolves.toEqual([])
  })
})
