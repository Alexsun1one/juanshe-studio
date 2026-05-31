import type { BookSummary } from "@/lib/api/types"

const BLOCKED_STATUSES = new Set([
  "creating",
  "needs-foundation",
  "stalled",
  "error",
  "failed",
  "missing",
  "outlining",
  "draft",
])

export type BookReadiness = {
  writable: boolean
  resourcesBlocked: boolean
  status: string
  title: string
  label: string
  detail: string
  action: "new" | "outline" | "repair" | "write"
}

export function getBookReadiness(book?: BookSummary | null): BookReadiness {
  if (!book) {
    return {
      writable: false,
      resourcesBlocked: true,
      status: "missing",
      title: "未选择书籍",
      label: "未选择",
      detail: "当前没有可写书籍，先选择一本已有书或新建一本书。",
      action: "new",
    }
  }

  const status = String(book.creationStatus ?? "").trim().toLowerCase()
  const currentChapter = Number.isFinite(book.currentChapter)
    ? book.currentChapter
    : 0
  const blockedByStatus = BLOCKED_STATUSES.has(status)
  const blockedByChapter = currentChapter <= 0
  const resourcesBlocked = blockedByStatus || blockedByChapter

  if (!resourcesBlocked) {
    return {
      writable: true,
      resourcesBlocked: false,
      status,
      title: "正在创作",
      label: "可写",
      detail: "当前书籍已有可写章节，可以继续写作、修订或保存。",
      action: "write",
    }
  }

  if (status === "creating") {
    return {
      writable: false,
      resourcesBlocked: true,
      status,
      title: "建书运行中",
      label: "建书中",
      detail: "建书 agent 还在执行，完成前不会加载旧书兜底内容。",
      action: "new",
    }
  }

  if (status === "needs-foundation") {
    return {
      writable: false,
      resourcesBlocked: true,
      status,
      title: "地基未通过",
      label: "地基未过",
      detail: "建书地基未通过，需要回到建书状态处理，不能直接续写正文。",
      action: "new",
    }
  }

  if (status === "stalled" || status === "error" || status === "failed") {
    return {
      writable: false,
      resourcesBlocked: true,
      status,
      title: status === "stalled" ? "建书卡住" : "建书失败",
      label: status === "stalled" ? "已卡住" : "失败",
      detail: "上一次建书或写作任务没有正常落地，请先回到建书页重试或查看运行记录。",
      action: "repair",
    }
  }

  if (status === "outlining" || status === "draft" || blockedByChapter) {
    return {
      writable: false,
      resourcesBlocked: true,
      status,
      title: "尚未进入写章",
      label: "未开写",
      detail: "这本书只有大纲或书籍档案，还没有生成第一章，不能启动章节续写。",
      action: "outline",
    }
  }

  return {
    writable: false,
    resourcesBlocked: true,
    status,
    title: "状态未就绪",
    label: "未就绪",
    detail: "当前书籍状态还不能确认可写，已阻止写作区加载兜底内容。",
    action: "new",
  }
}

export function isBookWritable(book?: BookSummary | null) {
  return getBookReadiness(book).writable
}
