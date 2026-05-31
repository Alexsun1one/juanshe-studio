import { SideNav } from "@/components/shell/side-nav"
import { StudioShell } from "@/components/shell/studio-shell"

/**
 * Shell layout：所有主要页面共享的外壳。
 *
 * - 最外层 56px 图标导航条 SideNav（Studio 沉浸模式下自身隐藏）
 * - StudioShell 提供持久三栏：顶栏 + 左菜单栏 + 右面板 + 底部 Dock；
 *   各路由 page.tsx 只渲染中间区域（写作台 / 运行台 / Agent / 知识图谱 …），
 *   点导航只换中间，URL / 前进后退 / 深链 / 刷新定位全部保留。
 */
export default function ShellLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen w-full">
      <SideNav />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <StudioShell>{children}</StudioShell>
      </div>
    </div>
  )
}
