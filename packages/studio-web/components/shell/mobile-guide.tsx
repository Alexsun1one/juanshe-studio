"use client"

import * as React from "react"
import "./mobile-guide.css"

// 公众号信息(与 login 同源,部署可用 NEXT_PUBLIC_* 覆盖)
const WECHAT_NAME = process.env.NEXT_PUBLIC_WECHAT_NAME || "正在逐渐AI化"
const WECHAT_QR = process.env.NEXT_PUBLIC_WECHAT_QR_SQUARE || "/wechat-qr-square.png"

/**
 * 移动端引导页 —— 卷舍是开在电脑里的多窗口写作台,手机屏施展不开。
 * 纯 CSS 媒体查询控制:桌面 display:none(零成本、不影响桌面),仅 ≤768px 全屏显示。
 * 不"修"手机版工作台,而是礼貌地把手机用户引导去电脑打开,并保留公众号入口(手机也能关注领码)。
 * 全局挂在 RootLayout body,覆盖登录页与工作台所有路由。
 */
export function MobileGuide() {
  const [host, setHost] = React.useState("")
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    try {
      setHost(window.location.host)
    } catch {
      /* SSR / 受限环境忽略 */
    }
  }, [])

  const copyUrl = React.useCallback(() => {
    const url = host ? `https://${host}` : ""
    if (!url) return
    try {
      void navigator.clipboard?.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }, [host])

  return (
    <div className="mobile-guide" role="dialog" aria-label="请用电脑打开卷舍">
      <div className="mg-card">
        <div className="mg-brand">
          <span className="mg-mk">卷</span>
          <span className="mg-nm">卷舍 · AI 编辑部</span>
        </div>

        <div className="mg-art">
          {/* eslint-disable-next-line @next/next/no-img-element -- 静态品牌图,无需 next/image */}
          <img src="/brand/office-hero-small.webp" alt="卷舍编辑部" width={320} height={180} draggable={false} />
        </div>

        <h1 className="mg-title">卷舍是开在<br />电脑里的编辑部</h1>
        <p className="mg-desc">
          十七位编辑、六个部门、一整条从选题到签发的写作流水线 —— 手机屏太小,编辑部施展不开。
          请用<b>电脑浏览器</b>打开,体验完整写作台。
        </p>

        <div className="mg-url">
          <span className="mg-url-text">{host || "write.nextapi.top"}</span>
          <button type="button" className="mg-copy" onClick={copyUrl}>
            {copied ? "已复制 ✓" : "复制网址"}
          </button>
        </div>

        <div className="mg-wechat">
          {/* eslint-disable-next-line @next/next/no-img-element -- 公众号码是用户自备静态素材 */}
          <img className="mg-qr" src={WECHAT_QR} alt={`关注公众号「${WECHAT_NAME}」`} width={76} height={76} draggable={false} />
          <div className="mg-wechat-text">
            <b>关注公众号「{WECHAT_NAME}」</b>
            <span>领 Pro 体验码 · 新功能与玩法都在这发</span>
          </div>
        </div>
      </div>
    </div>
  )
}
