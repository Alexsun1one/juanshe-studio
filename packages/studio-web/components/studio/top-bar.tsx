"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import {
  Bell,
  FlaskConical,
  Globe,
  Languages,
  Maximize2,
  Minimize2,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Settings,
  Search,
  Share2,
  Sun,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useT, useLocale } from "@/lib/i18n"
import { useStudio } from "@/lib/studio-context"
import { StatusDot } from "@/components/studio/status-dot"
import { BookSwitcher } from "@/components/shell/book-switcher"

export function TopBar() {
  const t = useT()
  const router = useRouter()
  const { locale, setLocale } = useLocale()
  const { theme, setTheme } = useTheme()
  const {
    leftCollapsed,
    rightCollapsed,
    toggleLeft,
    toggleRight,
    focusMode,
    toggleFocus,
  } = useStudio()

  const [mounted, setMounted] = React.useState(false)
  const [commandOpen, setCommandOpen] = React.useState(false)
  React.useEffect(() => setMounted(true), [])
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setCommandOpen((open) => !open)
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const runCommand = React.useCallback(
    (href: string) => {
      setCommandOpen(false)
      router.push(href)
    },
    [router],
  )

  return (
    <header className="border-border bg-sidebar sticky top-0 z-40 border-b">
      <div className="flex h-14 items-center gap-2 px-3 md:px-4">
        {/* Brand (mobile only — SideNav 在桌面端承担品牌) */}
        <div className="flex shrink-0 items-center gap-2 md:hidden">
          <BrandMark />
        </div>

        {/* Book switcher — 多本切换 */}
        <BookSwitcher />

        <div className="bg-border mx-2 hidden h-6 w-px md:block" />

        {/* Left collapse */}
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleLeft}
                aria-label={t("top.collapseLeft")}
                className="shrink-0"
              >
                {leftCollapsed ? (
                  <PanelLeftOpen className="size-4" />
                ) : (
                  <PanelLeftClose className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("top.collapseLeft")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Stepper 已移到中央画布上方的悬浮工具条（见 StudioShell），
            顶栏只留品牌/作品切换与右侧操作，更接近参考图的极简顶栏。 */}
        <div className="mx-2 hidden min-w-0 flex-1 lg:block" />

        {/* Search — 仅 2xl+ 显示完整框，小屏退化成图标按钮 */}
        <div className="ml-auto hidden min-w-0 max-w-xs flex-1 items-center 2xl:flex">
          <button
            type="button"
            onClick={() => setCommandOpen(true)}
            className="bg-secondary/60 hover:bg-secondary focus-visible:border-ring focus-visible:ring-ring/50 relative flex h-9 w-full items-center rounded-lg border border-transparent text-left transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
            aria-label={t("top.search")}
          >
            <Search className="text-muted-foreground ml-3 size-4 shrink-0" />
            <Input
              placeholder={t("top.search")}
              readOnly
              tabIndex={-1}
              className="placeholder:text-muted-foreground/70 pointer-events-none h-9 min-w-0 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
            />
            <kbd className="text-muted-foreground bg-background/80 mr-2 shrink-0 rounded border px-1.5 py-0.5 font-mono text-micro">
              ⌘K
            </kbd>
          </button>
        </div>
        {/* 小屏：搜索退化成图标按钮 */}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto shrink-0 2xl:hidden"
          aria-label={t("top.search")}
          onClick={() => setCommandOpen(true)}
        >
          <Search className="size-4" />
        </Button>

        {/* 降噪：移除"已同步·刚刚"与"本地创作环境·运行中"两个装饰性常驻 pill，
            它们不可操作、非关键信息，参考图顶栏没有这类噪音。状态由底部状态条承载。 */}

        {/* Locale */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("top.toggleLocale")}
              className="shrink-0"
            >
              <Globe className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-36">
            <DropdownMenuLabel className="text-xs">
              <Languages className="mr-1.5 inline size-3" />
              Language
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setLocale("zh-CN")}>
              <span>中文 (简)</span>
              {locale === "zh-CN" && (
                <span className="text-primary ml-auto text-xs">●</span>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setLocale("en")}>
              <span>English</span>
              {locale === "en" && (
                <span className="text-primary ml-auto text-xs">●</span>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Theme */}
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("top.toggleTheme")}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="shrink-0"
        >
          {mounted && theme === "dark" ? (
            <Sun className="size-4" />
          ) : (
            <Moon className="size-4" />
          )}
        </Button>

        {/* Notifications */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("top.notifications")}
              className="relative shrink-0"
            >
              <Bell className="size-4" />
              <span className="bg-accent absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel className="text-xs">
              {t("top.notifications")}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="items-start gap-2">
              <span className="mt-1">
                <StatusDot status="running" size="xs" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm">后端适配层在线</span>
                <span className="text-muted-foreground block text-xs">
                  代理端点已降级到可用数据源。
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem className="items-start gap-2">
              <span className="mt-1">
                <StatusDot status="done" size="xs" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm">同步完成</span>
                <span className="text-muted-foreground block text-xs">
                  当前作品数据已刷新。
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Focus */}
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={focusMode ? "default" : "ghost"}
                size="icon"
                onClick={toggleFocus}
                aria-label={
                  focusMode ? t("top.exitFocus") : t("top.enterFocus")
                }
                className="shrink-0"
              >
                {focusMode ? (
                  <Minimize2 className="size-4" />
                ) : (
                  <Maximize2 className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {focusMode ? t("top.exitFocus") : t("top.enterFocus")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Right collapse */}
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleRight}
                aria-label={t("top.collapseRight")}
                className="shrink-0"
              >
                {rightCollapsed ? (
                  <PanelRightOpen className="size-4" />
                ) : (
                  <PanelRightClose className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("top.collapseRight")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>


      <CommandDialog
        open={commandOpen}
        onOpenChange={setCommandOpen}
        title="搜索工作台"
        description="搜索页面、运行台、Agent、知识图谱与设置入口。"
      >
        <CommandInput placeholder={t("top.search")} />
        <CommandList>
          <CommandEmpty>没有匹配结果</CommandEmpty>
          <CommandGroup heading="页面">
            <CommandItem onSelect={() => runCommand("/")}>
              <Search className="size-4" />
              <span>工作台</span>
            </CommandItem>
            <CommandItem onSelect={() => runCommand("/runs")}>
              <FlaskConical className="size-4" />
              <span>运行台</span>
            </CommandItem>
            <CommandItem onSelect={() => runCommand("/agents")}>
              <Share2 className="size-4" />
              <span>Agent 实验室</span>
            </CommandItem>
            <CommandItem onSelect={() => runCommand("/wiki")}>
              <Share2 className="size-4" />
              <span>知识图谱</span>
            </CommandItem>
            <CommandItem onSelect={() => runCommand("/settings")}>
              <Settings className="size-4" />
              <span>设置</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </header>
  )
}

function BrandMark() {
  return (
    <div className="from-primary/90 via-primary to-accent/90 relative flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br shadow-sm">
      <svg
        viewBox="0 0 24 24"
        className="text-primary-foreground size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 4h12a4 4 0 0 1 4 4v12" />
        <path d="M4 4v16h12" />
        <path d="M8 9h6M8 13h6" opacity="0.7" />
      </svg>
      <span className="bg-status-running absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-background" />
    </div>
  )
}
