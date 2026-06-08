"use client"

/** 公众号信息(部署时可用 NEXT_PUBLIC_* 覆盖;默认读 public/wechat-qr-square.png 方形码)。 */
const WECHAT_NAME = process.env.NEXT_PUBLIC_WECHAT_NAME || "正在逐渐AI化"
const WECHAT_QR = process.env.NEXT_PUBLIC_WECHAT_QR_SQUARE || "/wechat-qr-square.png"

/**
 * 侧栏底部「关注公众号」块(在「设置」上方)。
 * 像素字引导关注「正在逐渐AI化」—— 新功能 / 更新先在这发,把用户导流到公众号。
 * 侧栏收起(mini)时自动隐藏。
 */
export function WechatFollow({ collapsed }: { collapsed?: boolean }) {
  if (collapsed) return null
  return (
    <div className="sidebar-wechat" aria-label={`关注公众号「${WECHAT_NAME}」`}>
      <span className="sidebar-wechat__hook">新功能 · 抢先玩</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="sidebar-wechat__qr"
        src={WECHAT_QR}
        alt={`公众号「${WECHAT_NAME}」二维码`}
        width={132}
        height={132}
        loading="lazy"
        draggable={false}
      />
      <span className="sidebar-wechat__cap">
        微信扫码 · 关注<b>「{WECHAT_NAME}」</b>
      </span>
    </div>
  )
}
