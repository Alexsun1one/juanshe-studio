"use client"

import * as React from "react"

type Tier = "normal" | "pro" | "ultra"

const KEY = "cj.tier"
const FALLBACK: Tier = "normal"
const EVENT = "cj:tier"

function isTier(value: unknown): value is Tier {
  return value === "normal" || value === "pro" || value === "ultra"
}

function readTierCache(): Tier {
  try {
    const tier = localStorage.getItem(KEY)
    return isTier(tier) ? tier : FALLBACK
  } catch {
    return FALLBACK
  }
}

export function setTierCache(tier: string): void {
  if (!isTier(tier) || typeof window === "undefined") return
  try {
    localStorage.setItem(KEY, tier)
    window.dispatchEvent(new CustomEvent(EVENT))
  } catch {
    /* ignore */
  }
}

export function useTier(): Tier {
  const [tier, setTier] = React.useState<Tier>(FALLBACK)

  React.useEffect(() => {
    let cancelled = false
    const read = () => {
      if (!cancelled) setTier(readTierCache())
    }

    read()
    fetch("/api/v1/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return
        const liveTier = json?.user?.tier
        if (!isTier(liveTier)) return
        if (readTierCache() !== liveTier) setTierCache(liveTier)
        setTier(liveTier)
      })
      .catch(() => {
        /* 保留本地缓存,不因临时失败降级 */
      })

    window.addEventListener("storage", read)
    window.addEventListener(EVENT, read)
    return () => {
      cancelled = true
      window.removeEventListener("storage", read)
      window.removeEventListener(EVENT, read)
    }
  }, [])

  return tier
}
