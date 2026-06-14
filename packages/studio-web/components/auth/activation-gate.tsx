"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"

type ActivationState = {
  required?: boolean
  unlocked?: boolean
}

type MeState = {
  saas?: boolean
  authenticated?: boolean
  user?: { id?: string; email?: string } | null
}

export function ActivationGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [allowed, setAllowed] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false

    async function check() {
      // ── SaaS(托管多租户):用真实会话判定,不再信任 localStorage ──
      // /auth/me 返回 { saas, authenticated, user }。saas:true 时:
      //   - 有 user → 放行;无 user → 回登录页(清掉桌面遗留的本地标记)。
      // saas:false(桌面单机)或后端不可达降级 → 走下方原有 localStorage + 激活逻辑,字节级不变。
      try {
        const me = (await fetch("/api/v1/auth/me", { cache: "no-store" }).then((r) => r.json())) as MeState | null
        if (me?.saas) {
          const authedSaas = Boolean(me?.user)
          if (!authedSaas) {
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
          if (!cancelled) setAllowed(true)
          return
        }
      } catch {
        // /auth/me 不可达 → 当作桌面处理,落到下方 localStorage 逻辑,不硬锁本地使用。
      }

      // ── 桌面单机:维持原有激活状态 + localStorage 进站逻辑(完全不变) ──
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
      let authed: boolean
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
    void check()

    return () => {
      cancelled = true
    }
  }, [pathname, router])

  if (!allowed) return null
  return <>{children}</>
}
