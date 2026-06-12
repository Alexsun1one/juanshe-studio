"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { PixelBadge } from "./pixel-badge"
import { CjLogo } from "./cj-logo"
import { useTheme } from "next-themes"
import { useAuthorName } from "@/lib/use-author-name"
import {
  Activity,
  BookOpenText,
  BookText,
  Boxes,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cpu,
  FileArchive,
  FlaskConical,
  PanelLeft,
  Globe,
  Keyboard,
  LayoutDashboard,
  Library,
  ListTree,
  LogOut,
  Moon,
  Network,
  Newspaper,
  PenLine,
  PlayCircle,
  Radar,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Tags,
  Users,
  ScrollText,
  Share2,
} from "lucide-react"
import { useWorkspace } from "@/lib/workspace-context"
import { EventLogCenter } from "@/components/studio/event-log-center"
import { CommandPalette } from "@/components/shell/command-palette"
import { BuildStatusIndicator } from "@/components/shell/build-status-indicator"
import { WechatFollow } from "@/components/cj/wechat-follow"
import { WorkflowTheater } from "@/components/workbench/workflow-theater"
import { ThemeColorPicker } from "@/components/shell/theme-color-picker"
import { BrandOrnaments } from "@/components/design/brand-ornaments"

/* ───────────────────────────────────────────────────────────
   长卷写作台 · 设计外壳
   - .app 网格:200px 侧栏 + 1fr 主区;可收起(localStorage cj.sidebar)
   - 暗夜模式走 next-themes(.dark),design.css 已桥接
   - 侧栏导航高亮跟随当前路由
   ─────────────────────────────────────────────────────────── */

// nav 支持两种图标:像素艺术(主创作 + 知识资产 + 发布)或 lucide(工具型)
// pixelKind 优先;否则用 icon。这样保持视觉重心在 AI 编辑部的创作核心 routes。
type NavItem = {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string; size?: number | string }>
  pixelKind?: import("./pixel-badge").PixelBadgeKind
  badge?: string
}
type NavGroup = {
  title?: string
  /** 唯一稳定 id 用于持久化折叠状态 */
  groupId?: string
  /** 大分类的像素图标 */
  pixelKind?: import("./pixel-badge").PixelBadgeKind
  items: NavItem[]
}

const NAV: NavGroup[] = [
  { items: [{ href: "/", label: "工作台", icon: LayoutDashboard, pixelKind: "workbench" }] },
  {
    title: "创 作",
    groupId: "creation",
    pixelKind: "grp-creation",
    items: [
      { href: "/books", label: "作品管理", icon: BookOpenText, pixelKind: "library" },
      { href: "/assistant", label: "AI 助手", icon: Sparkles, pixelKind: "assistant" },
      { href: "/compose", label: "多平台创作", icon: Newspaper, badge: "AI", pixelKind: "platform" },
      { href: "/editor", label: "章节编辑", icon: PenLine, pixelKind: "editor" },
      { href: "/outline", label: "大纲与规划", icon: ListTree, pixelKind: "outline" },
      { href: "/characters", label: "角色与设定", icon: Users, pixelKind: "characters" },
      { href: "/materials", label: "素材库", icon: Boxes, pixelKind: "materials" },
    ],
  },
  {
    title: "知识与资产",
    groupId: "knowledge",
    pixelKind: "grp-knowledge",
    items: [
      { href: "/genres", label: "题材库", icon: Tags, pixelKind: "genres" },
      { href: "/import", label: "导入台", icon: FileArchive, pixelKind: "import" },
      { href: "/wiki", label: "LLM Wiki", icon: BookText, pixelKind: "wiki" },
      { href: "/knowledge", label: "知识与资产", icon: Network, pixelKind: "knowledge" },
      { href: "/graph", label: "故事图谱", icon: Share2, badge: "活", pixelKind: "graph" },
      { href: "/memory", label: "记忆长卷", icon: ScrollText, badge: "NEW", pixelKind: "memory" },
    ],
  },
  {
    title: "发布与运营",
    groupId: "publish",
    pixelKind: "grp-publish",
    items: [
      { href: "/library", label: "内容库", icon: Library, pixelKind: "library" },
      { href: "/platform-export", label: "平台导出", icon: Globe, pixelKind: "platform" },
      { href: "/publish", label: "发布管理", icon: Send, pixelKind: "publish" },
      { href: "/insights", label: "洞察中心", icon: Activity, pixelKind: "insights" },
      { href: "/detect", label: "检测台", icon: Radar, pixelKind: "detect" },
      { href: "/consistency", label: "一致性扫描", icon: ShieldCheck },
    ],
  },
  {
    title: "系统与智能体",
    groupId: "system",
    pixelKind: "grp-system",
    items: [
      { href: "/runs", label: "运行台", icon: PlayCircle, pixelKind: "runs" },
      { href: "/system", label: "系统与智能体", icon: Cpu, pixelKind: "system" },
      { href: "/agents", label: "Agent 实验室", icon: FlaskConical, pixelKind: "agents" },
      { href: "/capabilities", label: "能力台", icon: Boxes, pixelKind: "capabilities" },
    ],
  },
]

/* 设置类不再占用上方导航分组——收到左下角「总设置」入口(底部固定),点开弹出这几项。 */
const SETTINGS_ITEMS: NavItem[] = [
  { href: "/llm", label: "大模型配置", icon: Bot, pixelKind: "llm" },
  { href: "/preferences", label: "偏好设置", icon: SlidersHorizontal, pixelKind: "preferences" },
  { href: "/shortcuts", label: "快捷键", icon: Keyboard, pixelKind: "shortcuts" },
]

const NAV_GROUP_COLLAPSE_STORAGE_KEY = "cj-nav-collapsed-groups"
const NAV_GROUP_COLLAPSE_VERSION_KEY = "cj-nav-collapsed-groups-version"
const NAV_GROUP_COLLAPSE_VERSION = "2"
const DEFAULT_COLLAPSED_GROUPS = NAV.reduce<Record<string, boolean>>((acc, group) => {
  if (group.groupId) acc[group.groupId] = true
  return acc
}, {})

const ROUTE_SECTION_LABELS: Record<string, string> = {
  workbench: "工作台",
  creation: "创作",
  knowledge: "知识与资产",
  publish: "发布与运营",
  system: "系统与智能体",
  settings: "设置",
}

function routeSectionOf(pathname: string | null): string {
  if (!pathname || pathname === "/") return "workbench"
  if (/^\/(books|assistant|compose|editor|outline|characters|materials)/.test(pathname)) return "creation"
  if (/^\/(genres|import|wiki|knowledge|graph|memory)/.test(pathname)) return "knowledge"
  if (/^\/(library|platform-export|publish|insights|detect)/.test(pathname)) return "publish"
  if (/^\/(runs|system|agents|capabilities)/.test(pathname)) return "system"
  if (/^\/(llm|preferences|shortcuts|settings)/.test(pathname)) return "settings"
  return "workbench"
}

function routeKeyOf(pathname: string | null): string {
  const first = pathname?.split("/").filter(Boolean)[0]
  return first ? first.replace(/[^a-z0-9-]/gi, "") : "workbench"
}

const CollapseCtx = React.createContext<{ collapsed: boolean; toggle: () => void }>({
  collapsed: false,
  toggle: () => {},
})

export function CjShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = React.useState(false)
  const pathname = usePathname()
  const routeSection = routeSectionOf(pathname)
  const routeKey = routeKeyOf(pathname)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  // 全站 AI 写作剧场:任意页(编辑器/内容库/创作…)触发续写/修复/批量,运行态一起 → 剧场自动弹出,随处可看可停
  const { books, bookId } = useWorkspace()
  const activeBook = books.find((b) => b.id === bookId)

  React.useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("cj.sidebar") === "1")
    } catch {
      /* ignore */
    }
  }, [])

  // 路由切换时:内容区回到顶部,并把焦点交给滚动容器,
  // 使键盘滚动(空格/PageDown/End/方向键)无需先点击即可生效(修复固定外壳的键盘滚动回归)。
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = 0
    const active = document.activeElement
    if (!active || active === document.body || active.tagName === "MAIN") {
      el.focus({ preventScroll: true })
    }
  }, [pathname])

  const toggle = React.useCallback(() => {
    setCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem("cj.sidebar", next ? "1" : "0")
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  return (
    <CollapseCtx.Provider value={{ collapsed, toggle }}>
      <div className={`app${collapsed ? " sidebar-collapsed" : ""}`} data-route-section={routeSection} data-route-key={routeKey}>
        <BrandOrnaments />
        <CjSidebar />
        <main>
          <CjTopbar />
          <div className="main-scroll scroll-thin" ref={scrollRef} tabIndex={-1}>{children}</div>
        </main>
        <CjStatusBar routeSection={routeSection} />
        {/* 全局运行日志/错误中心:错误实时 toast + 浮动入口抽屉,所有智能体事件都浮到前台 */}
        <EventLogCenter />
        {/* 全站 AI 写作剧场:续写/修复/批量一跑就弹,随处可监看进度与停止 */}
        <WorkflowTheater bookId={bookId} bookTitle={activeBook?.title.zh ?? "—"} />
      </div>
    </CollapseCtx.Provider>
  )
}

function CjStatusBar({ routeSection }: { routeSection: string }) {
  const router = useRouter()
  const { books, bookId } = useWorkspace()
  const activeBook = books.find((b) => b.id === bookId)
  const runningCount = books.filter((b) => b.autoRunning).length
  const titleOf = (t: string | { zh: string; en: string } | undefined): string =>
    typeof t === "string" ? t : (t?.zh ?? t?.en ?? "")
  const bookTitle = titleOf(activeBook?.title) || "未选择作品"

  return (
    <footer className="desktop-statusbar" aria-label="桌面状态栏">
      <div className="desktop-status-left">
        <span className="desktop-status-dot" aria-hidden />
        <span className="desktop-status-strong">本地工作区</span>
        <span className="desktop-status-seg">{ROUTE_SECTION_LABELS[routeSection] ?? "工作台"}</span>
        <span className="desktop-status-book" title={bookTitle}>{bookTitle}</span>
      </div>
      <div className="desktop-status-right">
        {/* 运行状态不只是文字 —— 写作进行时,任意页面都能点它跳进并行运行台查看/控制 */}
        <button
          type="button"
          className={`desktop-status-tasks${runningCount > 0 ? " is-running" : ""}`}
          onClick={() => router.push("/runs")}
          title={runningCount > 0 ? "查看并行运行台" : "打开运行台"}
        >
          {runningCount > 0 && <span className="desktop-status-runs-dot" aria-hidden />}
          {runningCount > 0 ? `${runningCount} 个任务运行中` : "智能体待命"}
        </button>
        {/* ⌘K 是键盘专属提示,≤760px 触屏没有意义 → design.css 窄屏断点隐藏 */}
        <span className="desktop-status-hint">⌘K 搜索</span>
        <span>API 4569</span>
      </div>
    </footer>
  )
}

function CjSidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { collapsed, toggle } = React.useContext(CollapseCtx)
  const { books } = useWorkspace()
  const runningCount = books.filter((b) => b.autoRunning).length

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname?.startsWith(href)

  // Hover 预拉路由 — Next 默认 viewport prefetch,这里在用户意图明确时(指针进入)
  // 主动再拉一次,确保 RSC 已经在 cache,点击瞬间渲染。30s 内重复 hover 跳过。
  const prefetchCache = React.useRef(new Map<string, number>())
  const hoverPrefetch = (href: string) => {
    const last = prefetchCache.current.get(href) ?? 0
    if (Date.now() - last < 30_000) return
    prefetchCache.current.set(href, Date.now())
    try { router.prefetch(href) } catch {}
  }

  // 大分类折叠状态 — 默认收起,避免首次进入被二级入口淹没;用户手动展开后持久化。
  const [collapsedGroups, setCollapsedGroups] = React.useState<Record<string, boolean>>(DEFAULT_COLLAPSED_GROUPS)
  React.useEffect(() => {
    if (typeof window === "undefined") return
    try {
      const version = window.localStorage.getItem(NAV_GROUP_COLLAPSE_VERSION_KEY)
      const raw = window.localStorage.getItem(NAV_GROUP_COLLAPSE_STORAGE_KEY)
      if (version === NAV_GROUP_COLLAPSE_VERSION && raw) {
        setCollapsedGroups({ ...DEFAULT_COLLAPSED_GROUPS, ...JSON.parse(raw) })
        return
      }
      window.localStorage.setItem(NAV_GROUP_COLLAPSE_STORAGE_KEY, JSON.stringify(DEFAULT_COLLAPSED_GROUPS))
      window.localStorage.setItem(NAV_GROUP_COLLAPSE_VERSION_KEY, NAV_GROUP_COLLAPSE_VERSION)
      setCollapsedGroups(DEFAULT_COLLAPSED_GROUPS)
    } catch { /* ignore */ }
  }, [])
  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [groupId]: !prev[groupId] }
      try {
        window.localStorage.setItem(NAV_GROUP_COLLAPSE_STORAGE_KEY, JSON.stringify(next))
        window.localStorage.setItem(NAV_GROUP_COLLAPSE_VERSION_KEY, NAV_GROUP_COLLAPSE_VERSION)
      } catch { /* ignore */ }
      return next
    })
  }

  // 底部「总设置」弹出菜单(大模型/偏好/快捷键)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const settingsRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!settingsOpen) return
    const onDoc = (e: MouseEvent) => { if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setSettingsOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSettingsOpen(false) }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey) }
  }, [settingsOpen])
  const settingsActive = SETTINGS_ITEMS.some((s) => isActive(s.href))

  return (
    <aside className="sidebar">
      {/* 导航区独立滚动:footer 必须留在滚动域外,否则「设置」右侧飞出菜单会被 overflow 整个裁掉 */}
      <div className="sidebar-nav scroll-thin">
      <div className="brand">
        <span className="brand-mark">
          <CjLogo size={28} />
        </span>
        <span className="brand-name">卷舍</span>
      </div>

      {NAV.map((group, gi) => {
        const collapsed = group.groupId ? !!collapsedGroups[group.groupId] : false
        return (
        <React.Fragment key={group.title ?? `g${gi}`}>
          {group.title && (
            group.groupId
              ? (
                <button
                  type="button"
                  className={`nav-group-head${collapsed ? " collapsed" : ""}`}
                  onClick={() => toggleGroup(group.groupId!)}
                  aria-expanded={!collapsed}
                  title={collapsed ? `展开 ${group.title}` : `折叠 ${group.title}`}
                >
                  {group.pixelKind && (
                    <PixelBadge kind={group.pixelKind} size={18} className="nav-group-pixel" />
                  )}
                  <span className="nav-group-label">{group.title}</span>
                  <span className="nav-group-count">{group.items.length}</span>
                  <span className="nav-group-chevron" aria-hidden>{collapsed ? "▸" : "▾"}</span>
                </button>
              )
              : <div className="nav-group-title">{group.title}</div>
          )}
          {!collapsed && group.items.map((item) => {
            const Icon = item.icon
            const active = isActive(item.href)
            const badge =
              item.href === "/runs" && runningCount > 0 ? String(runningCount) : item.badge
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-item${active ? " active" : ""}${item.pixelKind ? " pixel" : ""}`}
                title={item.label}
                onMouseEnter={() => hoverPrefetch(item.href)}
                onFocus={() => hoverPrefetch(item.href)}
              >
                {item.pixelKind
                  ? <PixelBadge kind={item.pixelKind} size={18} className="ico ico-pixel" />
                  : <Icon className="ico" size={16} />
                }
                {item.label}
                {badge && <span className="badge">{badge}</span>}
              </Link>
            )
          })}
        </React.Fragment>
        )
      })}
      </div>

      {/* ── 底部固定区:在建/在写常驻状态 + 总设置 + 收起 ───────── */}
      <div className="sidebar-footer" ref={settingsRef}>
        {/* 关注公众号块(导流「正在逐渐AI化」;收起时隐藏) */}
        <WechatFollow collapsed={collapsed} />
        {/* 常驻"在建/在写"指示器:轮询 create-states,关弹窗/刷新也看得到、点得回去 */}
        <BuildStatusIndicator collapsed={collapsed} />
        <button
          type="button"
          className={`sidebar-foot-btn${settingsActive ? " active" : ""}${settingsOpen ? " open" : ""}`}
          onClick={() => setSettingsOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={settingsOpen}
          title="设置"
        >
          <PixelBadge kind="grp-settings" size={18} className="ico-pixel" />
          {!collapsed && <span className="sidebar-foot-label">设置</span>}
          {!collapsed && <ChevronRight size={13} className="sidebar-foot-caret" aria-hidden />}
        </button>

        {settingsOpen && (
          <div className="settings-menu" role="menu">
            <div className="settings-menu-h">设置</div>
            {SETTINGS_ITEMS.map((s) => {
              const active = isActive(s.href)
              return (
                <Link
                  key={s.href}
                  href={s.href}
                  role="menuitem"
                  className={`settings-menu-item${active ? " active" : ""}`}
                  onClick={() => setSettingsOpen(false)}
                  onMouseEnter={() => hoverPrefetch(s.href)}
                >
                  {s.pixelKind && <PixelBadge kind={s.pixelKind} size={18} className="ico-pixel" />}
                  <span>{s.label}</span>
                  {active && <Check size={13} className="settings-menu-check" />}
                </Link>
              )
            })}
          </div>
        )}

        {/* 收起侧栏按钮已移除:顶栏左上角已有 PanelLeft 收起按钮,此处重复(反馈 2026-05-30) */}
      </div>
    </aside>
  )
}

function CjTopbar() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  const authorName = useAuthorName()
  const router = useRouter()
  const { collapsed, toggle } = React.useContext(CollapseCtx)
  const { books, bookId, setBookId } = useWorkspace()
  const [mounted, setMounted] = React.useState(false)
  const [tier, setTier] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [bookMenu, setBookMenu] = React.useState(false)
  const [userMenu, setUserMenu] = React.useState(false)
  const [loggingOut, setLoggingOut] = React.useState(false)
  const bookRef = React.useRef<HTMLDivElement>(null)
  const userRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    setMounted(true)
    try {
      setTier(localStorage.getItem("cj.tier") || "")
      setEmail(localStorage.getItem("cj.email") || "")
    } catch { /* ignore */ }
  }, [])
  React.useEffect(() => {
    if (!bookMenu) return
    const onDoc = (e: MouseEvent) => { if (bookRef.current && !bookRef.current.contains(e.target as Node)) setBookMenu(false) }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [bookMenu])
  React.useEffect(() => {
    if (!userMenu) return
    const onDoc = (e: MouseEvent) => { if (userRef.current && !userRef.current.contains(e.target as Node)) setUserMenu(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setUserMenu(false) }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey) }
  }, [userMenu])

  // 退出登录 / 切换激活码:通知后端注销当前激活(activation.json → unlocked=false),
  // 再清掉本地身份(保留 deviceId / 入职 / UI 偏好),跳回登录页重新进门。
  const logout = React.useCallback(async () => {
    if (loggingOut) return
    setLoggingOut(true)
    try { await fetch("/api/v1/auth/deactivate", { method: "POST" }) } catch { /* 离线也要让用户能退 */ }
    try {
      localStorage.removeItem("cj.authed")
      localStorage.removeItem("cj.activation")
      localStorage.removeItem("cj.tier")
      localStorage.removeItem("cj.email")
    } catch { /* ignore */ }
    router.push("/login")
  }, [loggingOut, router])
  // 全局 ⌘K / Ctrl+K 打开搜索面板
  const [cmdkOpen, setCmdkOpen] = React.useState(false)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault()
        setCmdkOpen((o) => !o)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])
  const isDark = mounted && (resolvedTheme ?? theme) === "dark"
  const titleOf = (t: string | { zh: string; en: string } | undefined): string => (typeof t === "string" ? t : (t?.zh ?? ""))
  const activeBook = books.find((b) => b.id === bookId)

  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-btn"
        aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
        title={collapsed ? "展开侧栏" : "收起侧栏"}
        onClick={toggle}
        style={{ marginRight: 2 }}
      >
        <PanelLeft size={18} />
      </button>
      <div className="workspace-sel" ref={bookRef}>
        <button type="button" className="ws-trigger" onClick={() => setBookMenu((o) => !o)} title="切换作品">
          <Boxes size={14} />
          <span className="ws-name">{titleOf(activeBook?.title) || "选择作品"}</span>
          <ChevronDown size={12} style={{ marginLeft: "auto", color: "var(--ink-400)" }} />
        </button>
        {bookMenu && (
          <div className="ws-menu">
            <div className="ws-menu-h">切换作品 · {books.length}</div>
            <div className="ws-menu-list scroll-thin">
              {books.length === 0 && <div className="ws-empty">本地工作区还没有作品</div>}
              {books.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={`ws-item${b.id === bookId ? " active" : ""}`}
                  onClick={() => { setBookId(b.id); setBookMenu(false) }}
                >
                  <PixelBadge kind="library" size={22} className="ws-item-ico" />
                  <span className="ws-item-main">
                    <span className="ws-item-name">{titleOf(b.title)}</span>
                    <span className="ws-item-meta">
                      {b.kindLabel?.zh ?? "长篇"} · {b.chapterCount || 0} 章
                      {b.totalWords ? ` · ${(b.totalWords / 10000).toFixed(1)}w 字` : ""}
                    </span>
                  </span>
                  {b.autoRunning && <span className="ws-run"><span className="ws-run-dot" />运行中</span>}
                  {b.id === bookId && <Check size={14} className="ws-check" />}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <button type="button" className="search-box" onClick={() => setCmdkOpen(true)} title="搜索 / 跳转 (⌘K)">
        <Search size={14} />
        <span className="search-box-text">搜索动作、角色、页面、作品…</span>
        <span className="kbd">⌘K</span>
      </button>
      <CommandPalette open={cmdkOpen} onOpenChange={setCmdkOpen} />

      <div className="tb-right">
        <div className="env-chip">
          <span className="dot" />
          本地创作环境 · 运行中
        </div>
        {/* 语言切换已移除:国内产品 + 英文 i18n 未全量,不留"点了没反应"的假开关。
            将来要做国际版,再补全量翻译并接 useLocale 实开关。 */}
        <ThemeColorPicker />
        <button
          type="button"
          className="theme-toggle"
          aria-label="切换主题"
          title="切换主题 / Toggle theme"
          onClick={() => setTheme(isDark ? "light" : "dark")}
        >
          {isDark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <div className="user-cell" ref={userRef}>
          <button
            type="button"
            className={`user-trigger${userMenu ? " open" : ""}`}
            onClick={() => setUserMenu((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={userMenu}
            title="账户"
          >
            <div className="avatar">{authorName.slice(0, 1)}</div>
            <span className="name">{authorName}</span>
            {mounted && (tier === "pro" || tier === "ultra") && (
              <span className={`tier-badge tier-${tier}`}>{tier === "ultra" ? "ULTRA" : "PRO"}</span>
            )}
            <ChevronDown size={12} className="user-caret" aria-hidden />
          </button>
          {userMenu && (
            <div className="user-menu" role="menu">
              <div className="user-menu-head">
                <div className="avatar lg">{authorName.slice(0, 1)}</div>
                <div className="user-menu-id">
                  <span className="user-menu-name">{authorName}</span>
                  <span className="user-menu-sub">
                    {tier === "ultra" ? "Ultra 会员" : tier === "pro" ? "Pro 会员" : "普通会员"}
                    {mounted && email ? ` · ${email}` : ""}
                  </span>
                </div>
              </div>
              <button
                type="button"
                role="menuitem"
                className="user-menu-item danger"
                onClick={logout}
                disabled={loggingOut}
              >
                <LogOut size={14} />
                {loggingOut ? "正在退出…" : "退出登录 / 切换激活码"}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
