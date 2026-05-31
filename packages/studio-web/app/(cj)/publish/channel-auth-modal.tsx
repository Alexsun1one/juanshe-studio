"use client"

import * as React from "react"
import { toast } from "sonner"
import { X, ShieldCheck, ExternalLink } from "lucide-react"

/* 平台连接状态(账号级,本地记录;AutoW 不代持平台密钥) */
export type ChannelState = { connected: boolean; handle: string }
export type AuthMap = Record<string, ChannelState>

export const PUBLISH_PLATFORMS: { id: string; name: string; grad: string; logo: string; note: string }[] = [
  { id: "wechat_mp", name: "微信公众号", grad: "linear-gradient(135deg,#07C160,#3FD394)", logo: "公", note: "在公众号后台「设置与开发」获取 AppID/Secret 后手动发布" },
  { id: "xiaohongshu", name: "小红书", grad: "linear-gradient(135deg,#FF2442,#FF6E8A)", logo: "红", note: "创作者中心绑定后,成品复制粘贴发布" },
  { id: "zhihu", name: "知乎", grad: "linear-gradient(135deg,#0084FF,#5FA0F0)", logo: "知", note: "登录知乎后,长文可直接粘贴 Markdown" },
  { id: "x", name: "X / Twitter", grad: "linear-gradient(135deg,#1D1D1F,#555)", logo: "X", note: "用「X 分条」导出后,逐条发布或接 API" },
  { id: "newsletter", name: "Newsletter", grad: "linear-gradient(135deg,#6E5BFA,#9D8AFF)", logo: "N", note: "邮件订阅平台(如 Substack)绑定后导出推送" },
]

const LS_KEY = "autow:channel-auth"

export function loadChannelAuth(): AuthMap {
  if (typeof window === "undefined") return {}
  try {
    return JSON.parse(window.localStorage.getItem(LS_KEY) || "{}") as AuthMap
  } catch {
    return {}
  }
}

export function connectedChannelNames(auth: AuthMap): string[] {
  return PUBLISH_PLATFORMS.filter((p) => auth[p.id]?.connected).map((p) => p.name)
}

export function ChannelAuthModal({ onClose, onSaved }: { onClose: () => void; onSaved?: (auth: AuthMap) => void }) {
  const [auth, setAuth] = React.useState<AuthMap>({})

  React.useEffect(() => {
    setAuth(loadChannelAuth())
  }, [])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const update = (id: string, patch: Partial<ChannelState>) =>
    setAuth((a) => {
      const prev: ChannelState = a[id] ?? { connected: false, handle: "" }
      return { ...a, [id]: { ...prev, ...patch } }
    })

  const save = () => {
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(auth))
      const n = Object.values(auth).filter((c) => c?.connected).length
      onSaved?.(auth)
      toast.success(`已保存 · ${n} 个渠道标记为已连接`)
      onClose()
    } catch {
      toast.error("保存失败(本地存储不可用)")
    }
  }

  return (
    <div className="cp-overlay" onClick={onClose} role="presentation">
      <div className="cp-modal ca-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="渠道授权">
        <div className="cp-head">
          <div className="cp-title">
            <ShieldCheck size={16} style={{ color: "var(--brand-600)" }} />
            <span className="cp-name">渠道授权</span>
          </div>
          <button type="button" className="cp-x" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="ca-banner">
          AutoW <b>不代持平台密钥</b>。这里仅记录你在各平台的连接状态与账号;实际发布在对应平台完成 —— 成品可在「多平台创作」生成后复制粘贴。
        </div>

        <div className="cp-body ca-body">
          {PUBLISH_PLATFORMS.map((p) => {
            const st = auth[p.id] ?? { connected: false, handle: "" }
            return (
              <div className={`ca-row${st.connected ? " on" : ""}`} key={p.id}>
                <span className="ca-logo" style={{ background: p.grad }}>{p.logo}</span>
                <div className="ca-info">
                  <div className="ca-name">{p.name}</div>
                  <div className="ca-note">{p.note}</div>
                </div>
                <input
                  className="ca-handle"
                  placeholder="账号 / 主页(可选)"
                  aria-label={`${p.name}账号或主页`}
                  value={st.handle}
                  onChange={(e) => update(p.id, { handle: e.target.value })}
                />
                <button
                  type="button"
                  className={`ca-toggle${st.connected ? " on" : ""}`}
                  role="switch"
                  aria-checked={st.connected}
                  onClick={() => update(p.id, { connected: !st.connected })}
                >
                  <span className="knob" />
                  <span className="lbl">{st.connected ? "已连接" : "未连接"}</span>
                </button>
              </div>
            )
          })}
        </div>

        <div className="cp-foot">
          <span className="cp-note"><ExternalLink size={11} style={{ verticalAlign: "-1px" }} /> 自动群发需平台 API + 你提供的凭据,后续按需接入</span>
          <div className="cp-actions">
            <button type="button" className="btn sm" onClick={onClose}>取消</button>
            <button type="button" className="btn primary sm" onClick={save}>保存连接状态</button>
          </div>
        </div>
      </div>
    </div>
  )
}
