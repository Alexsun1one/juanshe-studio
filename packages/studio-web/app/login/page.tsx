"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ArrowRight, KeyRound, PenLine, Sparkles, AlertCircle, Mail, Lock, CheckCircle2 } from "lucide-react"
import { CjLogo } from "@/components/design/cj-logo"
import { setAuthorName } from "@/lib/use-author-name"
import { setTierCache } from "@/lib/use-tier"
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

// 后端错误 message 是英文技术语时按状态码翻人话;已是中文的原文放行。fallback 各场景自带。
function authErrorMessage(res: Response, data: unknown, fallback: string): string {
  const err = (data as { error?: { message?: string } } | null)?.error
  const msg = typeof err?.message === "string" ? err.message : ""
  if (/[\u4e00-\u9fff]/.test(msg)) return msg
  if (res.status === 401 || res.status === 403) return fallback
  if (res.status === 409) return "这个激活码已绑定其他设备或账号,如需换绑请联系支持。"
  if (res.status === 429) return "尝试太频繁了,稍等一会再试。"
  if (res.status >= 500) return "服务暂时不可用,请稍后重试。"
  return msg || fallback
}

type SaasUser = {
  id?: string
  email?: string
  role?: string
  tenantId?: string
  credits?: number
}

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
  // 托管多租户(SaaS):邮箱+密码注册/登录。null=未判定(避免闪桌面表单),false=桌面单机,true=SaaS。
  const [saas, setSaas] = React.useState<boolean | null>(null)
  React.useEffect(() => {
    let cancelled = false
    // 优先用 /auth/me 判定模式(saas:true/false);其返回还带当前会话用户(已登录可直接进站)。
    fetch("/api/v1/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((s) => {
        if (cancelled) return
        const isSaas = Boolean(s?.saas)
        setSaas(isSaas)
        if (isSaas && s?.user) setSaasUser(s.user as SaasUser)
      })
      .catch(() => {
        if (!cancelled) setSaas(false) // 判定失败按桌面处理,保持可自助进入
      })
    // 桌面模式才关心激活是否强制(SaaS 用账号会话,不读这条)
    fetch("/api/v1/auth/activation", { cache: "no-store" })
      .then((r) => r.json())
      .then((s) => { if (!cancelled) setActivationRequired(Boolean(s?.required)) })
      .catch(() => { /* 后端不可达时按"不强制"处理,保持可自助进入 */ })
    return () => { cancelled = true }
  }, [])
  const [storyText, setStoryText] = React.useState("")
  const qrRef = React.useRef<HTMLImageElement>(null)
  const storyScrollRef = React.useRef<HTMLDivElement>(null)

  // ── SaaS 表单状态 ─────────────────────────────────────────────
  const [saasMode, setSaasMode] = React.useState<"login" | "register">("login")
  const [password, setPassword] = React.useState("")
  const [saasUser, setSaasUser] = React.useState<SaasUser | null>(null)
  const [upgradeCode, setUpgradeCode] = React.useState("")
  const [upgradeBusy, setUpgradeBusy] = React.useState(false)
  const [upgradeErr, setUpgradeErr] = React.useState<string | null>(null)
  const [upgradeTier, setUpgradeTier] = React.useState<string | null>(null)
  const [upgradeCredits, setUpgradeCredits] = React.useState<number | null>(null)

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

  // 进站后路由:首次 → 编辑部入职过场(/welcome),复访 → 直接进站(/)
  const goAfterAuth = React.useCallback(() => {
    let onboarded = false
    try { onboarded = localStorage.getItem("cj.onboarded") === "1" } catch { /* ignore */ }
    router.push(onboarded ? "/" : "/welcome")
  }, [router])

  // ── 桌面单机:作者名 + 激活码(免码可进) ───────────────────────
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
          goAfterAuth()
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
        setErr(authErrorMessage(res, data, "激活码无效,请检查后重试。"))
        setBusy(false)
        return
      }
      // 记下等级(Normal/Pro/Ultra)与邮箱,供全站显示/按等级解锁
      try {
        const tier = data?.activation?.tier
        if (tier) setTierCache(String(tier))
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
      goAfterAuth()
    } catch {
      setErr("无法连接卷舍后端,请确认服务已启动后重试。")
      setBusy(false)
    }
  }

  // ── SaaS:邮箱+密码 注册/登录 ────────────────────────────────
  const submitSaas = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (busy) return
    setErr(null)
    const mail = email.trim()
    const pwd = password
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      setErr("请输入有效邮箱。")
      return
    }
    if (pwd.length < 8) {
      setErr("密码至少 8 位。")
      return
    }
    setBusy(true)
    try {
      const path = saasMode === "register" ? "/api/v1/auth/register" : "/api/v1/auth/login"
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: mail, password: pwd }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.error) {
        setErr(authErrorMessage(res, data, saasMode === "register" ? "注册失败,请稍后重试。" : "邮箱或密码错误。"))
        setBusy(false)
        return
      }
      // 登录态由后端 Set-Cookie 会话承载;本地只存可读身份草稿(作者称谓沿用邮箱前缀)
      const user = (data?.user ?? null) as SaasUser | null
      try {
        if (mail) localStorage.setItem("cj.email", mail)
        const display = author.trim() || mail.split("@")[0] || "作者大大"
        setAuthorName(display)
      } catch { /* ignore */ }
      setSaasUser(user)
      setBusy(false)
      // 进站前先在此页给一个"升级激活码"入口(不强制),用户可直接进站或先升级
    } catch {
      setErr("无法连接卷舍后端,请确认服务已启动后重试。")
      setBusy(false)
    }
  }

  // ── SaaS:登录后用 Pro/Ultra 激活码升级当前账号 ───────────────
  const submitUpgrade = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (upgradeBusy) return
    setUpgradeErr(null)
    const trimmed = upgradeCode.trim()
    if (!trimmed) {
      setUpgradeErr("请输入 Pro / Ultra 激活码。")
      return
    }
    setUpgradeBusy(true)
    try {
      const res = await fetch("/api/v1/auth/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: trimmed, email: email.trim(), deviceId: getDeviceId() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.error) {
        setUpgradeErr(authErrorMessage(res, data, "激活码无效,请检查后重试。"))
        setUpgradeBusy(false)
        return
      }
      const tier = data?.activation?.tier ?? null
      if (tier) {
        setUpgradeTier(String(tier))
        setTierCache(String(tier))
      }
      // P0-2:SaaS 模式下激活会给当前账号挂 tier + 按 tier 赠 credits。
      // 重新拉一次 /auth/me 取到账后的最新额度展示给用户。
      try {
        const me = await fetch("/api/v1/auth/me", { cache: "no-store" }).then((r) => r.json())
        const credits = me?.user?.credits
        if (typeof credits === "number") {
          setUpgradeCredits(credits)
          setSaasUser((prev) => (prev ? { ...prev, credits } : prev))
        }
      } catch { /* 额度展示是锦上添花,失败不阻断 */ }
      setUpgradeBusy(false)
    } catch {
      setUpgradeErr("无法连接卷舍后端,请稍后重试。")
      setUpgradeBusy(false)
    }
  }

  const renderDesktopCard = () => (
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
  )

  const renderSaasAuthCard = () => (
    <form className="card" onSubmit={submitSaas}>
      <div className="card-emblem"><Sparkles size={18} /></div>
      <h2>{saasMode === "register" ? "加入卷舍编辑部" : "回到卷舍编辑部"}</h2>
      <p className="card-sub">
        {saasMode === "register"
          ? <>用邮箱开一个属于你的<span className="juan">卷</span>舍工位 —— 你的书、记忆和密钥都只在你的租户里。</>
          : <>编辑部一直亮着灯。用邮箱<span className="juan">回</span>到你的工位继续写。</>}
      </p>

      <div className="saas-tabs" role="tablist" aria-label="注册或登录">
        <button
          type="button"
          role="tab"
          aria-selected={saasMode === "login"}
          className={`saas-tab${saasMode === "login" ? " on" : ""}`}
          onClick={() => { setSaasMode("login"); setErr(null) }}
        >
          登录
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={saasMode === "register"}
          className={`saas-tab${saasMode === "register" ? " on" : ""}`}
          onClick={() => { setSaasMode("register"); setErr(null) }}
        >
          注册
        </button>
      </div>

      <label className="field">
        <span className="lab"><Mail size={13} /> 邮箱</span>
        <input
          className="inp"
          type="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); if (err) setErr(null) }}
          placeholder="you@example.com"
          spellCheck={false}
          autoComplete="email"
          autoFocus
        />
      </label>

      <label className="field">
        <span className="lab"><Lock size={13} /> 密码</span>
        <input
          className="inp"
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); if (err) setErr(null) }}
          placeholder="至少 8 位"
          spellCheck={false}
          autoComplete={saasMode === "register" ? "new-password" : "current-password"}
        />
        <span className="hint">
          {saasMode === "register"
            ? "密码只用来守住你的工位,卷舍不会明文存储。"
            : "忘了也别慌 —— 编辑部会帮你找回(后续在设置里)。"}
        </span>
      </label>

      {err && (
        <p className="login-err" role="alert">
          <AlertCircle size={14} /> {err}
        </p>
      )}

      <button type="submit" className="enter" disabled={busy}>
        {busy
          ? (saasMode === "register" ? "正在开工位…" : "正在进门…")
          : <>{saasMode === "register" ? "注册并进入卷舍" : "进入卷舍"} <ArrowRight size={16} /></>}
      </button>

      <p className="foot-note">
        {saasMode === "register"
          ? <>已经有工位了?<span className="saas-swap" role="button" tabIndex={0} onClick={() => { setSaasMode("login"); setErr(null) }} onKeyDown={(e) => { if (e.key === "Enter") { setSaasMode("login"); setErr(null) } }}>去登录</span></>
          : <>第一次来?<span className="saas-swap" role="button" tabIndex={0} onClick={() => { setSaasMode("register"); setErr(null) }} onKeyDown={(e) => { if (e.key === "Enter") { setSaasMode("register"); setErr(null) } }}>开一个工位</span></>}
      </p>
    </form>
  )

  const renderSaasUpgradeCard = () => (
    <div className="card">
      <div className="card-emblem ok"><CheckCircle2 size={18} /></div>
      <h2>工位已就绪</h2>
      <p className="card-sub">
        欢迎,<b>{email.trim() || saasUser?.email || "作者大大"}</b>。编辑部已经为你点亮工位,随时可以进站开写。
      </p>

      <div className="saas-upgrade">
        <span className="su-title"><KeyRound size={13} /> 有 Pro / Ultra 激活码?现在升级</span>
        <p className="su-hint">把激活码挂到这个账号,解锁更强的编辑部并按等级到账 credits。</p>
        <div className="su-row">
          <input
            className="inp mono"
            value={upgradeCode}
            onChange={(e) => { setUpgradeCode(e.target.value.toUpperCase()); if (upgradeErr) setUpgradeErr(null) }}
            placeholder="JUAN-XXXX-XXXX-XXXX"
            spellCheck={false}
          />
          <button type="button" className="su-apply" onClick={submitUpgrade} disabled={upgradeBusy}>
            {upgradeBusy ? "升级中…" : "升级"}
          </button>
        </div>
        {upgradeErr && (
          <p className="login-err" role="alert">
            <AlertCircle size={14} /> {upgradeErr}
          </p>
        )}
        {upgradeTier && (
          <p className="su-ok" role="status">
            <CheckCircle2 size={14} /> 已升级到 <b>{upgradeTier}</b>
            {typeof upgradeCredits === "number" ? <> · 到账 <b>{upgradeCredits}</b> credits</> : null}
          </p>
        )}
      </div>

      <button type="button" className="enter" onClick={goAfterAuth}>
        进入卷舍 <ArrowRight size={16} />
      </button>

      <p className="foot-note">你的书、记忆与密钥都隔离在你的租户里 · BYOK 自带模型</p>
    </div>
  )

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

      {/* 右:进入卷舍 —— SaaS 走邮箱密码,桌面走作者名+激活码 */}
      <main className="panel">
        {saas === null
          ? null
          : saas
            ? (saasUser ? renderSaasUpgradeCard() : renderSaasAuthCard())
            : renderDesktopCard()}
      </main>
    </div>
  )
}
