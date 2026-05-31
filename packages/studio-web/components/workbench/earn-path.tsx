"use client"

import * as React from "react"
import Link from "next/link"
import "./earn-path.css"

// 变现路径:把"写作如何变成收入"这条线在各管线页之间显式串起来。
// 一行轻量 wayfinding,当前阶段高亮,其余可点跳转。纯展示,无数据/无 token 消耗。

type Stage = { key: string; label: string; href: string }

const STAGES: Stage[] = [
  { key: "idea", label: "选题", href: "/insights" },
  { key: "write", label: "写作", href: "/editor" },
  { key: "adapt", label: "适配", href: "/platform-export" },
  { key: "publish", label: "发布", href: "/publish" },
  { key: "asset", label: "成品", href: "/library" },
]

export function EarnPath({ current }: { current: string }) {
  return (
    <nav className="earn-path" aria-label="变现路径">
      <span className="ep-lead">变现路径</span>
      <span className="ep-track">
        {STAGES.map((s, i) => {
          const cur = s.key === current
          const done = STAGES.findIndex((x) => x.key === current) > i
          return (
            <React.Fragment key={s.key}>
              {i > 0 && <span className="ep-arrow" aria-hidden="true">›</span>}
              <Link
                href={s.href}
                className={`ep-stage${cur ? " is-cur" : ""}${done ? " is-done" : ""}`}
                aria-current={cur ? "step" : undefined}
              >
                {s.label}
              </Link>
            </React.Fragment>
          )
        })}
      </span>
    </nav>
  )
}
