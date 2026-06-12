/**
 * 卷舍引擎 · PATCH 契约解析/应用 单元测试
 * 锁:唯一命中才替换(零命中/多次命中/重叠丢弃并计数)、全失配回退原稿、
 *     合法空补丁与违约产出可区分(sawPatchMarker)、区块切分剥壳。
 */
import { describe, it, expect } from "vitest"
import { parseSpotFixPatches, applySpotFixPatches, extractTaggedBlocks } from "../src/agents/patches.js"

const DRAFT = "她没动。门铃又响了,第三次。她终于走过去,扭开锁。门外站着一个浑身湿透的男人。"

const patch = (target: string, replacement: string, n = 1) =>
  `--- PATCH ${n} ---\nTARGET_TEXT:\n${target}\nREPLACEMENT_TEXT:\n${replacement}\n--- END PATCH ---`

describe("parseSpotFixPatches", () => {
  it("解析多条补丁(序号可省略、容忍全角冒号),并收集 polisher-note", () => {
    const raw = [
      "=== PATCHES ===",
      patch("她没动。", "她数到第三声才动。"),
      "--- PATCH ---\nTARGET_TEXT:\n扭开锁\nREPLACEMENT_TEXT:\n拧开锁\n--- END PATCH ---",
      "[polisher-note] 第三段疑似伏笔缺口,需 reviewer 补。",
    ].join("\n")
    const p = parseSpotFixPatches(raw)
    expect(p.patches).toHaveLength(2)
    expect(p.patches[0]).toEqual({ targetText: "她没动。", replacementText: "她数到第三声才动。" })
    expect(p.notes).toEqual(["第三段疑似伏笔缺口,需 reviewer 补。"])
    expect(p.sawPatchMarker).toBe(true)
  })

  it("合法空补丁(只有 `=== PATCHES ===`)→ 0 条但 sawPatchMarker=true;纯正文 → false", () => {
    expect(parseSpotFixPatches("=== PATCHES ===")).toMatchObject({ patches: [], sawPatchMarker: true })
    expect(parseSpotFixPatches("这是一段普通正文。").sawPatchMarker).toBe(false)
  })

  it("TARGET 为空的块无定位意义,丢弃;REPLACEMENT 允许空串(=删除)", () => {
    const p = parseSpotFixPatches(patch("", "x") + "\n" + patch("她没动。", "", 2))
    expect(p.patches).toEqual([{ targetText: "她没动。", replacementText: "" }])
  })
})

describe("applySpotFixPatches", () => {
  it("唯一命中 → 替换并计数", () => {
    const r = applySpotFixPatches(DRAFT, patch("她没动。", "她数到第三声才动。"))
    expect(r.text).toContain("她数到第三声才动。")
    expect(r.text).not.toContain("她没动。")
    expect(r).toMatchObject({ totalCount: 1, appliedCount: 1, skippedCount: 0 })
  })

  it("零命中(没逐字拷)→ 丢弃;多次命中(定位歧义)→ 丢弃", () => {
    const multi = "门。门。"
    const r = applySpotFixPatches(multi, [patch("不存在的原文", "x"), patch("门。", "窗。", 2)].join("\n"))
    expect(r.text).toBe(multi)
    expect(r).toMatchObject({ appliedCount: 0, skippedCount: 2 })
  })

  it("重叠补丁只生效第一条(后一条对不上已替换文本 → skipped)", () => {
    const r = applySpotFixPatches(DRAFT, [patch("她没动。门铃又响了", "她没动。门铃停了"), patch("门铃又响了,第三次", "x", 2)].join("\n"))
    expect(r.text).toContain("门铃停了")
    expect(r).toMatchObject({ appliedCount: 1, skippedCount: 1 })
  })

  it("全部失配 → 原稿原样返回(绝不把补丁文本当正文)", () => {
    const r = applySpotFixPatches(DRAFT, patch("完全对不上的片段", "x"))
    expect(r.text).toBe(DRAFT)
    expect(r.appliedCount).toBe(0)
  })
})

describe("extractTaggedBlocks", () => {
  it("按 `=== TAG ===` 切块,正文相关区块可单独取出(剥壳)", () => {
    const raw = [
      "=== FIXED_ISSUES ===",
      "第1条:已修",
      "=== REVISED_CONTENT ===",
      "修订后的完整正文。",
      "=== UPDATED_STATE ===",
      "状态卡内容",
    ].join("\n")
    const b = extractTaggedBlocks(raw)
    expect(b["REVISED_CONTENT"]).toBe("修订后的完整正文。")
    expect(b["FIXED_ISSUES"]).toBe("第1条:已修")
    expect(b["REVISED_CONTENT"]).not.toContain("状态卡")
  })

  it("无区块 → 空对象;同名区块保留首个非空内容", () => {
    expect(extractTaggedBlocks("纯正文")).toEqual({})
    const b = extractTaggedBlocks("=== PATCHES ===\n=== PATCHES ===\n有内容")
    expect(b["PATCHES"]).toBe("有内容")
  })
})
