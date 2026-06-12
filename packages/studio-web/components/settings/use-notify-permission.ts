"use client"

// ============================================================================
// useNotifyPermission — 通知三开关的浏览器权限接线(纯 UI 侧)
// 约束:只在用户「首次开启」某个开关时请求权限,绝不在页面加载时打扰;
// 被拒/不支持(iOS Safari 等)时静默降级 —— 开关照常保存,由调用方显示
// 一行小字提示去浏览器设置放行。真正的通知派发在 lib/use-run-notifications。
// ============================================================================

import * as React from "react"

export type NotifyPermission = "granted" | "denied" | "default" | "unsupported"

function readPermission(): NotifyPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported"
  return Notification.permission
}

export function useNotifyPermission() {
  // 初始按 "default" 渲染(SSR 安全),挂载后读真实值
  const [permission, setPermission] = React.useState<NotifyPermission>("default")
  React.useEffect(() => {
    setPermission(readPermission())
  }, [])

  /** 开关开启前调用:仅 default 态弹浏览器授权;返回最新权限态,denied 也不阻断保存。 */
  const ensurePermission = React.useCallback(async (): Promise<NotifyPermission> => {
    const current = readPermission()
    if (current !== "default") {
      setPermission(current)
      return current
    }
    try {
      const next = await Notification.requestPermission()
      setPermission(next)
      return next
    } catch {
      // 老式回调签名或被浏览器策略拦截:按当前真实值返回,不报错
      const fallback = readPermission()
      setPermission(fallback)
      return fallback
    }
  }, [])

  return { permission, ensurePermission }
}
