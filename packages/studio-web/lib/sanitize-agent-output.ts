import * as React from "react"

const RUNTIME_MARKER_RE = /={3,}\s*RUNTIME_[A-Z0-9_:-]+\s*={0,}/gi

export function sanitizeAgentOutput(text: string | null | undefined): string {
  if (!text) return ""

  const visibleLines: string[] = []
  let skippingRuntimeBlock = false

  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = stripInternalHookMarkers(rawLine)
    if (/^\s*={3,}\s*RUNTIME_[A-Z0-9_:-]+\s*={0,}\s*$/i.test(line)) {
      skippingRuntimeBlock = true
      continue
    }
    if (skippingRuntimeBlock && /^\s*={3,}\s*(?!RUNTIME_)[A-Z0-9_ -]+\s*={3,}\s*$/i.test(line)) {
      skippingRuntimeBlock = false
    }
    if (skippingRuntimeBlock) continue
    visibleLines.push(line.replace(RUNTIME_MARKER_RE, ""))
  }

  return visibleLines
    .join("\n")
    .split("\n")
    .map(stripInternalHookMarkers)
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function stripInternalHookMarkers(line: string): string {
  return line
    .replace(/\[?\bH00[A-Z]\b\]?(?:\s*[\/,，、]\s*\[?\bH00[A-Z]\b\]?)+\s*[:：-]?\s*/g, "")
    .replace(/\[?\bH00[A-Z]\b\]?\s*[:：-]?\s*/g, "")
}

type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; rows: string[][] }

export function renderAgentOutputMarkdown(
  text: string | null | undefined,
  options: { className?: string; keyPrefix?: string } = {},
): React.ReactNode {
  const blocks = parseAgentMarkdown(sanitizeAgentOutput(text))
  if (blocks.length === 0) return null

  const keyPrefix = options.keyPrefix ?? "agent-md"
  return React.createElement(
    "div",
    { className: options.className ?? "space-y-2 whitespace-normal break-words" },
    blocks.map((block, index) => renderBlock(block, `${keyPrefix}-${index}`)),
  )
}

export function renderAgentOutputInline(
  text: string | null | undefined,
  keyPrefix = "agent-inline",
): React.ReactNode {
  const clean = sanitizeAgentOutput(text)
  if (!clean) return null
  return renderInline(clean, keyPrefix)
}

function parseAgentMarkdown(text: string): MarkdownBlock[] {
  const lines = text.split("\n")
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]?.trim() ?? ""
    if (!line) {
      index++
      continue
    }

    const tableStart = index
    const tableLines: string[] = []
    while (index < lines.length && isTableLine(lines[index] ?? "")) {
      tableLines.push(lines[index] ?? "")
      index++
    }
    if (tableLines.length >= 2 && tableLines.some(isTableSeparatorLine)) {
      blocks.push({
        type: "table",
        rows: tableLines
          .filter((row) => !isTableSeparatorLine(row))
          .map(parseTableRow)
          .filter((row) => row.length > 0),
      })
      continue
    }
    index = tableStart

    const listMatch = line.match(/^(\d+[.)]|[-*])\s+(.+)$/)
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1])
      const items: string[] = []
      while (index < lines.length) {
        const itemMatch = (lines[index] ?? "").trim().match(/^(\d+[.)]|[-*])\s+(.+)$/)
        if (!itemMatch || /^\d/.test(itemMatch[1]) !== ordered) break
        items.push(itemMatch[2])
        index++
      }
      blocks.push({ type: "list", ordered, items })
      continue
    }

    const paragraphLines: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ""
      if (!current.trim()) break
      if (isTableLine(current) || current.trim().match(/^(\d+[.)]|[-*])\s+(.+)$/)) break
      paragraphLines.push(current.trim())
      index++
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join("\n") })
  }

  return blocks
}

function renderBlock(block: MarkdownBlock, key: string): React.ReactElement {
  if (block.type === "paragraph") {
    return React.createElement(
      "p",
      { key, className: "m-0" },
      renderInlineWithBreaks(block.text, key),
    )
  }
  if (block.type === "list") {
    const tag = block.ordered ? "ol" : "ul"
    return React.createElement(
      tag,
      { key, className: block.ordered ? "m-0 list-decimal space-y-1 pl-5" : "m-0 list-disc space-y-1 pl-5" },
      block.items.map((item, index) =>
        React.createElement("li", { key: `${key}-li-${index}` }, renderInline(item, `${key}-li-${index}`)),
      ),
    )
  }
  return React.createElement(
    "div",
    { key, className: "max-w-full overflow-x-auto" },
    React.createElement(
      "table",
      { className: "w-full border-collapse text-left text-[11px]" },
      React.createElement(
        "tbody",
        null,
        block.rows.map((row, rowIndex) =>
          React.createElement(
            "tr",
            { key: `${key}-tr-${rowIndex}`, className: "border-border border-b last:border-0" },
            row.map((cell, cellIndex) =>
              React.createElement(
                rowIndex === 0 ? "th" : "td",
                {
                  key: `${key}-td-${rowIndex}-${cellIndex}`,
                  className: rowIndex === 0
                    ? "text-foreground px-2 py-1 font-semibold"
                    : "text-muted-foreground px-2 py-1 align-top",
                },
                renderInline(cell, `${key}-cell-${rowIndex}-${cellIndex}`),
              ),
            ),
          ),
        ),
      ),
    ),
  )
}

function renderInlineWithBreaks(text: string, keyPrefix: string): React.ReactNode[] {
  return text.split("\n").flatMap((line, index) => {
    const nodes = renderInline(line, `${keyPrefix}-line-${index}`)
    return index === 0 ? nodes : [React.createElement("br", { key: `${keyPrefix}-br-${index}` }), ...nodes]
  })
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const pattern = /\*\*([^*]+)\*\*/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    nodes.push(React.createElement("strong", { key: `${keyPrefix}-strong-${nodes.length}` }, match[1]))
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.includes("|")
}

function isTableSeparatorLine(line: string): boolean {
  return parseTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell))
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
}
