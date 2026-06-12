/**
 * 卷舍 · PATCH 契约的管线侧(纯函数,零 LLM,可单测)
 *
 * reviser/polisher 的角色提示词把产出定成"定点补丁 / 文本区块"而非裸正文(省 token、改动可追溯、
 * 防 fast 模型整章重写引入事实漂移)。这里是管线真正吃下这份契约的确定性解析层:
 *  - applySpotFixPatches:TARGET_TEXT 必须在当前稿 indexOf **唯一**命中才替换;零命中(没逐字拷 /
 *    被前一条补丁吞掉)与多次命中(定位歧义)一律丢弃并计数;无一命中时返回原稿——绝不把补丁文本当正文。
 *  - extractTaggedBlocks:切 `=== TAG ===` 区块(FIXED_ISSUES / PATCHES / REVISED_CONTENT / UPDATED_*),
 *    revising 据此剥壳,只让正文相关部分入库。
 */

export interface SpotFixPatch {
  readonly targetText: string
  readonly replacementText: string
}

export interface ParsedSpotFix {
  readonly patches: readonly SpotFixPatch[]
  /** `[polisher-note]` 行:润色师上报的结构问题(交还 reviewer,不进正文) */
  readonly notes: readonly string[]
  /** 是否出现 PATCH 契约标记(用于区分"合法空补丁"与"模型违约输出了别的东西") */
  readonly sawPatchMarker: boolean
}

// 补丁块:序号可省略,TARGET_TEXT/REPLACEMENT_TEXT 标签后允许半角/全角冒号
const PATCH_BLOCK_RE =
  /---\s*PATCH(?:\s*\d+)?\s*---\s*TARGET_TEXT\s*[::]\s*([\s\S]*?)\s*REPLACEMENT_TEXT\s*[::]\s*([\s\S]*?)\s*---\s*END\s*PATCH\s*---/g

export function parseSpotFixPatches(raw: string): ParsedSpotFix {
  const sawPatchMarker = /===\s*PATCHES\s*===/.test(raw) || /---\s*PATCH(?:\s*\d+)?\s*---/.test(raw)
  const patches: SpotFixPatch[] = []
  for (const m of raw.matchAll(PATCH_BLOCK_RE)) {
    const targetText = (m[1] ?? "").trim()
    // REPLACEMENT 允许空串(= 删除),TARGET 为空的块无定位意义,丢弃
    if (targetText) patches.push({ targetText, replacementText: (m[2] ?? "").trim() })
  }
  const notes = [...raw.matchAll(/^\[polisher-note\]\s*(.+)$/gm)]
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean)
  return { patches, notes, sawPatchMarker }
}

export interface SpotFixResult {
  /** 应用补丁后的全文(无一命中时 = 原稿) */
  readonly text: string
  readonly totalCount: number
  readonly appliedCount: number
  /** 失配被丢弃的补丁数(零命中 / 多次命中) */
  readonly skippedCount: number
  readonly notes: readonly string[]
  readonly sawPatchMarker: boolean
}

/**
 * 解析补丁文本并应用到 draft。
 * 按出现顺序逐条应用;后续补丁基于"已替换后的文本"判定唯一命中,因此互相重叠的补丁
 * 天然只生效第一条(后一条对不上 → 计入 skipped),不会产生交叉污染。
 */
export function applySpotFixPatches(draft: string, patchText: string): SpotFixResult {
  const { patches, notes, sawPatchMarker } = parseSpotFixPatches(patchText)
  let text = draft
  let appliedCount = 0
  let skippedCount = 0
  for (const p of patches) {
    const at = text.indexOf(p.targetText)
    if (at === -1 || text.indexOf(p.targetText, at + p.targetText.length) !== -1) {
      skippedCount++
      continue
    }
    text = text.slice(0, at) + p.replacementText + text.slice(at + p.targetText.length)
    appliedCount++
  }
  return { text, totalCount: patches.length, appliedCount, skippedCount, notes, sawPatchMarker }
}

/** 切 `=== TAG ===` 区块;同名区块出现多次时保留首个非空内容 */
export function extractTaggedBlocks(raw: string): Record<string, string> {
  const marks: Array<{ tag: string; start: number; bodyStart: number }> = []
  for (const m of raw.matchAll(/===\s*([A-Z_]+)\s*===/g)) {
    marks.push({ tag: m[1] ?? "", start: m.index ?? 0, bodyStart: (m.index ?? 0) + m[0].length })
  }
  const blocks: Record<string, string> = {}
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!
    const body = raw.slice(mark.bodyStart, i + 1 < marks.length ? marks[i + 1]!.start : raw.length).trim()
    if (!(mark.tag in blocks) || !blocks[mark.tag]) blocks[mark.tag] = body
  }
  return blocks
}
