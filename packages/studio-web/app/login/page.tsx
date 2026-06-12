"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ArrowRight, KeyRound, PenLine, Sparkles, AlertCircle, Mail } from "lucide-react"
import { CjLogo } from "@/components/design/cj-logo"
import { setAuthorName } from "@/lib/use-author-name"
import "./login.css"

// 每台浏览器/安装一个稳定设备标识(用于发卡方做软性防共享统计,不含任何隐私)
function getDeviceId(): string {
  try {
    let id = localStorage.getItem("cj.deviceId")
    if (!id) {
      const rnd =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `dev-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
      id = rnd
      localStorage.setItem("cj.deviceId", id)
    }
    return id
  } catch {
    return "unknown-device"
  }
}

// 公众号领码引导(部署时可用 NEXT_PUBLIC_* 覆盖;横条素材默认读 public/wechat-qr.png)
const WECHAT_NAME = process.env.NEXT_PUBLIC_WECHAT_NAME || "正在逐渐AI化"
const WECHAT_KEYWORD = process.env.NEXT_PUBLIC_WECHAT_KEYWORD || "领码"
const WECHAT_QR = process.env.NEXT_PUBLIC_WECHAT_QR || "/wechat-qr.png"
const SILICOVILLE_ARTICLE_URL = "https://mp.weixin.qq.com/s/Dk4MZOrN6gww603wSo8sWQ"
const EDITORIAL_STORY_PARTS = [
  { text: "这里不是一张海报,而是卷舍编辑部的第一盏灯。\n\n" },
  { text: "17 位编辑", tone: "agents" },
  { text: "从 " },
  { text: "SilicoVille", tone: "silicon" },
  { text: " 来到你的书桌:市场雷达看风向,架构师搭骨架,规划师拆章节,写手落下第一行字。审稿官挑刺,读者评审官替读者发问,修稿师把返工接住,润色师把句子磨亮,最后由总编室盖下" },
  { text: "签发", tone: "seal" },
  { text: "。\n\n他们不是替代作者的人。相反,他们被派来学习人类的故事、情绪、平台和审美,把重复、熬夜、返工和格式劳动尽量接过去,让你继续掌握" },
  { text: "方向、语气和最后的拍板权", tone: "author" },
  { text: "。\n\n所以你推开的不是一扇普通登录门,而是 " },
  { text: "SilicoVille 驻人类社会的卷舍分部", tone: "silicon" },
  { text: "。" },
] as const
const EDITORIAL_STORY = EDITORIAL_STORY_PARTS.map((part) => part.text).join("")

export default function LoginPage() {
  const router = useRouter()
  const [author, setAuthor] = React.useState("")
  const [code, setCode] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)
  const [qrError, setQrError] = React.useState(false)
  // 本机是否强制激活:自助部署默认 false → 可免码直接进入;商业分发设 env(HARDWRITE_ACTIVATION_*)后为 true。
  const [activationRequired, setActivationRequired] = React.useState(false)
  React.useEffect(() => {
    fetch("/api/v1/auth/activation", { cache: "no-store" })
      .then((r) => r.json())
      .then((s) => setActivationRequired(Boolean(s?.required)))
      .catch(() => { /* 后端不可达时按"不强制"处理,保持可自助进入 */ })
  }, [])
  const [storyText, setStoryText] = React.useState("")
  const qrRef = React.useRef<HTMLImageElement>(null)
  const storyScrollRef = React.useRef<HTMLDivElement>(null)
  // SSR 注水前图片若已 404,onError 事件会丢失 → 注水后补判一次坏图,确保占位回退生效
  React.useEffect(() => {
    const img = qrRef.current
    if (img && img.complete && img.naturalWidth === 0) setQrError(true)
  }, [])
  React.useEffect(() => {
    let i = 0
    const tick = window.setInterval(() => {
      i += 1
      setStoryText(EDITORIAL_STORY.slice(0, i))
      if (i >= EDITORIAL_STORY.length) window.clearInterval(tick)
    }, 46)
    return () => window.clearInterval(tick)
  }, [])
  React.useEffect(() => {
    const el = storyScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [storyText])

  const storyNodes = React.useMemo(() => {
    const nodes: React.ReactNode[] = []
    let remaining = storyText.length
    EDITORIAL_STORY_PARTS.forEach((part, index) => {
      if (remaining <= 0) return
      const visibleText = part.text.slice(0, remaining)
      remaining -= visibleText.length
      if (!visibleText) return
      const tone = "tone" in part ? part.tone : undefined
      nodes.push(tone ? <span key={index} className={`story-tone story-tone-${tone}`}>{visibleText}</span> : visibleText)
    })
    return nodes
  }, [storyText])

  const enter = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (busy) return
    setErr(null)
    setBusy(true)
    const name = author.trim() || "作者大大"
    const trimmed = code.trim()
    try {
      if (!trimmed) {
        if (!activationRequired) {
          // 自助部署:本机不强制激活 → 免激活码直接进入(等级按 Normal)
          try {
            setAuthorName(name)
            localStorage.setItem("cj.authed", "1")
          } catch {
            /* ignore */
          }
          let onboarded = false
          try { onboarded = localStorage.getItem("cj.onboarded") === "1" } catch { /* ignore */ }
          router.push(onboarded ? "/" : "/welcome")
          return
        }
        setErr("请先输入激活码。关注公众号回复「领码」即可领取。")
        setBusy(false)
        return
      }

      // 有激活码:交后端校验(远程 verify / HMAC / 校验和 / 名单 任一)
      const res = await fetch("/api/v1/auth/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: trimmed, authorName: author.trim(), email: email.trim(), deviceId: getDeviceId() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.error) {
        setErr(data?.error?.message || "激活码无效,请检查后重试。")
        setBusy(false)
        return
      }
      // 记下等级(Normal/Pro/Ultra)与邮箱,供全站显示/按等级解锁
      try {
        const tier = data?.activation?.tier
        if (tier) localStorage.setItem("cj.tier", String(tier))
        if (email.trim()) localStorage.setItem("cj.email", email.trim())
      } catch { /* ignore */ }
      // 通过:写本地身份后进门
      try {
        setAuthorName(name)
        localStorage.setItem("cj.authed", "1")
        if (trimmed) localStorage.setItem("cj.activation", trimmed)
      } catch {
        /* ignore */
      }
      // 首次登录 → 编辑部入职过场(总编寒暄 + 新手引导);复访 → 直接进站
      let onboarded = false
      try { onboarded = localStorage.getItem("cj.onboarded") === "1" } catch { /* ignore */ }
      router.push(onboarded ? "/" : "/welcome")
    } catch {
      setErr("无法连接卷舍后端,请确认服务已启动后重试。")
      setBusy(false)
    }
  }

  return (
    <div className="cj-login">
      {/* 左:背景故事 + 编辑部主视觉 */}
      <aside className="aside">
        <div className="aside-brand">
          <span className="mk">
            <CjLogo size={22} />
          </span>
          <span className="nm">卷舍 · 编辑部</span>
        </div>

        <div className="login-office-scene">
          <picture>
            <source
              type="image/webp"
              srcSet="/brand/office-hero-small.webp 720w, /brand/office-hero-medium.webp 1080w, /brand/office-hero-large.webp 1440w"
              sizes="(max-width: 880px) 92vw, 68vw"
            />
            <img
              src="/brand/office-hero-medium.webp"
              alt="卷舍像素编辑部,17 位编辑在书桌前写作协作"
              width={1080}
              height={608}
              decoding="async"
              fetchPriority="high"
              draggable={false}
            />
          </picture>
          <span className="scene-lamp-glow" />
          <div className="story" aria-label="卷舍编辑部介绍">
            <h1>卷舍不是凭空开张的,<br />它是<span className="grad">硅基小镇</span>派来的编辑部。</h1>
            <div className="slogan">「 从<span className="silicon">硅基小镇</span>,来到<b>碳基书桌</b>。 」</div>
            <div className="story-scroll scroll-thin" ref={storyScrollRef} aria-label="编辑部故事">
              <p className="typewriter-copy">
                {storyNodes}
                <span className="typewriter-cursor" aria-hidden />
              </p>
            </div>
            <a className="silicoville-link" href={SILICOVILLE_ARTICLE_URL} target="_blank" rel="noreferrer">
              了解硅基小镇
            </a>
          </div>
        </div>
        <p className="token-nudge">
          <span>TOKEN 小贴士</span>
          把一些便宜 token 交给他们试试吧。闲着也未必变现,喂给这群爱写作的家伙,说不定真会冒出一篇大作。当然,你给的方向越准,他们越会卷。
        </p>
      </aside>

      {/* 右:进入卷舍(作者名 + 激活码)*/}
      <main className="panel">
        <form className="card" onSubmit={enter}>
          <div className="card-emblem"><Sparkles size={18} /></div>
          <h2>推开卷舍的门</h2>
          <p className="card-sub">里面那群永不疲倦的家伙,已经为你<span className="juan">卷</span>了很久了。</p>

          <label className="field">
            <span className="lab"><PenLine size={13} /> 你想被称作?</span>
            <input
              className="inp"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="作者大大"
              maxLength={20}
              autoFocus
            />
            <span className="hint">编辑部会这样称呼你(可随时改)。</span>
          </label>

          <label className="field">
            <span className="lab"><KeyRound size={13} /> 激活码</span>
            <input
              className="inp mono"
              value={code}
              onChange={(e) => { setCode(e.target.value.toUpperCase()); if (err) setErr(null) }}
              placeholder="JUAN-XXXX-XXXX-XXXX"
              spellCheck={false}
            />
            <span className="hint">
              {activationRequired
                ? `没有激活码?关注公众号「${WECHAT_NAME}」回复「${WECHAT_KEYWORD}」领取。`
                : "免激活码 = 普通会员直接进站,轻档写作;填 Pro / Ultra 码解锁更强编辑部。"}
            </span>
          </label>

          <label className="field">
            <span className="lab"><Mail size={13} /> 邮箱(选填)</span>
            <input
              className="inp"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              spellCheck={false}
              autoComplete="email"
            />
            <span className="hint">绑邮箱可在换设备时找回、接收产品更新;不填也能进。</span>
          </label>

          {!code.trim() && (
            <div className="code-claim">
              <span className="cc-title">{activationRequired ? "还没有激活码?" : "免码即可开写 · 关注公众号领 Pro 体验码"}</span>
              {!qrError ? (
                // eslint-disable-next-line @next/next/no-img-element -- 公众号横条是用户自备静态素材,无需 next/image 优化
                <img
                  ref={qrRef}
                  className="cc-banner"
                  src={WECHAT_QR}
                  alt={`关注公众号「${WECHAT_NAME}」领取激活码`}
                  onError={() => setQrError(true)}
                />
              ) : (
                <div className="cc-banner-fallback" title="公众号二维码待配置">
                  公众号二维码待配置
                  <span>稍后在产品设置里配置</span>
                </div>
              )}
              <p className="cc-hint">
                微信扫码 / 搜一搜关注 <b>「{WECHAT_NAME}」</b>
                {activationRequired ? <>,回复 <b>「{WECHAT_KEYWORD}」</b> 即可领取激活码。</> : <> —— 新功能、更新和玩法都先在这发。</>}
              </p>
            </div>
          )}

          {err && (
            <p className="login-err" role="alert">
              <AlertCircle size={14} /> {err}
            </p>
          )}

          <button type="submit" className="enter" disabled={busy}>
            {busy ? "正在进门…" : <>进入卷舍 <ArrowRight size={16} /></>}
          </button>

          <p className="foot-note">密钥与激活信息仅存于本地,绝不上传 · BYOK 自带模型</p>
        </form>
      </main>
    </div>
  )
}
