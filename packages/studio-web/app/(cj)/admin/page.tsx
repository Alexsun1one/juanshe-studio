"use client"

/* ════════════════════════════════════════════════════════════════
   卷舍 · 管理后台(严格 admin)
   ----------------------------------------------------------------
   进页先查 /auth/me:非 SaaS 或非 admin → 重定向(/login 或 /)。
   三块面板:① 概览 KPI ② 用户表(调额度 / 改 tier,确认弹窗)③ 发码。
   全部走后端 /api/v1/admin/*(门禁在后端,前端守卫只为体验,不是安全边界)。
   内部工具,功能优先,但守设计规范:暖纸柔紫 / 像素徽章 / 复用 KpiChip + 弹窗。
   ════════════════════════════════════════════════════════════════ */

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldOff,
  Ticket,
  Users,
} from "lucide-react"

import { KpiChip } from "@/components/design/kit"
import { PixelBadge } from "@/components/design/pixel-badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  adjustUserCredits,
  fetchAdminCodes,
  fetchAdminOverview,
  fetchAdminUsers,
  fetchAuthMe,
  mintCode,
  revokeCode,
  setUserTier,
  type AdminCodeRow,
  type AdminOverview,
  type AdminUserRow,
  type CodeStatus,
  type Tier,
} from "@/lib/api/admin"

import "./admin.css"

type Guard = "checking" | "ok" | "denied"

const TIER_LABEL: Record<Tier, string> = { normal: "普通", pro: "Pro", ultra: "Ultra" }
const TIER_OPTIONS: Tier[] = ["normal", "pro", "ultra"]
const EXPIRY_OPTIONS: Array<{ days: number | undefined; label: string }> = [
  { days: undefined, label: "永久" },
  { days: 7, label: "7 天" },
  { days: 30, label: "30 天" },
]
const CODE_STATUS_LABEL: Record<CodeStatus, string> = {
  valid: "可用",
  used: "已领",
  expired: "已过期",
  revoked: "已吊销",
  unknown: "未知",
}

function fmt(n: number | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("zh-CN") : "—"
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return "—"
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message.replace(/^\[api\][^:]*:\s*/, "")
  return String(e)
}

export default function AdminPage() {
  const router = useRouter()
  const [guard, setGuard] = React.useState<Guard>("checking")

  // 进页门禁:非 SaaS → 回首页;SaaS 未登录 → 登录页;登录非 admin → 首页。
  React.useEffect(() => {
    let cancelled = false
    fetchAuthMe()
      .then((me) => {
        if (cancelled) return
        if (!me.saas) {
          router.replace("/")
          setGuard("denied")
          return
        }
        if (!me.authenticated || !me.user) {
          router.replace("/login")
          setGuard("denied")
          return
        }
        if (me.user.role !== "admin") {
          router.replace("/")
          setGuard("denied")
          return
        }
        setGuard("ok")
      })
      .catch(() => {
        if (cancelled) return
        // /auth/me 不可达:按非 admin 处理(不把人锁进后台,也不假装有权)。
        router.replace("/")
        setGuard("denied")
      })
    return () => {
      cancelled = true
    }
  }, [router])

  if (guard !== "ok") {
    return (
      <div className="page admin-page">
        <div className="admin-guard">
          <Loader2 className="admin-spin" size={20} />
          <span>{guard === "checking" ? "正在校验管理员权限…" : "无权访问,正在跳转…"}</span>
        </div>
      </div>
    )
  }

  return <AdminConsole />
}

function AdminConsole() {
  const [overview, setOverview] = React.useState<AdminOverview | null>(null)
  const [overviewErr, setOverviewErr] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)

  const loadOverview = React.useCallback(async () => {
    setRefreshing(true)
    try {
      setOverview(await fetchAdminOverview())
      setOverviewErr(null)
    } catch (e) {
      setOverviewErr(errMsg(e))
    } finally {
      setRefreshing(false)
    }
  }, [])

  React.useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  return (
    <div className="page admin-page">
      <header className="page-head">
        <PixelBadge kind="grp-system" size={40} ariaLabel="管理后台" className="admin-hero-pixel" />
        <div>
          <div className="page-title-row">
            <h1 className="page-title">管理后台</h1>
            <span className="admin-role-chip"><ShieldCheck size={11} /> Admin</span>
          </div>
          <p className="page-sub">
            卷舍编辑部运营总台 —— 看清平台用户与作品规模、调用户软配额与会员档、签发与吊销激活码。
            credits 是防滥用软配额,不卖、不充值;这里只做运营调度。
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className={`btn sm${refreshing ? " is-loading" : ""}`}
            onClick={() => void loadOverview()}
            disabled={refreshing}
          >
            <RefreshCw size={13} /> 刷新概览
          </button>
        </div>
      </header>

      <OverviewPanel overview={overview} error={overviewErr} />
      <UsersPanel onMutated={loadOverview} />
      <CodesPanel />
    </div>
  )
}

/* ── ① 概览 ──────────────────────────────────────────────────── */
function OverviewPanel({ overview, error }: { overview: AdminOverview | null; error: string | null }) {
  const d = overview
  return (
    <section className="admin-section">
      <div className="admin-section-head">
        <PixelBadge kind="insights" size={20} ariaLabel="概览" />
        <h2 className="admin-section-title">平台概览</h2>
      </div>
      {error ? (
        <div className="admin-error">{error}</div>
      ) : (
        <div className="admin-kpis" role="group" aria-label="平台概览指标">
          <KpiChip label="总用户" value={fmt(d?.totalUsers)} unit="人" tone="brand" />
          <KpiChip
            label="会员分布"
            value={d ? d.tierDistribution.normal : "—"}
            unit="普通"
            tone="neutral"
            sub={d ? `Pro ${fmt(d.tierDistribution.pro)} · Ultra ${fmt(d.tierDistribution.ultra)}` : "—"}
          />
          <KpiChip label="作品总数" value={fmt(d?.totalBooks)} unit="本" tone="amber" />
          <KpiChip label="近 7 天新增" value={fmt(d?.recentSignups)} unit="人" tone="ok" />
          <KpiChip
            label="活跃写作任务"
            value={fmt(d?.activeWritingJobs)}
            unit="个"
            tone={d && d.activeWritingJobs > 0 ? "info" : "neutral"}
            sub={d ? `在线会话 ${fmt(d.activeSessions)}` : "—"}
          />
          <KpiChip
            label="额度账本"
            value={fmt(d?.creditsGranted)}
            unit="发放"
            tone="rose"
            sub={d ? `已消耗 ${fmt(d.creditsConsumed)}` : "—"}
          />
        </div>
      )}
    </section>
  )
}

/* ── ② 用户表 ────────────────────────────────────────────────── */
type CreditDialogState = { user: AdminUserRow; delta: string; reason: string } | null
type TierDialogState = { user: AdminUserRow; tier: Tier } | null

function UsersPanel({ onMutated }: { onMutated: () => void | Promise<void> }) {
  const [rows, setRows] = React.useState<AdminUserRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [pageSize] = React.useState(50)
  const [search, setSearch] = React.useState("")
  const [searchInput, setSearchInput] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const [creditDialog, setCreditDialog] = React.useState<CreditDialogState>(null)
  const [tierDialog, setTierDialog] = React.useState<TierDialogState>(null)
  const [busy, setBusy] = React.useState(false)
  const [dialogErr, setDialogErr] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetchAdminUsers({ page, pageSize, search })
      setRows(res.users)
      setTotal(res.total)
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search])

  React.useEffect(() => {
    void load()
  }, [load])

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setPage(1)
    setSearch(searchInput)
  }

  const confirmCredits = async () => {
    if (!creditDialog) return
    const delta = Math.trunc(Number(creditDialog.delta))
    if (!Number.isFinite(delta) || delta === 0) {
      setDialogErr("额度增减必须是非零整数。")
      return
    }
    setBusy(true)
    setDialogErr(null)
    try {
      await adjustUserCredits(creditDialog.user.id, delta, creditDialog.reason.trim() || undefined)
      setCreditDialog(null)
      await load()
      await onMutated()
    } catch (e) {
      setDialogErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const confirmTier = async () => {
    if (!tierDialog) return
    setBusy(true)
    setDialogErr(null)
    try {
      await setUserTier(tierDialog.user.id, tierDialog.tier)
      setTierDialog(null)
      await load()
      await onMutated()
    } catch (e) {
      setDialogErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <section className="admin-section">
      <div className="admin-section-head">
        <Users size={16} className="admin-section-ico" />
        <h2 className="admin-section-title">用户管理</h2>
        <span className="admin-section-count">{fmt(total)} 人</span>
        <form className="admin-search" onSubmit={submitSearch}>
          <Search size={13} />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="按邮箱搜索…"
            aria-label="按邮箱搜索用户"
          />
          <button type="submit" className="btn sm">搜索</button>
        </form>
      </div>

      {error ? (
        <div className="admin-error">{error}</div>
      ) : (
        <div className="admin-tablewrap scroll-thin">
          <table className="admin-table">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>会员档</th>
                <th className="num">软配额</th>
                <th className="num">作品</th>
                <th>注册时间</th>
                <th>最近活跃</th>
                <th className="admin-col-act">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={7} className="admin-table-state"><Loader2 className="admin-spin" size={16} /> 加载中…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="admin-table-state">没有匹配的用户</td></tr>
              ) : (
                rows.map((u) => (
                  <tr key={u.id}>
                    <td className="admin-email">
                      <span className="admin-email-main">{u.email}</span>
                      {u.role === "admin" && <span className="admin-mini-chip"><ShieldCheck size={9} /> admin</span>}
                    </td>
                    <td>
                      <span className={`admin-tier-tag tier-${u.tier}`}>{TIER_LABEL[u.tier]}</span>
                      {u.tierExpiresAt && (
                        <span className="admin-tier-exp" title={`到期回落普通:${fmtDate(u.tierExpiresAt)}`}>
                          至 {fmtDate(u.tierExpiresAt)}
                        </span>
                      )}
                    </td>
                    <td className="num tabular">{fmt(u.credits)}</td>
                    <td className="num tabular">{fmt(u.bookCount)}</td>
                    <td className="admin-muted">{fmtDate(u.createdAt)}</td>
                    <td className="admin-muted">{fmtDate(u.lastActiveAt)}</td>
                    <td className="admin-col-act">
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => { setDialogErr(null); setCreditDialog({ user: u, delta: "", reason: "" }) }}
                      >
                        调额度
                      </button>
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => { setDialogErr(null); setTierDialog({ user: u, tier: u.tier }) }}
                      >
                        改档
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="admin-pager">
          <button type="button" className="btn sm ghost" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</button>
          <span className="admin-pager-info">第 {page} / {totalPages} 页</span>
          <button type="button" className="btn sm ghost" disabled={page >= totalPages || loading} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>下一页</button>
        </div>
      )}

      {/* 调额度确认弹窗 */}
      <Dialog open={!!creditDialog} onOpenChange={(o) => { if (!o) setCreditDialog(null) }}>
        <DialogContent className="admin-dialog">
          <DialogHeader>
            <DialogTitle>调整软配额</DialogTitle>
            <DialogDescription>
              {creditDialog?.user.email} · 当前 <b className="tabular">{fmt(creditDialog?.user.credits)}</b> credits。
              增减为非零整数(正=发放,负=回收),记一笔 admin-adjust 账本。
            </DialogDescription>
          </DialogHeader>
          {creditDialog && (
            <div className="admin-form">
              <label className="admin-field">
                <span className="admin-field-label">增减额</span>
                <div className="admin-delta">
                  <button type="button" className="admin-delta-btn" aria-label="减" onClick={() => setCreditDialog((s) => s && ({ ...s, delta: String((Math.trunc(Number(s.delta)) || 0) - 100) }))}><Minus size={13} /></button>
                  <input
                    type="number"
                    className="admin-input tabular"
                    value={creditDialog.delta}
                    onChange={(e) => setCreditDialog((s) => s && ({ ...s, delta: e.target.value }))}
                    placeholder="例如 +500 或 -100"
                    autoFocus
                  />
                  <button type="button" className="admin-delta-btn" aria-label="加" onClick={() => setCreditDialog((s) => s && ({ ...s, delta: String((Math.trunc(Number(s.delta)) || 0) + 100) }))}><Plus size={13} /></button>
                </div>
                {(() => {
                  const delta = Math.trunc(Number(creditDialog.delta))
                  if (!Number.isFinite(delta) || delta === 0) return null
                  const next = Math.max(0, (creditDialog.user.credits ?? 0) + delta)
                  return <span className="admin-field-hint">调整后:<b className="tabular">{fmt(next)}</b> credits</span>
                })()}
              </label>
              <label className="admin-field">
                <span className="admin-field-label">备注(可选)</span>
                <input
                  type="text"
                  className="admin-input"
                  value={creditDialog.reason}
                  onChange={(e) => setCreditDialog((s) => s && ({ ...s, reason: e.target.value }))}
                  placeholder="如:补偿、活动赠送…"
                  maxLength={200}
                />
              </label>
            </div>
          )}
          {dialogErr && <div className="admin-error sm">{dialogErr}</div>}
          <DialogFooter>
            <button type="button" className="btn" onClick={() => setCreditDialog(null)} disabled={busy}>取消</button>
            <button type="button" className={`btn primary${busy ? " is-loading" : ""}`} onClick={() => void confirmCredits()} disabled={busy}>确认调整</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 改 tier 确认弹窗 */}
      <Dialog open={!!tierDialog} onOpenChange={(o) => { if (!o) setTierDialog(null) }}>
        <DialogContent className="admin-dialog">
          <DialogHeader>
            <DialogTitle>修改会员档</DialogTitle>
            <DialogDescription>
              {tierDialog?.user.email} · 当前 <b>{tierDialog ? TIER_LABEL[tierDialog.user.tier] : ""}</b>。
              管理员手改为<b>永久档</b>(清除任何限时到期标记)。
            </DialogDescription>
          </DialogHeader>
          {tierDialog && (
            <div className="admin-seg" role="radiogroup" aria-label="选择会员档">
              {TIER_OPTIONS.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={tierDialog.tier === t}
                  className={`admin-seg-btn${tierDialog.tier === t ? " active" : ""}`}
                  onClick={() => setTierDialog((s) => s && ({ ...s, tier: t }))}
                >
                  {tierDialog.tier === t && <Check size={12} />} {TIER_LABEL[t]}
                </button>
              ))}
            </div>
          )}
          {dialogErr && <div className="admin-error sm">{dialogErr}</div>}
          <DialogFooter>
            <button type="button" className="btn" onClick={() => setTierDialog(null)} disabled={busy}>取消</button>
            <button
              type="button"
              className={`btn primary${busy ? " is-loading" : ""}`}
              onClick={() => void confirmTier()}
              disabled={busy || (tierDialog ? tierDialog.tier === tierDialog.user.tier && !tierDialog.user.tierExpiresAt : true)}
            >
              确认改档
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

/* ── ③ 发码 ──────────────────────────────────────────────────── */
function CodesPanel() {
  const [codes, setCodes] = React.useState<AdminCodeRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const [tier, setTier] = React.useState<Tier>("pro")
  const [expiry, setExpiry] = React.useState<number | undefined>(undefined)
  const [minting, setMinting] = React.useState(false)
  const [mintErr, setMintErr] = React.useState<string | null>(null)
  const [justMinted, setJustMinted] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState<string | null>(null)
  const [revoking, setRevoking] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetchAdminCodes()
      setCodes(res.codes)
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(code)
      window.setTimeout(() => setCopied((c) => (c === code ? null : c)), 1600)
    } catch {
      /* 剪贴板不可用时静默 —— 码仍可手选复制 */
    }
  }

  const doMint = async () => {
    setMinting(true)
    setMintErr(null)
    try {
      const res = await mintCode(tier, expiry)
      setJustMinted(res.code)
      await copy(res.code)
      await load()
    } catch (e) {
      setMintErr(errMsg(e))
    } finally {
      setMinting(false)
    }
  }

  const doRevoke = async (code: string) => {
    setRevoking(code)
    try {
      await revokeCode(code)
      await load()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setRevoking(null)
    }
  }

  return (
    <section className="admin-section">
      <div className="admin-section-head">
        <Ticket size={16} className="admin-section-ico" />
        <h2 className="admin-section-title">激活码发放</h2>
        <span className="admin-section-count">{fmt(codes.length)} 张</span>
      </div>

      <div className="admin-mint">
        <div className="admin-mint-row">
          <div className="admin-mint-field">
            <span className="admin-field-label">会员档</span>
            <div className="admin-seg" role="radiogroup" aria-label="选择码的会员档">
              {TIER_OPTIONS.map((t) => (
                <button key={t} type="button" role="radio" aria-checked={tier === t} className={`admin-seg-btn${tier === t ? " active" : ""}`} onClick={() => setTier(t)}>
                  {TIER_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
          <div className="admin-mint-field">
            <span className="admin-field-label">有效期</span>
            <div className="admin-seg" role="radiogroup" aria-label="选择码的有效期">
              {EXPIRY_OPTIONS.map((o) => (
                <button key={o.label} type="button" role="radio" aria-checked={expiry === o.days} className={`admin-seg-btn${expiry === o.days ? " active" : ""}`} onClick={() => setExpiry(o.days)}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <button type="button" className={`btn primary admin-mint-go${minting ? " is-loading" : ""}`} onClick={() => void doMint()} disabled={minting}>
            <KeyRound size={14} /> 生成激活码
          </button>
        </div>
        {expiry != null && (
          <p className="admin-mint-note">限时码到期后会员自动回落「普通」档。</p>
        )}
        {mintErr && <div className="admin-error sm">{mintErr}</div>}
        {justMinted && (
          <div className="admin-minted">
            <span className="admin-minted-label">新码已生成{copied === justMinted ? "(已复制)" : ""}</span>
            <code className="admin-code">{justMinted}</code>
            <button type="button" className="btn sm" onClick={() => void copy(justMinted)}>
              {copied === justMinted ? <Check size={13} /> : <Copy size={13} />} 复制
            </button>
          </div>
        )}
      </div>

      {error ? (
        <div className="admin-error">{error}</div>
      ) : (
        <div className="admin-tablewrap scroll-thin">
          <table className="admin-table">
            <thead>
              <tr>
                <th>激活码</th>
                <th>档</th>
                <th>状态</th>
                <th>发给</th>
                <th>到期</th>
                <th>签发时间</th>
                <th className="admin-col-act">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && codes.length === 0 ? (
                <tr><td colSpan={7} className="admin-table-state"><Loader2 className="admin-spin" size={16} /> 加载中…</td></tr>
              ) : codes.length === 0 ? (
                <tr><td colSpan={7} className="admin-table-state">还没有签发过激活码</td></tr>
              ) : (
                codes.map((c) => (
                  <tr key={c.id} className={c.status === "revoked" || c.status === "expired" ? "is-dim" : undefined}>
                    <td>
                      <button type="button" className="admin-code-cell" onClick={() => void copy(c.code)} title="点击复制">
                        <code className="admin-code sm">{c.code}</code>
                        {copied === c.code ? <Check size={11} /> : <Copy size={11} className="admin-code-copy" />}
                      </button>
                    </td>
                    <td><span className={`admin-tier-tag tier-${c.tier}`}>{TIER_LABEL[c.tier]}</span></td>
                    <td><span className={`admin-status status-${c.status}`}>{CODE_STATUS_LABEL[c.status]}</span></td>
                    <td className="admin-muted">{c.issuedTo ?? "—"}</td>
                    <td className="admin-muted">{c.expiresAt ? fmtDate(c.expiresAt) : "永久"}</td>
                    <td className="admin-muted">{fmtDate(c.issuedAt)}</td>
                    <td className="admin-col-act">
                      {c.status === "revoked" ? (
                        <span className="admin-muted">已吊销</span>
                      ) : (
                        <button
                          type="button"
                          className={`btn sm ghost danger${revoking === c.code ? " is-loading" : ""}`}
                          onClick={() => void doRevoke(c.code)}
                          disabled={revoking === c.code}
                        >
                          <ShieldOff size={12} /> 吊销
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
