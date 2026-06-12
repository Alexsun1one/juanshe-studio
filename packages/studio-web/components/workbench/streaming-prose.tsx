"use client"

/**
 * StreamingProse — 流式正文画布共用渲染(工作台写作器 / 编辑器 / 剧场)。
 *
 * 性能契约:流式只会在结尾追加。这里按段拆开、每段用 React.memo 冻结 ——
 * 除「正在生长的尾段」外,所有段的 props(字符串按值比较)不变,memo 直接跳过,
 * 每 tick 实际只重分词尾段,成本从 O(全文) 降到 O(尾段),长章后期不再掉帧。
 *
 * 同构契约:与定稿视图一样按段落 <p> 渲染(首行缩进/段距由各画布 CSS 决定),
 * 不再把全文塞进单个 pre-wrap 的 <p>,写完刷新不会「跳版式」。
 */
import * as React from "react"
import { renderProse, type EntityDict } from "@/lib/prose-highlight"

/**
 * 自动排版:把流式累计文本切成段落。
 *
 * 策略层级(从权威到启发):
 *   1. 优先按 `\n\n` 切显式段落
 *   2. 单 `\n` 也算段落分隔
 *   3. 完全没换行 → 启发式自动分段(像编辑帮你顺):
 *      a. 对话「...」/ 『...』/ "..."闭合后,如果后面接新对话 → 切段
 *      b. `——` 破折号常起新拍 → 切段(除非太短)
 *      c. 段累计超过 ~140 字 + 遇到句末标点 → 切段
 *      d. 最长不超过 400 字硬切
 *   (原剧场 splitParagraphs 抽到这里,三处流式画布共用一套分段语义。)
 */
export function splitStreamParagraphs(text: string): string[] {
  if (!text) return []
  // 1) 显式换行优先
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n")
  if (normalized.includes("\n\n")) {
    return normalized.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  }
  if (normalized.includes("\n")) {
    return normalized.split(/\n/).map((s) => s.trim()).filter(Boolean)
  }
  // 2) 启发式 — LLM 流式给一长串没换行时,用它分段
  return heuristicSplit(normalized)
}

/**
 * 启发式分段:扫一遍,在"自然换段点"切。
 *  - 对话闭合 `」` / `』` / `"` 后,下一个非标点字符又是开引号(对话 A 收 / 对话 B 起)→ 切
 *  - 段长度 >= 140 字且遇到 `。`/`!`/`?` → 切
 *  - `——` 后另起一段(除非段太短)
 *  - 硬上限 400 字
 *
 * 流式安全:不切最后一段(写手可能还在写),让 caret 跟住。
 */
function heuristicSplit(text: string): string[] {
  if (text.length < 140) return [text]
  const OPEN = new Set(["「", "『", "“", "‘"])
  const CLOSE = new Set(["」", "』", "”", "’"])
  const END = new Set(["。", "!", "?", "！", "?"])
  // 跟标点(逗号/分号/冒号/顿号 中英) — 这些 NEVER 可以做段首,出现就要"吸回"上一段
  const TRAILING_PUNCT = new Set([",", ",", ";", ";", ":", ":", "、", "。", "!", "?", "！", "?", "…", "—"])
  // 段长目标:140 字开始才考虑切,400 字必须切
  const SOFT = 140
  const HARD = 400

  const out: string[] = []
  let buf = ""
  let i = 0
  let inDialog = 0 // 嵌套深度(允许 「『...』」)

  // flush 时调用:把 buf 收到 out;清空 buf
  const flush = () => {
    const t = buf.trim()
    if (t) out.push(t)
    buf = ""
  }
  // 关键防御:每次推进 i 之前,如果 buf 现在是空的、而且 text[i] 是孤立的标点,
  // 把这个标点追加到上一段末尾,不要让它做新段开头(修"标点漂下去"bug)
  const absorbStrayPunct = () => {
    while (buf.length === 0 && i < text.length && TRAILING_PUNCT.has(text[i]!)) {
      if (out.length > 0) {
        out[out.length - 1] = out[out.length - 1] + text[i]
        i++
      } else {
        // 还没有 out 段?让标点进 buf 也算
        buf += text[i]
        i++
      }
    }
  }

  while (i < text.length) {
    absorbStrayPunct()
    if (i >= text.length) break
    const ch = text[i]
    const next = text[i + 1] ?? ""
    buf += ch

    // 引号嵌套深度
    if (OPEN.has(ch)) { inDialog++; i++; continue }
    if (CLOSE.has(ch)) {
      inDialog = Math.max(0, inDialog - 1)
      // 闭引号后只有一种情形切段:**下一个非标点字符也是开引号**(对话 A 收 / 对话 B 起)
      // 并且 buf 已经够长。其他情形(说话归属 / 动作 / 描述)绝不切 — 让它们留在同段
      // 跳过后面的连续标点,看真正的下一个字
      let k = i + 1
      while (k < text.length && TRAILING_PUNCT.has(text[k]!)) k++
      const realNext = text[k] ?? ""
      if (OPEN.has(realNext) && buf.length >= SOFT) {
        // 把闭引号后面的标点全部吃进本段
        while (i + 1 < k) { buf += text[i + 1]; i++ }
        flush()
        i++ // 跳过闭引号本身
        continue
      }
      i++
      continue
    }

    // 在对话内:不切
    if (inDialog > 0) { i++; continue }

    // 破折号 —— 一般起新拍:切段
    if (ch === "—" && next === "—" && buf.length >= SOFT) {
      // 把 buf 末尾这个 — 也算入上一段(buf 已经包含了 ch)
      buf += next
      i += 2
      flush()
      continue
    }

    // 句末 + 段够长 → 切
    if (END.has(ch) && buf.length >= SOFT) {
      // 把后续可能的"」"或其他闭引号 / 引号后的标点也吸进本段,再切
      let k = i + 1
      while (k < text.length && (CLOSE.has(text[k]!) || TRAILING_PUNCT.has(text[k]!))) {
        buf += text[k]
        k++
      }
      i = k
      flush()
      continue
    }

    // 硬上限:必须切,但找最近的句末/闭引号下手
    if (buf.length >= HARD && inDialog === 0) {
      let j = buf.length - 1
      while (j > 40 && !END.has(buf[j]!) && !CLOSE.has(buf[j]!)) j--
      if (j > 40) {
        out.push(buf.slice(0, j + 1).trim())
        buf = buf.slice(j + 1)
      } else {
        flush()
      }
      i++
      continue
    }

    i++
  }
  flush()
  return out
}

/** 单段:memo 冻结 —— props(字符串)不变就跳过重分词/重建 span。 */
const ProseParagraph = React.memo(function ProseParagraph({
  text,
  dict,
  className,
  caret,
}: {
  text: string
  dict?: EntityDict | null
  className?: string
  caret?: React.ReactNode
}) {
  return (
    <p className={className}>
      {renderProse(text, dict)}
      {caret}
    </p>
  )
})

export function StreamingProse({
  text,
  dict,
  paragraphClassName,
  caret,
}: {
  text: string
  dict?: EntityDict | null
  /** 段落 class(剧场 = theater-paragraph;工作台/编辑器用容器既有的 p 样式则不传) */
  paragraphClassName?: string
  /** 尾段光标(各画布自带样式:.dash-caret / .type-caret / .theater-caret);不流式时传 null */
  caret?: React.ReactNode
}) {
  const paras = React.useMemo(() => splitStreamParagraphs(text), [text])
  return (
    <>
      {paras.map((p, i) => (
        <ProseParagraph
          key={i}
          text={p}
          dict={dict}
          className={paragraphClassName}
          caret={i === paras.length - 1 ? caret : undefined}
        />
      ))}
    </>
  )
}
