"use client"

import * as React from "react"
import { Crown, Check, Sparkles, KeyRound, Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { getDeviceId } from "@/lib/device-id"
import { authErrorMessage } from "@/lib/describe-error"
import { setTierCache } from "@/lib/use-tier"
import "./vip-upgrade-dialog.css"

type Tier = "normal" | "pro" | "ultra"

const TIERS: ReadonlyArray<{ id: Tier; name: string; mode: string; tagline: string; perks: string[] }> = [
  { id: "normal", name: "普通会员", mode: "轻", tagline: "免激活码,进站就能写", perks: ["「轻」档写作", "规划 → 写手 → 审稿", "全部基础功能"] },
  { id: "pro", name: "Pro 会员", mode: "中", tagline: "加一轮复修 + 润色,质量更稳", perks: ["解锁「中」档", "复修 + 润色", "更高质量门槛"] },
  { id: "ultra", name: "Ultra 会员", mode: "重", tagline: "全流程精修,最高质量", perks: ["解锁「重」档", "全流程复修", "读者 + 风格评审", "去 AI 味"] },
]

const RANK: Record<Tier, number> = { normal: 0, pro: 1, ultra: 2 }
const TIER_LABEL: Record<string, string> = { pro: "Pro", ultra: "Ultra", normal: "普通" }

/** 成为 VIP / 升级会员弹窗 —— 写作强度档位(轻/中/重)由会员等级决定,等级编进激活码。
 *  点锁住的档位即弹出;讲清三档各解锁什么 + 就地输入激活码升级(不用再被甩去登录页)。 */
export function VipUpgradeDialog({
  open, onOpenChange, tier,
}: { open: boolean; onOpenChange: (o: boolean) => void; tier: Tier }) {
  const [code, setCode] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)

  // 弹窗重开时清掉上次的错误残留
  React.useEffect(() => {
    if (open) setErr(null)
  }, [open])

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (busy) return
    const trimmed = code.trim()
    if (!trimmed) {
      setErr("请输入 Pro / Ultra 激活码。")
      return
    }
    setBusy(true)
    setErr(null)
    try {
      // 当前账号邮箱(login 成功时存过);桌面/无邮箱场景带空串,后端按码本身激活
      let email = ""
      try { email = localStorage.getItem("cj.email") ?? "" } catch { /* ignore */ }
      const res = await fetch("/api/v1/auth/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: trimmed, email, deviceId: getDeviceId() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.error) {
        setErr(authErrorMessage(res, data, "激活码无效,请检查后重试。"))
        setBusy(false)
        return
      }
      const newTier = data?.activation?.tier ? String(data.activation.tier) : null
      if (newTier) setTierCache(newTier)
      toast.success(`已升级为${TIER_LABEL[newTier ?? ""] ?? ""}会员,正在刷新…`)
      // tier 渗透全站(写作档位/credits/锁定的入口),整页刷新最干净
      setTimeout(() => window.location.reload(), 900)
    } catch {
      setErr("无法连接卷舍后端,请稍后重试。")
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="vip-dialog">
        <DialogHeader>
          <DialogTitle className="vip-title"><Crown size={17} /> 成为 VIP，解锁更强的编辑部</DialogTitle>
          <DialogDescription>
            不需要激活码也能写书——普通会员免码进站,「轻」档够用顺手。
            想要更强的编辑部?「中 / 重」档由 Pro / Ultra 激活码解锁。
          </DialogDescription>
        </DialogHeader>

        <div className="vip-tiers">
          {TIERS.map((t) => {
            const current = t.id === tier
            const owned = RANK[tier] >= RANK[t.id]
            return (
              <div key={t.id} className={`vip-tier vip-${t.id}${current ? " current" : ""}`}>
                <div className="vip-tier-head">
                  <span className="vip-tier-mode">{t.mode}</span>
                  <span className="vip-tier-name">{t.name}</span>
                  {current && <span className="vip-tier-now">当前</span>}
                </div>
                <p className="vip-tier-tag">{t.tagline}</p>
                <ul className="vip-perks">
                  {t.perks.map((p, i) => <li key={i}><Check size={12} /> {p}</li>)}
                </ul>
                <span className={`vip-tier-state${owned ? " owned" : ""}`}>
                  {owned ? "✓ 已拥有" : `需 ${t.name}激活码`}
                </span>
              </div>
            )
          })}
        </div>

        <form className="vip-activate" onSubmit={submit}>
          <label className="vip-activate-lab" htmlFor="vip-code"><KeyRound size={13} /> 输入激活码,立即升级</label>
          <div className="vip-activate-row">
            <input
              id="vip-code"
              className="vip-activate-inp"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Pro / Ultra 激活码"
              disabled={busy}
              autoComplete="off"
            />
            <button type="submit" className="vip-cta" disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {busy ? "验证中…" : "激活升级"}
            </button>
          </div>
          {err && <p className="vip-err">{err}</p>}
        </form>

        <div className="vip-how">
          <span className="vip-how-h"><Sparkles size={13} /> 怎么成为 VIP?</span>
          <p>
            关注公众号<b>「正在逐渐AI化」</b>回复<b>「领码」</b>领 <b>Pro 体验码</b>;
            或用已购的 Pro / Ultra 激活码——在上面输入即生效,不用重新进站。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
