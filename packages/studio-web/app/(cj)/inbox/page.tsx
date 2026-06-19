"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ListChecks, KeyRound, ArrowRight, CheckCircle2 } from "lucide-react"
import { PixelBadge } from "@/components/design/pixel-badge"
import { AgentPixel } from "@/components/design/agent-pixel"
import { EmptyArt } from "@/components/design/cj-placeholder"
import { useWorkspace } from "@/lib/workspace-context"
import { useInbox, type InboxTodo } from "@/lib/use-inbox"
import "./inbox.css"

export default function InboxPage() {
  const router = useRouter()
  const { setBookId } = useWorkspace()
  const { todos, count, loading } = useInbox()

  function go(todo: InboxTodo) {
    if (todo.bookId) setBookId(todo.bookId)
    router.push(todo.href)
  }

  return (
    <div className="cj-screen cj-inbox">
      <header className="cj-workhead ib-head">
        <div className="ib-headline">
          <PixelBadge kind="runs" size={44} className="ib-hero-pixel" ariaLabel="需要处理" />
          <div className="ib-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">需要处理</h1>
              {count > 0 && <span className="ib-count">{count}</span>}
            </div>
            <p className="page-sub">
              卡住、失败、没配模型 —— 凡是挡住你往下走的事,都收在这里,一行一个直达的下一步。
            </p>
          </div>
        </div>
      </header>

      {loading ? (
        <div className="ib-loading">正在汇总待处理事项…</div>
      ) : count === 0 ? (
        <div className="ib-empty">
          <EmptyArt variant="default" />
          <p className="ib-empty-title"><CheckCircle2 size={18} /> 一切就绪,没有需要处理的事</p>
          <p className="ib-empty-sub">模型配好了、没有卡住或失败的书。回工作台接着写就行。</p>
        </div>
      ) : (
        <ul className="ib-list">
          {todos.map((todo) => (
            <li key={todo.id} className={`ib-row sev-${todo.severity}`}>
              <span className="ib-row-icon" aria-hidden>
                {todo.kind === "model" ? (
                  <KeyRound size={20} />
                ) : (
                  <AgentPixel id={todo.agent ?? "architect"} size={34} ariaLabel="" />
                )}
              </span>
              <div className="ib-row-body">
                <p className="ib-row-title">{todo.title}</p>
                <p className="ib-row-hint">{todo.hint}</p>
              </div>
              <button type="button" className="ib-row-act" onClick={() => go(todo)}>
                {todo.actionLabel} <ArrowRight size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="ib-foot">
        <ListChecks size={13} /> 这里只聚合"需要你点一下才能继续"的卡点;正在跑的任务在「运行台」看进度。
      </p>
    </div>
  )
}
