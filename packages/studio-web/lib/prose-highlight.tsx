"use client"

/**
 * 小说正文「语义分色」分词器 — 全站流式/正文共用一套(工作台 + 剧场)。
 *
 * 设计原则:克制。只给能可靠识别、且对读者有意义的语义上色,绝不靠正则乱猜人名地名。
 *   · 对话 dialog   — 「」『』""'' 引号内,显场景节奏(最高价值,纯正则,通用)
 *   · 人物 person   — story-graph 已知人物名 + 别名,字典精确匹配(零误报)
 *   · 地点 place    — story-graph 已知地点名 + 别名,字典精确匹配(零误报)
 *   · 时间 time     — 克制时间状语小词表 + 数字+时间量词,淡色后退作脚手架
 *   · num/dash/ellipsis/interjection/thought — 轻量标点/语气修饰
 *
 * 流式安全:右引号 / 闭括号未到时,把尾巴标记为 dialog 但保持开放,不抖动。
 * 性能:实体正则在 buildEntityDict 里一次性编译,主分词单遍 O(n)。
 */

import * as React from "react"
import useSWR from "swr"
import { fetchStoryGraph, type StoryGraphNode } from "@/lib/api/client"

export type ProseTokenKind =
  | "default" | "dialog" | "num" | "dash" | "ellipsis"
  | "interjection" | "thought" | "person" | "place" | "time"
export type ProseToken = { kind: ProseTokenKind; text: string }

/** 已编译的人物/地点字典(名称→类型 + 一次性正则) */
export type EntityDict = {
  re: RegExp | null
  type: Map<string, "person" | "place">
}

const OPEN_DIALOG = new Set(["「", "『", "“", "‘"])
const CLOSE_DIALOG: Record<string, string> = {
  "「": "」", "『": "』", "“": "”", "‘": "’",
}
const INTERJECTIONS = ["嗯", "啊", "咦", "哎", "唉", "哦", "呃", "嗨", "哈"]

// 时间状语:克制小词表 + 「数字+时间量词(+之后/之前)」。命中走淡色,不喧宾夺主。
const TIME_SRC =
  "(?:三更|半夜|深夜|凌晨|清晨|拂晓|破晓|黎明|傍晚|黄昏|日暮|正午|晌午|午时|子夜|" +
  "片刻|须臾|顷刻|半晌|霎时|刹那|转眼间|转眼|翌日|次日|当晚|当夜|当天|入夜|" +
  "天亮|天明|日出|日落|许久|良久|多年)" +
  "|(?:[一二三四五六七八九十百千两零0-9]+(?:年|个月|月|天|日|个时辰|时辰|小时|分钟|" +
  "刻钟|更|岁|周|星期|世纪|载|昼夜|春秋)(?:之后|之前|以后|以前|以来|后|前)?)"

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** 从 story-graph 节点构建人物/地点字典(只取主要实体,按 degree 截断,避免长尾噪音) */
export function buildEntityDict(nodes: StoryGraphNode[] | undefined | null): EntityDict {
  const type = new Map<string, "person" | "place">()
  if (nodes && nodes.length) {
    const sorted = [...nodes].sort((a, b) => b.degree - a.degree).slice(0, 140)
    for (const n of sorted) {
      const t: "person" | "place" | null =
        n.type === "person" ? "person" : n.type === "place" ? "place" : null
      if (!t) continue
      const names = [n.name, ...(n.aliases ?? [])]
      for (const nm of names) {
        const clean = (nm ?? "").trim()
        // 单字名易误命中正文常用字;只收 ≥2 字
        if (clean.length >= 2 && !type.has(clean)) type.set(clean, t)
      }
    }
  }
  const names = [...type.keys()].sort((a, b) => b.length - a.length).map(escapeRe)
  const alts: string[] = []
  if (names.length) alts.push("(" + names.join("|") + ")")
  alts.push("(" + TIME_SRC + ")")
  return { re: new RegExp(alts.join("|"), "g"), type }
}

/** 对一段 default 文本再按 实体/时间 切分(用 matchAll,全局迭代安全) */
function splitEntityTime(text: string, dict: EntityDict): ProseToken[] {
  if (!dict.re || !text) return text ? [{ kind: "default", text }] : []
  const hasNames = dict.type.size > 0
  const out: ProseToken[] = []
  let last = 0
  for (const m of text.matchAll(dict.re)) {
    const idx = m.index ?? 0
    if (idx > last) out.push({ kind: "default", text: text.slice(last, idx) })
    const nameHit = hasNames ? m[1] : undefined
    const timeHit = hasNames ? m[2] : m[1]
    if (nameHit) out.push({ kind: dict.type.get(nameHit) ?? "person", text: nameHit })
    else if (timeHit) out.push({ kind: "time", text: timeHit })
    last = idx + m[0].length
  }
  if (last < text.length) out.push({ kind: "default", text: text.slice(last) })
  return out
}

/** 主分词:单遍扫描标点/对话,再对 default 段做实体/时间二次切分(dict 可选) */
export function tokenizeProse(text: string, dict?: EntityDict | null): ProseToken[] {
  if (!text) return []
  const base: ProseToken[] = []
  let buf = ""
  const flush = () => { if (buf) { base.push({ kind: "default", text: buf }); buf = "" } }
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    // 对话 「...」 / "..."
    if (OPEN_DIALOG.has(ch)) {
      flush()
      const close = CLOSE_DIALOG[ch]
      const ci = text.indexOf(close, i + 1)
      if (ci >= 0) { base.push({ kind: "dialog", text: text.slice(i, ci + 1) }); i = ci + 1 }
      else { base.push({ kind: "dialog", text: text.slice(i) }); i = text.length }
      continue
    }
    // 心理独白 (...) / (...)
    if (ch === "(" || ch === "（") {
      const close = ch === "（" ? "）" : ")"
      const ci = text.indexOf(close, i + 1)
      if (ci >= 0 && ci - i < 80) {
        flush()
        base.push({ kind: "thought", text: text.slice(i, ci + 1) })
        i = ci + 1
        continue
      }
    }
    // 省略号 ……
    if (ch === "…" && next === "…") { flush(); base.push({ kind: "ellipsis", text: "……" }); i += 2; continue }
    // 破折号 ——
    if (ch === "—" && next === "—") { flush(); base.push({ kind: "dash", text: "——" }); i += 2; continue }
    // 数字串(西文)+ 紧跟的时间/量词单位
    if (ch >= "0" && ch <= "9") {
      flush()
      let j = i
      while (j < text.length && text[j] >= "0" && text[j] <= "9") j++
      const um = text.slice(j).match(/^(年|月|日|岁|章|节|万|千|百|号|秒|分钟|分|时)/)
      if (um) j += um[0].length
      base.push({ kind: "num", text: text.slice(i, j) })
      i = j
      continue
    }
    // 句首拟声叹词(嗯、啊…后跟标点)
    if (INTERJECTIONS.includes(ch)) {
      const prev = buf[buf.length - 1] ?? ""
      const isSentenceStart = !prev || /[。，！？；：、 \n]/.test(prev)
      if (isSentenceStart && /[，。！？…]/.test(next ?? "")) {
        flush()
        base.push({ kind: "interjection", text: ch })
        i += 1
        continue
      }
    }
    buf += ch
    i += 1
  }
  flush()
  // 二次:default 段再做 实体/时间 切分
  if (!dict || !dict.re) return base
  const out: ProseToken[] = []
  for (const t of base) {
    if (t.kind === "default") out.push(...splitEntityTime(t.text, dict))
    else out.push(t)
  }
  return out
}

/** 渲染为带语义 class 的 React 节点(default 不包 span,避免无谓 DOM) */
export function renderProse(
  text: string,
  dict?: EntityDict | null,
  keyPrefix = "",
): React.ReactNode[] {
  return tokenizeProse(text, dict).map((tk, i) =>
    tk.kind === "default"
      ? <React.Fragment key={keyPrefix + i}>{tk.text}</React.Fragment>
      : <span key={keyPrefix + i} className={`tk tk-${tk.kind}`}>{tk.text}</span>,
  )
}

const SOFT_SWR = { revalidateOnFocus: false, dedupingInterval: 60_000, shouldRetryOnError: false }

/** 拉一次 story-graph 并缓存,构建人物/地点字典;无 book 或拉取失败则退化为「仅对话/时间」 */
export function useEntityDict(bookId: string | null | undefined): EntityDict {
  const { data } = useSWR(
    bookId ? ["prose-entity-dict", bookId] : null,
    () => fetchStoryGraph(bookId as string),
    SOFT_SWR,
  )
  return React.useMemo(() => buildEntityDict(data?.nodes), [data])
}
