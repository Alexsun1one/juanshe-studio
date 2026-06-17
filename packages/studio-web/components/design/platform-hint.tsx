import Link from "next/link"

import { PixelBadge, type PixelBadgeKind } from "@/components/design/pixel-badge"

import "./platform-hint.css"

/**
 * PlatformHint —— 「这条能力桌面版更顺手」的暖纸软提示条。
 *
 * 语气铁律:诚实、平视、不卑微。先肯定网页版「零门槛、随开随写」,再把差异说成
 * 「桌面版多给你一把钥匙」,绝不写成「网页版残缺 / 升级解锁」这种贬低自家或付费墙话术。
 * 这是交付形态差异(网页 vs 桌面),不是收费项。
 *
 * 视觉守暖纸柔紫 + 像素 12px UI 字体:暖纸底(由 --bg-card 派生一点暖橙,亮暗都成立)、
 * 暖橙细描边、柔紫次级链接。绝不用冷蓝 / 近黑 / 告警红。
 *
 * 文案集中在本组件 CONTENT 表里 —— 全站一处发声,语气统一、好调。落点页面只传 type。
 */
export type PlatformHintType =
  | "local-llm" // 模型配置页:本机 Ollama 连不上
  | "per-agent-model" // 模型配置页:配完 Key 后去给每个编辑派模型
  | "theatre-guide" // 工作台:首次进入写作剧场态
  | "auto-publish" // 发布页:一键发草稿是桌面的
  | "channel-auth" // 渠道连接弹窗:同上的简版
  | "browser-download" // 平台导出页:浏览器下载落点
  | "import-method" // 导入页:导入方式(别误承诺桌面选文件)
  | "batch-limits" // 批量写作:2 小时墙 / 单批 20 章

type HintContent = {
  badge: PixelBadgeKind
  /** 眉标小词:点出这是「端差异」而非缺陷 */
  eyebrow: string
  /** 一句话主文案 */
  body: React.ReactNode
  /** 可选「了解两版区别」次级链接 */
  moreHref?: string
}

const CONTENT: Record<PlatformHintType, HintContent> = {
  "local-llm": {
    badge: "llm",
    eyebrow: "本机模型 · 桌面版",
    body: (
      <>
        网页版的模型都跑在云端——你电脑里的 <b>Ollama（localhost）</b> 这儿连不上,因为网页住在服务器、和你的电脑不在同一张网。想用本地模型、离线推理、自己掌控这份算力,<b>桌面版</b>就通了。
      </>
    ),
    moreHref: "/guide#desktop-vs-web",
  },
  "per-agent-model": {
    badge: "agents",
    eyebrow: "编辑部分工 · 模型派工",
    body: (
      <>
        配好 Key 后,可以给每个编辑分配不同的写作模型——写手用强模型、润色用便宜快模型,省钱又稳。{" "}
        <Link href="/agents" className="ph-inline-link">去给每个角色派模型 →</Link>
      </>
    ),
  },
  "theatre-guide": {
    badge: "runs",
    eyebrow: "写作剧场",
    body: (
      <>
        右侧是当前 / 下一棒编辑,中间正文逐字流出;想回读就上翻已写段落,点「回到最新」再贴回底部。
      </>
    ),
  },
  "auto-publish": {
    badge: "publish",
    eyebrow: "一键发草稿 · 桌面版",
    body: (
      <>
        网页版这里只做一件实在事:把成稿按各平台排好、一键复制,你再去平台粘贴——我们不代持你的平台密钥。想省掉手动粘贴这步、让它自动登录后台填好正文、存进草稿箱,<b>桌面版的「一键发草稿」</b>替你跑(番茄已通,其余陆续对齐)。
      </>
    ),
    moreHref: "/guide#desktop-vs-web",
  },
  "channel-auth": {
    badge: "platform",
    eyebrow: "自动发草稿 · 桌面版",
    body: (
      <>
        真正的「自动发草稿」——自动登录后台、填正文、存进草稿箱——在<b>桌面版</b>跑(番茄已通,其余陆续对齐)。网页版这里只记你的连接状态,发布动作仍是复制粘贴。
      </>
    ),
  },
  "browser-download": {
    badge: "platform",
    eyebrow: "落点 · 浏览器下载",
    body: (
      <>
        网页版导出走浏览器下载,落在你的「下载」文件夹。想让稿子直接落进本机工作区、同步到你的云盘目录、随时离线打开,那是<b>桌面版</b>的主场——稿子就在你自己的硬盘上。
      </>
    ),
  },
  "import-method": {
    badge: "import",
    eyebrow: "导入方式",
    body: (
      <>
        这里支持<b>粘贴正文</b>和<b>抓取 URL</b>,把外部素材喂进编辑部接着写。(「选本机文件打开」两版目前都还没做;桌面版的好处是工作区本来就在你自己的硬盘上。)
      </>
    ),
  },
  "batch-limits": {
    badge: "runs",
    eyebrow: "挂机长跑 · 桌面版",
    body: (
      <>
        网页版挂机连写有个 <b>2 小时</b>的温柔上限、单批最多 <b>20 章</b>——到点会自动歇一下、保住进度,点「继续」就接着写,免得占满大家共享的服务器。要真正无人值守、整夜自动续写、关掉窗口也照跑,那是<b>桌面版</b>的主场。
      </>
    ),
    moreHref: "/guide#desktop-vs-web",
  },
}

export function PlatformHint({
  type,
  variant = "info",
  className,
}: {
  type: PlatformHintType
  /** info:带像素徽标 + 次级链接的完整条;quiet:更收敛、不喧宾夺主(设置/导出页用) */
  variant?: "info" | "quiet"
  className?: string
}) {
  const c = CONTENT[type]
  return (
    <aside className={`platform-hint ph-${variant}${className ? ` ${className}` : ""}`} role="note">
      {variant === "info" ? (
        <PixelBadge kind={c.badge} size={26} className="ph-badge" ariaLabel="桌面版能力提示" />
      ) : (
        <span className="ph-dot" aria-hidden />
      )}
      <div className="ph-text">
        {variant === "info" && <span className="ph-eyebrow">{c.eyebrow}</span>}
        <p className="ph-body">{c.body}</p>
      </div>
      {c.moreHref && variant === "info" && (
        <Link href={c.moreHref} className="ph-more">
          了解两版区别 →
        </Link>
      )}
    </aside>
  )
}
