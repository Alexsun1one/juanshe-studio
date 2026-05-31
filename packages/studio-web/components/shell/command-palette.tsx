"use client"

/**
 * CommandPalette —— 全局 ⌘K 搜索/跳转面板。
 *
 * 修复:顶栏那个"搜索作品、章节…⌘K"以前只是个死 div(无法输入、点了没反应)。
 * 现在它是真入口:⌘K 或点击都打开本面板,可搜索并跳转到任意页面、切换作品。
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { useWorkspace } from "@/lib/workspace-context"
import { PixelBadge, type PixelBadgeKind } from "@/components/design/pixel-badge"
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"

type Route = { href: string; label: string; pixelKind?: PixelBadgeKind; keywords?: string }

const ROUTES: Route[] = [
  { href: "/", label: "工作台", pixelKind: "workbench", keywords: "dashboard home shouye" },
  { href: "/books", label: "作品管理", pixelKind: "library", keywords: "books zuopin" },
  { href: "/assistant", label: "AI 助手", pixelKind: "assistant", keywords: "assistant ai zhushou" },
  { href: "/compose", label: "多平台创作", pixelKind: "platform", keywords: "compose chuangzuo" },
  { href: "/editor", label: "章节编辑", pixelKind: "editor", keywords: "editor zhangjie bianji" },
  { href: "/outline", label: "大纲与规划", pixelKind: "outline", keywords: "outline dagang" },
  { href: "/characters", label: "角色与设定", pixelKind: "characters", keywords: "characters juese" },
  { href: "/materials", label: "素材库", pixelKind: "materials", keywords: "materials sucai" },
  { href: "/genres", label: "题材库", pixelKind: "genres", keywords: "genres ticai" },
  { href: "/import", label: "导入台", pixelKind: "import", keywords: "import daoru" },
  { href: "/wiki", label: "LLM Wiki", pixelKind: "wiki", keywords: "wiki baike" },
  { href: "/knowledge", label: "知识与资产", pixelKind: "knowledge", keywords: "knowledge zhishi" },
  { href: "/graph", label: "故事图谱", pixelKind: "graph", keywords: "graph tupu" },
  { href: "/memory", label: "记忆长卷", pixelKind: "memory", keywords: "memory jiyi" },
  { href: "/library", label: "内容库", pixelKind: "library", keywords: "library neirong" },
  { href: "/platform-export", label: "平台导出", pixelKind: "platform", keywords: "export pingtai daochu" },
  { href: "/publish", label: "发布管理", pixelKind: "publish", keywords: "publish fabu" },
  { href: "/insights", label: "洞察中心", pixelKind: "insights", keywords: "insights dongcha" },
  { href: "/detect", label: "检测台", pixelKind: "detect", keywords: "detect jiance" },
  { href: "/runs", label: "运行台", pixelKind: "runs", keywords: "runs yunxing" },
  { href: "/system", label: "系统与智能体", pixelKind: "system", keywords: "system xitong agent" },
  { href: "/agents", label: "Agent 实验室", pixelKind: "agents", keywords: "agents shiyanshi" },
  { href: "/capabilities", label: "能力台", pixelKind: "capabilities", keywords: "capabilities nengli" },
  { href: "/llm", label: "大模型配置", pixelKind: "llm", keywords: "llm model damoxing" },
  { href: "/preferences", label: "偏好设置", pixelKind: "preferences", keywords: "preferences pianhao settings" },
  { href: "/shortcuts", label: "快捷键", pixelKind: "shortcuts", keywords: "shortcuts kuaijiejian" },
]

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const router = useRouter()
  const { books, setBookId, bookId } = useWorkspace()

  const go = React.useCallback(
    (href: string) => { onOpenChange(false); router.push(href) },
    [router, onOpenChange],
  )
  const pickBook = React.useCallback(
    (id: string) => { onOpenChange(false); setBookId(id) },
    [setBookId, onOpenChange],
  )
  const titleOf = (t: string | { zh: string; en: string } | undefined): string =>
    typeof t === "string" ? t : (t?.zh ?? "")

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="搜索 / 跳转"
      description="搜索页面、作品,快速跳转"
      className="cj-cmdk"
    >
      <CommandInput placeholder="搜索页面、作品… 输入关键词" />
      <CommandList>
        <CommandEmpty>没有匹配项</CommandEmpty>
        <CommandGroup heading="页面">
          {ROUTES.map((r) => (
            <CommandItem
              key={r.href}
              value={`${r.label} ${r.keywords ?? ""}`}
              onSelect={() => go(r.href)}
            >
              {r.pixelKind && <PixelBadge kind={r.pixelKind} size={18} className="cmdk-ico" />}
              <span>{r.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        {books.length > 0 && (
          <CommandGroup heading={`切换作品 · ${books.length}`}>
            {books.map((b) => (
              <CommandItem
                key={b.id}
                value={`book ${titleOf(b.title)}`}
                onSelect={() => pickBook(b.id)}
              >
                <PixelBadge kind="library" size={18} className="cmdk-ico" />
                <span>{titleOf(b.title)}</span>
                {b.id === bookId && <span className="cmdk-current">当前</span>}
                {b.autoRunning && <span className="cmdk-running">运行中</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
