import { NextResponse } from "next/server"

import { isRecord, proxyJSONOrFallback } from "@/lib/api/facade"
import type { BookDescriptionPayload, BookDescriptionResult } from "@/lib/api/types"

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(req: Request, ctx: RouteContext) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/description`,
    () => NextResponse.json(fallbackResult(id)),
    { transform: (data) => normalizeResult(data, id) },
  )
}

export async function POST(req: Request, ctx: RouteContext) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/description`,
    () => NextResponse.json(fallbackResult(id)),
    { method: "POST", transform: (data) => normalizeResult(data, id) },
  )
}

export async function PUT(req: Request, ctx: RouteContext) {
  const { id } = await ctx.params
  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/description`,
    () => NextResponse.json(fallbackResult(id)),
    { method: "PUT", transform: (data) => normalizeResult(data, id) },
  )
}

function normalizeResult(data: unknown, bookId: string): BookDescriptionResult {
  const source = isRecord(data) ? data : {}
  const descriptionSource = isRecord(source.description)
    ? source.description
    : source
  const description = normalizeDescription(descriptionSource, bookId)
  return {
    ok: true,
    bookId: typeof source.bookId === "string" ? source.bookId : bookId,
    engine: typeof source.engine === "string" ? source.engine : undefined,
    description,
  }
}

function normalizeDescription(
  source: Record<string, unknown>,
  bookId: string,
): BookDescriptionPayload {
  const title = titleFromId(bookId)
  const oneLine = text(
    source.oneLine,
    `《${title}》是一部围绕主角命运反转、隐秘压力与连续升级展开的长篇小说。`,
  )
  const shortIntro = text(
    source.shortIntro,
    `主角被卷入一场看似普通、实则层层失控的事件。每一章都推进一个新危机，也埋下一条可回收的线索。`,
  )
  const fullIntro = text(
    source.fullIntro,
    `${shortIntro}作品适合以稳定连载节奏发布，简介、卖点和标签可直接复制到小说站后台后再按平台口吻微调。`,
  )
  const sellingPoints = stringList(source.sellingPoints, [
    "开局冲突明确，章节钩子连续",
    "伏笔账本可追踪，适合长线连载",
    "质量门禁不过线会先修复再继续下写",
  ])
  const tags = stringList(source.tags, ["长篇小说", "剧情升级", "悬念", "连载"])
  const platformNotes = text(
    source.platformNotes,
    "复制前建议把平台禁词、分卷名和最新章节数再核对一遍。",
  )
  const markdown = text(
    source.markdown,
    formatMarkdown({ oneLine, shortIntro, fullIntro, sellingPoints, tags, platformNotes }),
  )

  return { oneLine, shortIntro, fullIntro, sellingPoints, tags, platformNotes, markdown }
}

function fallbackResult(bookId: string): BookDescriptionResult {
  return normalizeResult({}, bookId)
}

function text(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function stringList(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
  return items.length ? items.map((item) => item.trim()) : fallback
}

function titleFromId(bookId: string) {
  try {
    return decodeURIComponent(bookId).replace(/[-_]+/g, " ").trim() || "当前作品"
  } catch {
    return bookId.replace(/[-_]+/g, " ").trim() || "当前作品"
  }
}

function formatMarkdown(description: Omit<BookDescriptionPayload, "markdown">) {
  return [
    `# 一句话卖点`,
    description.oneLine,
    "",
    `# 短简介`,
    description.shortIntro,
    "",
    `# 完整简介`,
    description.fullIntro,
    "",
    `# 卖点`,
    ...description.sellingPoints.map((point) => `- ${point}`),
    "",
    `# 标签`,
    description.tags.join(" / "),
    "",
    `# 平台备注`,
    description.platformNotes,
  ].join("\n")
}
