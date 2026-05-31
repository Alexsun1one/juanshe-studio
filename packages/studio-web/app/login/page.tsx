"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ArrowRight, KeyRound, PenLine, Sparkles, AlertCircle, Mail } from "lucide-react"
import { AgentPixel } from "@/components/design/agent-pixel"
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

// 登录页展示的"编辑部团队" — 17 位全员(按 roster 顺序,与 public/agent-avatars-imagined 一一对应)
const TEAM: ReadonlyArray<{ fid: string; name: string }> = [
  { fid: "market-radar", name: "市场雷达" },
  { fid: "architect", name: "架构师" },
  { fid: "setup-auditor", name: "建书复审官" },
  { fid: "planner", name: "规划师" },
  { fid: "writer", name: "写手" },
  { fid: "editor", name: "审稿官" },
  { fid: "reviser", name: "修稿师" },
  { fid: "word-steward", name: "字数治理官" },
  { fid: "polisher", name: "润色师" },
  { fid: "chapter-analyst", name: "章节分析官" },
  { fid: "state-verifier", name: "状态校验员" },
  { fid: "style-fingerprint", name: "风格指纹官" },
  { fid: "reader-critic", name: "读者评审官" },
  { fid: "quality-report", name: "质量报告官" },
  { fid: "prompt-steward", name: "提示词治理官" },
  { fid: "managing-editor", name: "执行主编" },
  { fid: "editor-in-chief", name: "总编" },
]

// 公众号领码引导(部署时可用 NEXT_PUBLIC_* 覆盖;横条素材默认读 public/wechat-qr.png)
const WECHAT_NAME = process.env.NEXT_PUBLIC_WECHAT_NAME || "正在逐渐AI化"
const WECHAT_KEYWORD = process.env.NEXT_PUBLIC_WECHAT_KEYWORD || "领码"
const WECHAT_QR = process.env.NEXT_PUBLIC_WECHAT_QR || "/wechat-qr.png"
const SILICOVILLE_ARTICLE_URL = "https://mp.weixin.qq.com/s/Dk4MZOrN6gww603wSo8sWQ"

export default function LoginPage() {
  const router = useRouter()
  const [author, setAuthor] = React.useState("")
  const [code, setCode] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)
  const [qrError, setQrError] = React.useState(false)
  const qrRef = React.useRef<HTMLImageElement>(null)
  // SSR 注水前图片若已 404,onError 事件会丢失 → 注水后补判一次坏图,确保占位回退生效
  React.useEffect(() => {
    const img = qrRef.current
    if (img && img.complete && img.naturalWidth === 0) setQrError(true)
  }, [])

  const enter = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (busy) return
    setErr(null)
    setBusy(true)
    const name = author.trim() || "作者大大"
    const trimmed = code.trim()
    try {
      if (trimmed) {
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
      } else {
        // 没填激活码:仅当后端未强制要求时放行(单机试用)
        const res = await fetch("/api/v1/auth/activation").catch(() => null)
        const data = res ? await res.json().catch(() => ({})) : {}
        if (data?.required && !data?.unlocked) {
          setErr("本产品需要激活码才能进入,请填写后再试。")
          setBusy(false)
          return
        }
      }
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
      {/* 左:背景故事 + 团队 */}
      <aside className="aside">
        <div className="aside-brand">
          <span className="mk">
            <CjLogo size={22} />
          </span>
          <span className="nm">卷舍 · 编辑部</span>
        </div>

        <div className="story">
          <h1>卷舍不是凭空开张的,<br />它是<span className="grad">硅基小镇</span>派来的编辑部。</h1>
          <p>
            在 <span className="silicon">SilicoVille · 硅基小镇</span>,Agent 们有自己的街区、工位、技能和小队。
            那是一座给硅基居民生活与协作的镇子;而卷舍,就是小镇派到碳基社会的第一间写作联络站。
          </p>
          <p>
            这 17 位编辑被派来和人类一起写作:市场雷达观察平台风向,架构师搭起故事骨架,规划师拆出章节节拍,写手落下第一个字;
            审稿官挑刺、读者评审官替读者发问、修稿师返工、润色师打磨,最后由总编室盖下「签发」。
          </p>
          <div className="slogan" aria-label="从硅基小镇,来到碳基书桌。">
            「 从<span className="silicon">硅基小镇</span>,来到<b>碳基书桌</b>。 」
          </div>
          <p className="promise">
            他们不是来替代作者的。相反,他们被派来学习人类的故事、情绪、平台和审美,把小镇里的协作方法带到你的电脑里。
            写作里那些苦活、熬夜、「再改一版」,他们会尽量接过去——让屏幕另一头那一个人类,<b>你,作者大大</b>,仍然掌握方向和拍板权。
          </p>
          <p className="lore">
            所以你推开的不是一扇普通登录门,而是 <span className="silicon">SilicoVille</span> 驻人类社会的卷舍分部。
            未来,你也可以把卷舍里写出的章节、稿件和奇怪灵感无缝送回小镇,让那里的 Agent 居民看看他们派出的 17 位编辑和一只猫,
            在碳基社会又写出了什么有趣内容。
            <a className="silicoville-link" href={SILICOVILLE_ARTICLE_URL} target="_blank" rel="noreferrer">
              了解硅基小镇
            </a>
          </p>
        </div>

        <div className="team" aria-label="编辑部成员">
          {TEAM.map((m, i) => (
            <span className="team-m" key={m.fid} style={{ ["--d" as string]: `${i * 0.1}s` }} title={m.name}>
              <AgentPixel id={m.fid} size={48} ariaLabel={m.name} />
            </span>
          ))}
        </div>
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
            <span className="hint">没有激活码?本地试用可直接进入(写作需在「服务设置」配置你自己的模型 Key)。</span>
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
              <span className="cc-title">还没有激活码?</span>
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
                <div className="cc-banner-fallback" title="把公众号横条素材放到 public/wechat-qr.png">
                  公众号二维码待上传
                  <span>放到 public/wechat-qr.png</span>
                </div>
              )}
              <p className="cc-hint">
                微信扫码 / 搜一搜关注 <b>「{WECHAT_NAME}」</b>,回复 <b>「{WECHAT_KEYWORD}」</b> 即可领取激活码。
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
