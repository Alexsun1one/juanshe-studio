"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"

type ActivationState = {
  required?: boolean
  unlocked?: boolean
}

export function ActivationGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [allowed, setAllowed] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false

    async function checkActivation() {
      try {
        const res = await fetch("/api/v1/auth/activation", { cache: "no-store" })
        const state = (await res.json().catch(() => null)) as ActivationState | null
        const locked = Boolean(state?.required) && !state?.unlocked
        if (locked) {
          try {
            localStorage.removeItem("cj.authed")
            localStorage.removeItem("cj.activation")
            localStorage.removeItem("cj.tier")
            localStorage.removeItem("cj.email")
          } catch {
            /* localStorage can be unavailable in restricted contexts */
          }
          if (!cancelled) router.replace("/login")
          return
        }
      } catch {
        // The route has a permissive server fallback; if even that fails, do not hard-lock local-only use.
      }
      // 首次运行(还没在本机设过身份)→ 即便本机不强制激活,也先落到登录页:
      // 这是卷舍的品牌入口 + 公众号漏斗。设过身份(cj.authed)后直接放行,不再每次拦。
      let authed = false
      try {
        authed = localStorage.getItem("cj.authed") === "1"
      } catch {
        authed = true // localStorage 不可用时不硬拦本地使用
      }
      if (!authed) {
        if (!cancelled) router.replace("/login")
        return
      }
      if (!cancelled) setAllowed(true)
    }

    setAllowed(false)
    void checkActivation()

    return () => {
      cancelled = true
    }
  }, [pathname, router])

  if (!allowed) return null
  return <>{children}</>
}
