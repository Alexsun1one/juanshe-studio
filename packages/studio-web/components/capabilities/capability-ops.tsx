"use client"

import * as React from "react"
import {
  Activity,
  Loader2,
  Play,
  Radar,
  RefreshCw,
  ShieldCheck,
  Square,
  Tags,
  Waves,
} from "lucide-react"

import { ENDPOINTS } from "@/lib/api/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"

type OpKey = "doctor" | "daemon" | "radar" | "style" | "genres"

type Snapshot = {
  status: "idle" | "loading" | "ready" | "error"
  data?: unknown
  error?: string
}

const ops: Array<{
  key: OpKey
  title: string
  icon: React.ComponentType<{ className?: string }>
  endpoint: string
}> = [
  { key: "doctor", title: "Doctor", icon: ShieldCheck, endpoint: ENDPOINTS.doctor() },
  { key: "daemon", title: "Daemon", icon: Activity, endpoint: ENDPOINTS.daemon() },
  { key: "radar", title: "Radar", icon: Radar, endpoint: ENDPOINTS.radarLatest() },
  { key: "style", title: "Style", icon: Waves, endpoint: ENDPOINTS.styleAnalyses() },
  { key: "genres", title: "Genres", icon: Tags, endpoint: ENDPOINTS.genres() },
]

export function CapabilityOps() {
  const { toast } = useToast()
  const [snapshots, setSnapshots] = React.useState<Record<OpKey, Snapshot>>({
    doctor: { status: "idle" },
    daemon: { status: "idle" },
    radar: { status: "idle" },
    style: { status: "idle" },
    genres: { status: "idle" },
  })

  const load = React.useCallback(async (key: OpKey, endpoint: string) => {
    setSnapshots((current) => ({
      ...current,
      [key]: { ...current[key], status: "loading", error: undefined },
    }))
    try {
      const response = await fetch(endpoint, { cache: "no-store" })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(extractError(data) || `HTTP ${response.status}`)
      }
      setSnapshots((current) => ({
        ...current,
        [key]: { status: "ready", data },
      }))
    } catch (error) {
      setSnapshots((current) => ({
        ...current,
        [key]: {
          ...current[key],
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        },
      }))
    }
  }, [])

  React.useEffect(() => {
    ops.forEach((op) => void load(op.key, op.endpoint))
  }, [load])

  async function runAction(label: string, endpoint: string) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(extractError(data) || `HTTP ${response.status}`)
      }
      toast({ title: `${label} 已触发` })
      await Promise.all([
        load("daemon", ENDPOINTS.daemon()),
        load("radar", ENDPOINTS.radarLatest()),
      ])
    } catch (error) {
      toast({
        title: `${label} 失败`,
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      })
    }
  }

  return (
    <div className="border-border bg-card rounded-lg border p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-foreground text-base font-semibold">实时能力探针</h2>
          <p className="text-muted-foreground mt-1 text-xs leading-5">
            Doctor、守护进程、市场雷达、文风分析、题材库直接走 Web API。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => ops.forEach((op) => void load(op.key, op.endpoint))}
          >
            <RefreshCw className="size-4" />
            刷新
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void runAction("启动 Daemon", ENDPOINTS.daemonStart())}
          >
            <Play className="size-4" />
            Daemon
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void runAction("停止 Daemon", ENDPOINTS.daemonStop())}
          >
            <Square className="size-4" />
            停止
          </Button>
          <Button
            size="sm"
            onClick={() => void runAction("Radar Scan", ENDPOINTS.radarScan())}
          >
            <Radar className="size-4" />
            扫描
          </Button>
        </div>
      </header>

      <div className="mt-5 grid gap-3 lg:grid-cols-5">
        {ops.map((op) => (
          <OpCard
            key={op.key}
            icon={op.icon}
            title={op.title}
            snapshot={snapshots[op.key]}
            onRefresh={() => void load(op.key, op.endpoint)}
          />
        ))}
      </div>
    </div>
  )
}

function OpCard({
  icon: Icon,
  title,
  snapshot,
  onRefresh,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  snapshot: Snapshot
  onRefresh: () => void
}) {
  const loading = snapshot.status === "loading"
  return (
    <div className="border-border bg-card min-w-0 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="text-muted-foreground size-4 shrink-0" />
          <span className="text-foreground truncate text-sm font-medium">
            {title}
          </span>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          onClick={onRefresh}
          disabled={loading}
          title="刷新"
          aria-label="刷新"
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </Button>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <Badge variant={snapshot.status === "error" ? "outline" : "secondary"}>
          {snapshot.status === "idle"
            ? "待载入"
            : snapshot.status === "loading"
              ? "读取中"
              : snapshot.status === "ready"
                ? "在线"
                : "异常"}
        </Badge>
        <span className="text-muted-foreground truncate font-mono text-[10px]">
          {summaryText(snapshot)}
        </span>
      </div>
    </div>
  )
}

function summaryText(snapshot: Snapshot) {
  if (snapshot.error) return snapshot.error
  if (!snapshot.data) return "-"
  if (Array.isArray(snapshot.data)) return `${snapshot.data.length} rows`
  if (typeof snapshot.data !== "object") return String(snapshot.data)
  const data = snapshot.data as Record<string, unknown>
  if (typeof data.status === "string") return data.status
  if (typeof data.running === "boolean") return data.running ? "running" : "stopped"
  if (Array.isArray(data.items)) return `${data.items.length} items`
  if (Array.isArray(data.genres)) return `${data.genres.length} genres`
  if (Array.isArray(data.analyses)) return `${data.analyses.length} analyses`
  if (Array.isArray(data.opportunities)) return `${data.opportunities.length} signals`
  return `${Object.keys(data).length} fields`
}

function extractError(data: unknown) {
  if (!data || typeof data !== "object") return ""
  const record = data as Record<string, unknown>
  if (typeof record.error === "string") return record.error
  if (record.error && typeof record.error === "object") {
    const error = record.error as Record<string, unknown>
    if (typeof error.message === "string") return error.message
  }
  if (typeof record.message === "string") return record.message
  return ""
}
