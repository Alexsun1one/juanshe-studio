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
