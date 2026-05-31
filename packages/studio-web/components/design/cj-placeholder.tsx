import Link from "next/link"

/**
 * 空工作区占位 — 路由/外壳已就位,但本地工作区还没有作品(或该域暂无数据)。
 * 用一张温和的代码绘制占位插画 + 引导动作,而不是报错式提示。
 */
export function CjPlaceholder({
  title,
  sub,
}: {
  title: string
  sub?: string
  /** 兼容旧调用,不再渲染「对接中」字样 */
  source?: string
}) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{title}</h1>
        </div>
      </div>
      <div className="empty empty-lg">
        <div className="empty-art">
          <EmptyArt />
        </div>
        <div className="empty-title">从这里开始第一部作品</div>
        <div className="empty-desc">
          {sub ?? "本地工作区还没有作品,创建后这里就会有内容。"}
        </div>
        <div className="empty-actions">
          <Link href="/books" className="btn primary">
            去创建第一部作品
          </Link>
          <Link href="/" className="btn">
            返回工作台
          </Link>
        </div>
      </div>
    </div>
  )
}

/** 代码绘制的占位插画:一张待写的稿纸 + 品牌色灵感火花。随主题自适应。 */
export function EmptyArt() {
  return (
    <svg viewBox="0 0 140 108" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <ellipse cx="70" cy="96" rx="46" ry="6" fill="currentColor" opacity="0.07" />
      <rect
        x="48" y="18" width="52" height="68" rx="8"
        fill="var(--bg-sunken)" stroke="currentColor" strokeOpacity="0.16" strokeWidth="1.4"
      />
      <rect
        x="40" y="24" width="60" height="64" rx="9"
        fill="var(--bg-card)" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.6"
      />
      <rect x="51" y="40" width="30" height="5" rx="2.5" fill="currentColor" opacity="0.22" />
      <rect x="51" y="52" width="38" height="5" rx="2.5" fill="currentColor" opacity="0.15" />
      <rect x="51" y="64" width="24" height="5" rx="2.5" fill="currentColor" opacity="0.15" />
      <g transform="translate(86 14) scale(0.7)" fill="var(--brand-500)">
        <path d="M12 2.5l1.7 5.2c.2.6.6 1 1.2 1.2l5.2 1.7-5.2 1.7c-.6.2-1 .6-1.2 1.2L12 18.7l-1.7-5.2c-.2-.6-.6-1-1.2-1.2L3.9 10.6l5.2-1.7c.6-.2 1-.6 1.2-1.2z" />
      </g>
    </svg>
  )
}
