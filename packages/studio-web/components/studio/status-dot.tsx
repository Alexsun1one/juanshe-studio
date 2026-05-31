import { cn } from "@/lib/utils"
import type { AgentStatus } from "@/lib/studio-data"

const STATUS_COLOR: Record<AgentStatus, string> = {
  running: "bg-status-running",
  done: "bg-status-success",
  warning: "bg-status-warning",
  error: "bg-status-error",
  idle: "bg-status-idle",
  paused: "bg-status-paused",
  queued: "bg-status-queued",
}

export function StatusDot({
  status,
  size = "sm",
  pulse,
}: {
  status: AgentStatus
  size?: "xs" | "sm" | "md"
  pulse?: boolean
}) {
  const sizeCls =
    size === "xs" ? "h-1.5 w-1.5" : size === "md" ? "h-2.5 w-2.5" : "h-2 w-2"

  return (
    <span className="relative inline-flex items-center justify-center">
      <span
        className={cn(
          "inline-block rounded-full",
          sizeCls,
          STATUS_COLOR[status],
        )}
      />
      {pulse && status === "running" && (
        <span
          className={cn(
            "absolute inline-block rounded-full opacity-25 ring-2 ring-status-running/40",
            sizeCls,
          )}
        />
      )}
    </span>
  )
}

// 心跳波形条 — 5 根 micro 柱
export function Heartbeat({
  active,
  intensity = 0.6,
}: {
  active: boolean
  intensity?: number
}) {
  const heights = [0.4, 0.7, 1, 0.6, 0.45]
  return (
    <span
      className="inline-flex h-3 items-end gap-[2px]"
      aria-hidden
    >
      {heights.map((h, i) => (
        <span
          key={i}
          className={cn(
            "w-[2px] rounded-full transition-colors",
            active ? "bg-status-running" : "bg-muted-foreground/30",
          )}
          style={{
            height: `${Math.max(4, h * 12 * (active ? intensity + 0.4 : 0.3))}px`,
            transformOrigin: "bottom",
          }}
        />
      ))}
    </span>
  )
}
