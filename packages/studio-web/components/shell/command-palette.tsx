"use client"

/**
 * CommandPalette —— 全局 ⌘K 命令中枢(搜索 / 跳转 / 动作)。
 *
 * 设计:命令面板是"按钮可以出现在任意页面"的最佳载体——一个作者无论身处哪一页,
 * 都该能一键够到核心动词:写下一章、查质量门、导出/发布,以及直接跳到某个角色。
 *
 * 历史:顶栏那个"搜索作品、章节…⌘K"以前只是死 div;后来变成真入口但只能跳页面/切书,
 * 搜角色名(如「沈砚」)会落空、与占位文案承诺不符。本次补上「动作」「角色」两组,
 * 并把占位文案改成与实际能力一致。
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { useWorkspace } from "@/lib/workspace-context"
import { fetchCast } from "@/lib/api/client"
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
  { href: "/consistency", label: "一致性扫描", keywords: "consistency yizhixing shangjia gate jiancha" },
  { href: "/runs", label: "运行台", pixelKind: "runs", keywords: "runs yunxing" },
  { href: "/system", label: "系统与智能体", pixelKind: "system", keywords: "system xitong agent" },
  { href: "/agents", label: "Agent 实验室", pixelKind: "agents", keywords: "agents shiyanshi" },
  { href: "/capabilities", label: "能力台", pixelKind: "capabilities", keywords: "capabilities nengli" },
  { href: "/llm", label: "大模型配置", pixelKind: "llm", keywords: "llm model damoxing" },
  { href: "/preferences", label: "偏好设置", pixelKind: "preferences", keywords: "preferences pianhao settings" },
  { href: "/shortcuts", label: "快捷键", pixelKind: "shortcuts", keywords: "shortcuts kuaijiejian" },
]

/** 当前作品的核心动作 —— 让"写 / 验 / 发"这些动词从任意页面都能一键触达。
 *  注意:都是安全的导航,不在面板里直接触发真实 LLM 写作(写作仍由工作台显式确认)。 */
type BookAction = { href: string; label: string; hint: string; pixelKind: PixelBadgeKind; keywords: string }

const BOOK_ACTIONS: BookAction[] = [
  { href: "/?new=1", label: "新建一本书", hint: "开建书向导", pixelKind: "library", keywords: "xinjian new book create 新建 建书 开新书 写新书" },
  { href: "/", label: "写下一章", hint: "去工作台续写", pixelKind: "workbench", keywords: "xie write continue 续写 继续创作 下一章 写作" },
  { href: "/consistency", label: "质量门 · 一致性", hint: "上架闸 / 修复低分章", pixelKind: "detect", keywords: "zhiliang gate xiufu 质量 修复 低分 一致性 上架 矛盾" },
  { href: "/publish", label: "导出 / 发布", hint: "导出稿件 · 发到平台", pixelKind: "publish", keywords: "daochu fabu export publish 导出 发布 平台" },
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

  // 当前作品的角色 —— 仅在面板打开时懒加载,失败/空都安全降级(不渲染该组)。
  const { data: cast } = useSWR(
    open && bookId ? ["cmdk-cast", bookId] : null,
    () => fetchCast(bookId),
  )
  const bookLabel = titleOf(books.find((b) => b.id === bookId)?.title) || "当前作品"

  // ② 数字快速跳读:直接输入章号 → 一键读/编该章(超出当前书章数则不提示,避免跳到空章)
  const [query, setQuery] = React.useState("")
  const chapterCount = books.find((b) => b.id === bookId)?.chapterCount ?? 0
  const typedN = /^\s*\d{1,4}\s*$/.test(query) ? parseInt(query.trim(), 10) : NaN
  const jumpChapter =
    bookId && Number.isFinite(typedN) && typedN >= 1 && (chapterCount === 0 || typedN <= chapterCount)
      ? typedN
      : null

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="搜索 / 跳转 / 动作"
      description="搜索动作、角色、页面、作品,快速跳转"
      className="cj-cmdk"
      showCloseButton={false}  /* 命令面板惯例无 X:Esc / 点遮罩关闭;X 会压住输入行右端 */
    >
      <CommandInput
        placeholder="搜索动作、角色、页面、作品,或输入章号直达…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>没有匹配项</CommandEmpty>
        {jumpChapter !== null && (
          <CommandGroup heading="跳转章节">
            <CommandItem
              value={`阅读第${jumpChapter}章 read chapter ${jumpChapter}`}
              onSelect={() => go(`/immersive?chapter=${jumpChapter}`)}
            >
              <PixelBadge kind="editor" size={18} className="cmdk-ico" />
              <span>阅读第 {jumpChapter} 章</span>
              <span className="cmdk-hint">全屏沉浸阅读</span>
            </CommandItem>
            <CommandItem
              value={`编辑第${jumpChapter}章 edit chapter ${jumpChapter}`}
              onSelect={() => go(`/editor?chapter=${jumpChapter}`)}
            >
              <PixelBadge kind="editor" size={18} className="cmdk-ico" />
              <span>编辑第 {jumpChapter} 章</span>
              <span className="cmdk-hint">进章节编辑</span>
            </CommandItem>
          </CommandGroup>
        )}
        {bookId && (
          <CommandGroup heading={`动作 · ${bookLabel}`}>
            {BOOK_ACTIONS.map((a) => (
              <CommandItem
                key={`action-${a.href}-${a.label}`}
                value={`${a.label} ${a.keywords}`}
                onSelect={() => go(a.href)}
              >
                <PixelBadge kind={a.pixelKind} size={18} className="cmdk-ico" />
                <span>{a.label}</span>
                <span className="cmdk-hint">{a.hint}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {cast && cast.length > 0 && (
          <CommandGroup heading={`角色 · ${bookLabel}`}>
            {cast.slice(0, 14).map((c) => (
              <CommandItem
                key={`cast-${c.id}`}
                value={`角色 ${titleOf(c.name)} ${c.id} ${titleOf(c.role)}`}
                onSelect={() => go(`/characters/${encodeURIComponent(c.id)}`)}
              >
                <PixelBadge kind="characters" size={18} className="cmdk-ico" />
                <span>{titleOf(c.name)}</span>
                {titleOf(c.role) && <span className="cmdk-hint">{titleOf(c.role)}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
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
                value={`book 作品 ${titleOf(b.title)}`}
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
