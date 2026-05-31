"use client"

import * as React from "react"
import { Sparkles, ChevronDown, ChevronUp, ArrowUp } from "lucide-react"
import { cn } from "@/lib/utils"
import { AssistantConsole } from "@/components/assistant/assistant-console"

/**
 * 全局底部常驻 AI 对话栏 —— 在 StudioShell 里，所有功能页底部都常驻。
 *
 * - 收起：一条细输入栏（占位提示"直接说，AI 帮你改"）
 * - 展开：向上升起一块对话面板（复用 AssistantConsole 全宽布局，
 *   已绑定当前作品 / 走共享会话，可改章节·大纲·风格等任何东西）
 * - 在输入栏回车或点箭头即展开，并把这句话带进对话
 */
export function AssistantBar() {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  const [seed, setSeed] = React.useState("")

  const submit = React.useCallback(() => {
    const text = draft.trim()
    setSeed(text)
    setOpen(true)
  }, [draft])

  return (
    <div className="fixed inset-x-0 bottom-0 z-40">
      {/* 展开的对话面板（向上升起） */}
      {open && (
        <div className="border-border bg-card mx-auto flex h-[min(60vh,560px)] max-w-[1200px] flex-col overflow-hidden rounded-t-2xl border border-b-0 shadow-lg">
          <div className="border-border flex shrink-0 items-center justify-between border-b px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="bg-primary/10 text-primary flex size-6 items-center justify-center rounded-md">
                <Sparkles className="size-3.5" />
              </span>
              <span className="text-sm font-semibold">AI 助手</span>
              <span className="text-muted-foreground text-[11px]">
                直接说要改什么，绑定当前作品
              </span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground hover:bg-secondary inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors"
              aria-label="收起 AI 助手"
            >
              收起
              <ChevronDown className="size-3.5" />
            </button>
          </div>
          {/* 不再外包 overflow 滚动：让 compact 控制台自己撑满——
              对话区内部滚动、输入框 shrink-0 永远钉在底部可见 */}
          <div className="flex min-h-0 flex-1 flex-col">
            <AssistantConsole seedInstruction={seed} compact />
          </div>
        </div>
      )}

      {/* 常驻细输入栏 —— 仅在收起时显示；展开后输入框在对话面板内，避免双输入框 */}
      {!open && (
        <div className="border-border bg-sidebar border-t">
          <div className="mx-auto flex max-w-[1200px] items-center gap-2 px-4 py-2">
            <span className="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-lg">
              <Sparkles className="size-4" />
            </span>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                }
              }}
              onFocus={() => setOpen(true)}
              placeholder="直接说，AI 帮你改这一章 / 这本书 / 大纲 / 风格…"
              className="text-foreground placeholder:text-muted-foreground/70 h-8 min-w-0 flex-1 bg-transparent text-sm outline-none"
              aria-label="AI 对话输入"
            />
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="text-muted-foreground hover:text-foreground hover:bg-secondary inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors"
              aria-label="展开对话"
            >
              <ChevronUp className="size-4" />
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              className={cn(
                "inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
                draft.trim()
                  ? "bg-primary text-primary-foreground hover:opacity-90"
                  : "bg-secondary text-muted-foreground cursor-not-allowed",
              )}
              aria-label="发送给 AI"
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
