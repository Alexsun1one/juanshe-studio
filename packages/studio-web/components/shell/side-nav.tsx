"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  BookOpenText,
  Bot,
  Boxes,
  FileArchive,
  Network,
  PlayCircle,
  Radar,
  Settings,
  Sparkles,
  Tags,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n"
import { useWorkspace } from "@/lib/workspace-context"

type IconLike = React.ComponentType<{
  className?: string
  strokeWidth?: number | string
}>

type NavItem = {
  href: string
  icon: IconLike
  labelKey: string
  /** 数字徽章（如运行中作品数） */
  badgeKey?: "running"
}

type NavGroup = {
  titleKey: string
  items: NavItem[]
}

/**
 * 分组导航 — 把 10 个真实路由按工作阶段聚类：
 * 写作（创作）· 资产（题材/知识/导入）· 运营（运行/Agent/检测/能力）· 设置
 */
const GROUPS: NavGroup[] = [
  {
    titleKey: "nav.group.write",
    items: [
      { href: "/", icon: BookOpenText, labelKey: "nav.studio" },
      { href: "/assistant", icon: Sparkles, labelKey: "nav.assistant" },
    ],
  },
  {
    titleKey: "nav.group.assets",
    items: [
      { href: "/wiki", icon: Network, labelKey: "nav.wiki" },
      { href: "/genres", icon: Tags, labelKey: "nav.genres" },
      { href: "/import", icon: FileArchive, labelKey: "nav.import" },
    ],
  },
  {
    titleKey: "nav.group.ops",
    items: [
      { href: "/runs", icon: PlayCircle, labelKey: "nav.runs", badgeKey: "running" },
      { href: "/agents", icon: Bot, labelKey: "nav.agents" },
      { href: "/detect", icon: Radar, labelKey: "nav.detect" },
      { href: "/capabilities", icon: Boxes, labelKey: "nav.capabilities" },
    ],
  },
  {
    titleKey: "nav.group.settings",
    items: [{ href: "/settings", icon: Settings, labelKey: "nav.settings" }],
  },
]

export function SideNav() {
  const t = useT()
  const pathname = usePathname()
  const { chromeFocused, books } = useWorkspace()
  const runningCount = books.filter((b) => b.autoRunning).length

  if (chromeFocused) return null

  return (
    <aside
      className="bg-sidebar border-border sticky top-0 z-30 hidden h-dvh w-14 shrink-0 flex-col items-center border-r py-2 md:flex"
      aria-label="Primary navigation"
    >
      {/* Brand */}
      <Link
        href="/"
        className="hover:bg-sidebar-accent/60 mb-1 flex size-10 items-center justify-center rounded-xl transition-colors"
        aria-label="卷舍"
        title="卷舍"
      >
        <BrandMark />
      </Link>

      {/* Icon nav (desktop-style thin activity rail) */}
      <nav className="scroll-thin flex flex-1 flex-col items-center gap-0.5 overflow-y-auto py-1">
        {GROUPS.map((group, gi) => (
          <div key={group.titleKey} className="flex flex-col items-center gap-0.5">
            {gi > 0 && (
              <span
                className="bg-sidebar-border my-1.5 h-px w-6"
                aria-hidden
              />
            )}
            {group.items.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname?.startsWith(item.href)
              const Icon = item.icon
              const badge =
                item.badgeKey === "running" && runningCount > 0
                  ? runningCount
                  : undefined

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  aria-label={t(item.labelKey)}
                  className={cn(
                    "group relative flex size-10 items-center justify-center rounded-xl transition-colors",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
                  )}
                >
                  {active && (
                    <span
                      className="bg-sidebar-primary absolute left-0 top-1/2 h-5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                      style={{ width: 3 }}
                      aria-hidden
                    />
                  )}
                  <Icon
                    className={cn(
                      "size-[19px] shrink-0 transition-colors",
                      active && "text-sidebar-primary",
                    )}
                    strokeWidth={active ? 2.2 : 1.9}
                  />
                  {badge !== undefined && (
                    <span className="bg-status-running absolute right-1 top-1 flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 text-[9px] font-bold text-white ring-2 ring-[var(--sidebar)]">
                      {badge}
                    </span>
                  )}
                  {/* hover tooltip */}
                  <span className="bg-popover text-popover-foreground border-border pointer-events-none absolute left-[calc(100%+8px)] z-50 whitespace-nowrap rounded-md border px-2 py-1 text-cap font-medium opacity-0 shadow-pop transition-opacity duration-[var(--dur-1)] group-hover:opacity-100">
                    {t(item.labelKey)}
                  </span>
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      {/* Account */}
      <button
        type="button"
        aria-label={`本地工作区 · ${books.length} 部作品`}
        title={`本地工作区 · ${books.length} 部作品`}
        className="from-primary to-purple focus-visible:ring-focus mt-1 flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-cap font-semibold text-white shadow-sm transition-transform duration-[var(--dur-1)] ease-[var(--ease-out)] outline-none hover:scale-105 hover:shadow-pop"
      >
        作
      </button>
    </aside>
  )
}

function BrandMark() {
  return (
    <div className="ring-sidebar-border relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-white shadow-sm ring-1">
      <img
        src="/juanshe-logo.svg"
        alt=""
        className="size-full"
        draggable={false}
      />
      <span className="bg-status-running ring-sidebar absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2" />
    </div>
  )
}
