import { CjShell } from "@/components/design/cj-shell"
import { ActivationGate } from "@/components/auth/activation-gate"

/**
 * 设计外壳路由组 (cj) — Claude Design 全量对接的新前端。
 * .app 网格(侧栏 + 主区),收起 / 主题 / 顶栏由 CjShell 提供;
 * 各 page.tsx 只渲染 .page 内容。
 */
export default function CjLayout({ children }: { children: React.ReactNode }) {
  return (
    <ActivationGate>
      <CjShell>{children}</CjShell>
    </ActivationGate>
  )
}
