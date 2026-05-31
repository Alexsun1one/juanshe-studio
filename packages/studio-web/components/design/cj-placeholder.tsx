import Link from "next/link"

/**
 * 空工作区占位 — 路由/外壳已就位,但本地工作区还没有作品(或该域暂无数据)。
 * 用一张温和的像素编辑部静物 + 引导动作,而不是报错式提示。
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

/** 像素静物占位:稿纸 + 台灯 + 绿植。随主题自适应。 */
export function EmptyArt() {
  return (
    <div className="empty-pixel-scene" aria-hidden="true">
      <img className="eps-manuscript" src="/brand/props/manuscript-stack.webp" alt="" width={96} height={96} draggable={false} />
      <img className="eps-lamp" src="/brand/props/desk-lamp.webp" alt="" width={82} height={82} draggable={false} />
      <img className="eps-plant" src="/brand/props/potted-plant.webp" alt="" width={78} height={78} draggable={false} />
      <img className="eps-cat" src="/brand/props/sleeping-cat.webp" alt="" width={76} height={76} draggable={false} />
      <span className="eps-glow" />
    </div>
  )
}
