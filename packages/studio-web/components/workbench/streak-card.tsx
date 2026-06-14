"use client"

import * as React from "react"
import useSWR from "swr"
import { fetchStreak } from "@/lib/api/client"
import type { Streak } from "@/lib/api/types"
import { useAuthorName } from "@/lib/use-author-name"
import { WritingHeatmap } from "@/components/workbench/writing-heatmap"
import { CelebrationBurst } from "@/components/workbench/celebration-burst"
import { ShareCardDialog } from "@/components/workbench/share-card"
import "./streak-card.css"

const fmt = (n: number | undefined | null) =>
  typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "0"

// 里程碑配置（与后端 STREAK_MILESTONES 同步，仅用于"临近鼓励"的本地展示；
// 实际发放门禁/幂等全在后端，前端不自算奖励）。
const MILESTONES = [3, 7, 14, 30] as const

// 下一个未达成的里程碑 + 还差几天（用于"再写 N 天就到 X 天里程碑"鼓励）。
function nextMilestone(currentStreak: number): { target: number; remain: number } | null {
  for (const m of MILESTONES) {
    if (currentStreak < m) return { target: m, remain: m - currentStreak }
  }
  return null
}

export function StreakCard({
  bookTitle,
  totalWords: bookTotalWords,
}: {
  bookTitle: string
  /** 当前作品累计字数（晒连更卡用书级数字，比全工作区 totalWords 更贴切）*/
  totalWords?: number
}) {
  const author = useAuthorName()
  // 6 分钟轮询：连更/今日字数会随写作变化，但不必频繁打后端（命中里程碑发放是幂等的）。
  const { data, error } = useSWR<Streak>("streak", fetchStreak, {
    refreshInterval: 360_000,
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  })

  const [shareOpen, setShareOpen] = React.useState(false)
  // 新发放里程碑 → 庆祝。后端用 user.streakRewards 保证只发一次，故 newlyRewarded 非空即可直接庆祝。
  const [celebrate, setCelebrate] = React.useState<{ sig: number; note?: string }>({ sig: 0 })
  const rewardedKey = React.useRef<string>("")
  React.useEffect(() => {
    const rewards = data?.newlyRewarded ?? []
    if (!rewards.length) return
    const key = rewards.map((r) => r.days).join(",")
    if (key === rewardedKey.current) return
    rewardedKey.current = key
    const top = rewards[rewards.length - 1]
    const credits = rewards.reduce((sum, r) => sum + r.credits, 0)
    setCelebrate((c) => ({ sig: c.sig + 1, note: `连更 ${top.days} 天 · +${credits} 额度` }))
  }, [data?.newlyRewarded])

  if (error || !data) {
    // 加载失败/未就绪：不渲染卡（保持工作台干净，不堆错误态）。
    return null
  }

  const { currentStreak, longestStreak, todayWords, calendar } = data
  // 全新用户(还没动过笔):0 连更 + 26 周空格子很「太空」。改用温暖紧凑的「种子格」引导态,
  // 等真有写作记录(连更/最长/活跃天/累计字数任一 > 0)再亮出完整热力图。
  const hasActivity =
    currentStreak > 0 ||
    longestStreak > 0 ||
    (data.activeDays ?? 0) > 0 ||
    (data.totalWords ?? 0) > 0
  const next = nextMilestone(currentStreak)
  // 临近鼓励：差 ≤2 天到下个里程碑时，给一句"再写就到 X 天 +Y 额度"。
  const milestoneCredits: Record<number, number> = { 3: 50, 7: 120, 14: 300, 30: 800 }
  const encourage =
    next && next.remain <= 2
      ? data.saas
        ? `再写 ${next.remain} 天就到 ${next.target} 天连更里程碑 · 解锁 +${milestoneCredits[next.target]} 额度`
        : `再写 ${next.remain} 天就到 ${next.target} 天连更里程碑`
      : todayWords > 0
        ? `今天已经动笔 · 把连更接力棒稳稳传下去`
        : currentStreak > 0
          ? `今天还没动笔 · 写一点就能把 ${currentStreak} 天连更续上`
          : `写下第一章，点亮你的第一格`

  return (
    <section className={`streak-card card${hasActivity ? "" : " is-empty"}`} aria-label="写作打卡">
      <CelebrationBurst signal={celebrate.sig} tone="write" note={celebrate.note} />
      <div className="streak-head">
        <div className="streak-kpis">
          <div className="streak-kpi primary">
            <span className="sk-num num">{currentStreak}</span>
            <span className="sk-label">天连更</span>
          </div>
          <div className="streak-kpi">
            <span className="sk-num num">{fmt(todayWords)}</span>
            <span className="sk-label">今日字数</span>
          </div>
          <div className="streak-kpi">
            <span className="sk-num num">{longestStreak}</span>
            <span className="sk-label">最长连更</span>
          </div>
          {data.saas && typeof data.credits === "number" && (
            <div className="streak-kpi muted">
              <span className="sk-num num">{fmt(data.credits)}</span>
              <span className="sk-label">软配额</span>
            </div>
          )}
        </div>
        {hasActivity && (
          <button
            type="button"
            className="streak-share-btn"
            onClick={() => setShareOpen(true)}
            title="把连更热力图做成精美卡片，晒到朋友圈/社群拉新"
          >
            <span aria-hidden>✦</span> 晒连更
          </button>
        )}
      </div>

      <p className="streak-encourage">{encourage}</p>

      {hasActivity ? (
        <div className="streak-heat">
          <WritingHeatmap calendar={calendar} weeks={26} cell={11} gap={3} />
        </div>
      ) : (
        <div className="streak-empty" role="img" aria-label="还没有写作记录，写下第一章就能点亮第一格">
          <div className="se-row" aria-hidden>
            <span className="se-cell lit" />
            <span className="se-cell dim" />
            <span className="se-cell" />
            <span className="se-cell" />
            <span className="se-cell" />
            <span className="se-cell" />
            <span className="se-cell" />
            <span className="se-arrow">→</span>
            <span className="se-sprout">🌱</span>
          </div>
          <p className="se-line">每写一章，这里就点亮一格。坚持几天，长出一条属于你的连更。</p>
        </div>
      )}

      <ShareCardDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        initialMode="streak"
        allowModeSwitch={false}
        data={{
          bookTitle,
          author,
          calendar,
          currentStreak,
          longestStreak,
          totalWords: bookTotalWords ?? data.totalWords,
        }}
      />
    </section>
  )
}
