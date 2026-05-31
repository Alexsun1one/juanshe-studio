"use client"

import * as React from "react"
import { SWRConfig } from "swr"

/**
 * 全站 SWR 默认配置 — 解决"切页空白闪一下再渲染"的核心 perf 体感问题。
 *
 *  - keepPreviousData: true   → 切回旧 key 时不抹掉旧数据,后台 revalidate
 *  - revalidateOnFocus: false → 浏览器切回不强制重拉(本地写作场景不需要)
 *  - dedupingInterval: 4000   → 4 秒内相同 key 的请求合并,降低 LLM/SSE 风暴
 *  - errorRetryCount: 2       → 错了别死命重试,我们大多是本地 4569 端点
 *
 * 单个 useSWR 仍可在 options 里覆盖这些(例如 use-run-state 用 refreshInterval)。
 */
export function SwrProvider({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        keepPreviousData: true,
        revalidateOnFocus: false,
        revalidateIfStale: true,
        dedupingInterval: 4000,
        errorRetryCount: 2,
        errorRetryInterval: 1500,
        shouldRetryOnError: (err) => {
          // 后端 4569 没起的时候,无限重试只会塞满 console。挑可恢复的错重试。
          if (!err) return false
          const msg = err instanceof Error ? err.message : String(err)
          return /network|fetch|timeout|abort/i.test(msg)
        },
      }}
    >
      {children}
    </SWRConfig>
  )
}
