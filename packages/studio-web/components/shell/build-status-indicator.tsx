"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { ChevronRight } from "lucide-react"
import { PixelBadge } from "@/components/design/pixel-badge"
import { AgentPixel } from "@/components/design/agent-pixel"
import { useWorkspace } from "@/lib/workspace-context"
import { STUCK_CREATION_STATUSES } from "@/lib/studio/book-status"
import "./build-status-indicator.css"

/* ───────────────────────────────────────────────────────────
   在建/在写 常驻状态指示器
   - 痛点:建书进度只在「新建作品」弹窗里看得到,关掉/刷新就丢了。
   - 这里在侧栏底部放一个克制的小胶囊,SWR 轮询后端 create-states,
     把"在建 N / 卡住 M / 写作中 K"常驻出来;点开列出每本书 + 状态 + 跳转。
   - 没有任何在建任务时不渲染胶囊(空闲态,不打扰)。
   挂载点:components/design/cj-shell.tsx 的 .sidebar-footer 内。
   ─────────────────────────────────────────────────────────── */

// 后端 /api/v1/books/create-states 的单条形状(server.ts: bookCreateStatus + isLiveBookCreateStatus)
type CreateState = {
  bookId: string
  status: string | null
  stage: string | null
  agent: string | null
  agentLabel: string | null
  startedAt: number | null
  lastEventAt: number | null
  live: boolean
}

// 三态分桶:写作中(live 且在 creating)/ 卡住(终态异常或心跳断)/ 在建(creating 但还没活跃心跳)
type Bucket = "writing" | "stuck" | "building"

// 卡住状态字符串走共享真相(lib/studio/book-status.ts),不再本地各列一套与 book-readiness 漂移。
function bucketOf(s: CreateState): Bucket {
  const status = String(s.status ?? "").toLowerCase()
  if (STUCK_CREATION_STATUSES.has(status)) return "stuck"
  // creating 但心跳已断(live=false 且非成功终态)→ 视为卡住,提醒用户去看
  if (status === "creating" && !s.live) return "stuck"
  if (s.live) return "writing"
  return "building"
}

// 阶段中文兜底:后端没给 agentLabel/stage 时,从 agent / status 推一句人话
function stageText(s: CreateState): string {
  if (s.agentLabel) return s.agentLabel
  if (s.stage) return s.stage
  const status = String(s.status ?? "").toLowerCase()
  if (status === "needs-foundation") return "故事地基待验收"
  if (status === "stalled") return "心跳超时,后台可能还在跑"
  if (status === "error" || status === "failed") return "建书出错"
  if (status === "cancelled") return "已取消"
  if (s.agent) return s.agent
  return "处理中"
}

const fetchCreateStates = async (): Promise<CreateState[]> => {
  const res = await fetch("/api/v1/books/create-states", {
    headers: { accept: "application/json" },
  })
  if (!res.ok) throw new Error(`create-states ${res.status}`)
  const json = (await res.json()) as { states?: CreateState[] }
  return Array.isArray(json.states) ? json.states : []
}

export function BuildStatusIndicator({ collapsed = false }: { collapsed?: boolean }) {
  const router = useRouter()
  const { books, setBookId } = useWorkspace()
  const [open, setOpen] = React.useState(false)
  const rootRef = React.useRef<HTMLDivElement>(null)

  // 轮询:沿用 use-run-state 的 3.5s 节奏;后端没起时别死命重试刷 console
  const { data } = useSWR<CreateState[]>("books-create-states", fetchCreateStates, {
    refreshInterval: 3500,
    revalidateOnFocus: true,
    dedupingInterval: 1500,
    shouldRetryOnError: false,
    keepPreviousData: true,
  })

  const states = React.useMemo(() => data ?? [], [data])

  const counts = React.useMemo(() => {
    let writing = 0
    let stuck = 0
    let building = 0
    for (const s of states) {
      const b = bucketOf(s)
      if (b === "writing") writing += 1
      else if (b === "stuck") stuck += 1
      else building += 1
    }
    return { writing, stuck, building, total: states.length }
  }, [states])

  // 关菜单:点外面 / Esc
  React.useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  // 没有任何在建任务 → 完全不渲染(空闲态不占地方、不打扰)
  if (counts.total === 0) return null

  // 书名:create-states 不带标题,从工作区 books 里反查;查不到给个短 id
  const titleOf = (bookId: string): string => {
    const book = books.find((b) => b.id === bookId)
    if (book?.title?.zh) return book.title.zh
    if (book?.title?.en) return book.title.en
    return bookId.length > 14 ? `${bookId.slice(0, 12)}…` : bookId
  }

  // 排序:卡住 > 写作中 > 在建(要处理的浮到最上),同桶按最近活跃倒序
  const order: Record<Bucket, number> = { stuck: 0, writing: 1, building: 2 }
  const sorted = [...states].sort((a, b) => {
    const da = order[bucketOf(a)] - order[bucketOf(b)]
    if (da !== 0) return da
    return (b.lastEventAt ?? b.startedAt ?? 0) - (a.lastEventAt ?? a.startedAt ?? 0)
  })

  // 胶囊主文案:卡住优先(语义红),否则写作/在建(品牌紫一个强调)
  const tone: "stuck" | "active" = counts.stuck > 0 ? "stuck" : "active"
  const activeCount = counts.writing + counts.building
  const summaryText =
    counts.stuck > 0
      ? `${counts.stuck} 本卡住`
      : counts.writing > 0
        ? `${counts.writing} 本写作中`
        : `${counts.building} 本在建`

  function jumpTo(s: CreateState) {
    setBookId(s.bookId)
    setOpen(false)
    // 卡住的去 /system(建书时间线 + 自愈),在建/写作中的去 /books 看半成品
    const target = bucketOf(s) === "stuck" ? "/system" : "/books"
    React.startTransition(() => router.push(target))
  }

  return (
    <div className="bsi" ref={rootRef} data-tone={tone}>
      <button
        type="button"
        className={`bsi-pill${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          collapsed
            ? `在建 ${counts.building} · 卡住 ${counts.stuck} · 写作中 ${counts.writing}`
            : "查看在建/在写作品"
        }
      >
        <span className="bsi-pixel" aria-hidden>
          <PixelBadge kind="workbench" size={18} />
          {tone === "active" && activeCount > 0 ? <span className="bsi-spark" /> : null}
        </span>
        {!collapsed && (
          <>
            <span className="bsi-text">{summaryText}</span>
            {/* 次要计数:有多桶时补一句,但不堆颜色 */}
            {counts.stuck > 0 && activeCount > 0 ? (
              <span className="bsi-sub num">+{activeCount} 在跑</span>
            ) : null}
            <ChevronRight size={13} className="bsi-caret" aria-hidden />
          </>
        )}
        {collapsed && (
          <span className={`bsi-dot${tone === "stuck" ? " stuck" : ""}`} aria-hidden />
        )}
      </button>

      {open && (
        <div className="bsi-menu" role="menu">
          <div className="bsi-menu-head">
            <span>在建 / 在写</span>
            <span className="bsi-menu-counts num">
              {counts.building > 0 && <span className="bsi-chip building">{counts.building} 在建</span>}
              {counts.writing > 0 && <span className="bsi-chip writing">{counts.writing} 写作中</span>}
              {counts.stuck > 0 && <span className="bsi-chip stuck">{counts.stuck} 卡住</span>}
            </span>
          </div>
          <div className="bsi-menu-list scroll-thin">
            {sorted.map((s) => {
              const b = bucketOf(s)
              return (
                <button
                  key={s.bookId}
                  type="button"
                  role="menuitem"
                  className={`bsi-row bsi-row-${b}`}
                  onClick={() => jumpTo(s)}
                  title={`${titleOf(s.bookId)} · ${stageText(s)} → ${b === "stuck" ? "去系统看" : "去作品"}`}
                >
                  <AgentPixel id={s.agent || "architect"} size={26} className="bsi-row-pixel" />
                  <span className="bsi-row-main">
                    <span className="bsi-row-title">{titleOf(s.bookId)}</span>
                    <span className="bsi-row-stage">
                      <span className={`bsi-row-state-dot bsi-${b}`} aria-hidden />
                      {stageText(s)}
                    </span>
                  </span>
                  <ChevronRight size={13} className="bsi-row-go" aria-hidden />
                </button>
              )
            })}
          </div>
          <div className="bsi-menu-foot">建书一般 30–90 秒;关掉窗口也会继续跑。</div>
        </div>
      )}
    </div>
  )
}
