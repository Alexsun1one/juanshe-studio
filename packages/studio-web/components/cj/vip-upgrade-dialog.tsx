"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Crown, Check, Sparkles, KeyRound, ArrowRight } from "lucide-react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog"
import "./vip-upgrade-dialog.css"

type Tier = "normal" | "pro" | "ultra"

const TIERS: ReadonlyArray<{ id: Tier; name: string; mode: string; tagline: string; perks: string[] }> = [
  { id: "normal", name: "普通会员", mode: "轻", tagline: "最省 token,够用顺手", perks: ["「轻」档写作", "规划 → 写手 → 审稿", "全部基础功能"] },
  { id: "pro", name: "Pro 会员", mode: "中", tagline: "加一轮复修 + 润色,质量更稳", perks: ["解锁「中」档", "复修 + 润色", "更高质量门槛"] },
  { id: "ultra", name: "Ultra 会员", mode: "重", tagline: "全流程精修,最高质量", perks: ["解锁「重」档", "全流程复修", "读者 + 风格评审", "去 AI 味"] },
]

const RANK: Record<Tier, number> = { normal: 0, pro: 1, ultra: 2 }

/** 成为 VIP / 升级会员弹窗 —— 写作强度档位(轻/中/重)由会员等级决定,等级编进激活码。
 *  点锁住的档位即弹出;讲清三档各解锁什么 + 怎么升级(用更高等级激活码进站)。 */
export function VipUpgradeDialog({
  open, onOpenChange, tier,
}: { open: boolean; onOpenChange: (o: boolean) => void; tier: Tier }) {
  const router = useRouter()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="vip-dialog">
        <DialogHeader>
          <DialogTitle className="vip-title"><Crown size={17} /> 成为 VIP，解锁更强的编辑部</DialogTitle>
          <DialogDescription>
            写作强度档位「轻 / 中 / 重」由会员等级决定。等级编进激活码——<b>升级 = 用更高等级的激活码进站</b>。
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

        <div className="vip-how">
          <span className="vip-how-h"><Sparkles size={13} /> 怎么成为 VIP?</span>
          <p>
            关注公众号<b>「正在逐渐AI化」</b>回复<b>「领码」</b>领取,或用已购的 Pro / Ultra 激活码——
            点下面切换激活码、重新进站即生效。
          </p>
        </div>

        <DialogFooter>
          <button type="button" className="vip-cta" onClick={() => { onOpenChange(false); router.push("/login") }}>
            <KeyRound size={14} /> 切换 / 输入激活码 <ArrowRight size={14} />
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
