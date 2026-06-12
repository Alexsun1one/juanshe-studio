import Link from "next/link"
import type { ReactNode } from "react"

type EmptyArtVariant =
  | "default"
  | "books"
  | "library"
  | "materials"
  | "publish"
  | "insights"
  | "knowledge"
  | "graph"
  | "editor"
  | "outline"
  | "characters"
  | "wiki"
  | "memory"
  | "agents"

type EmptyScene = {
  title: string
  variant: EmptyArtVariant
  props: readonly [
    { src: string; className: string; width: number; height: number },
    { src: string; className: string; width: number; height: number },
    { src: string; className: string; width: number; height: number },
    { src: string; className: string; width: number; height: number },
  ]
}

const SCENES: Record<EmptyArtVariant, EmptyScene> = {
  default: scene("从这里开始第一部作品", "default", [
    prop("manuscript-stack", "eps-main", 96, 96),
    prop("desk-lamp", "eps-tall", 82, 82),
    prop("potted-plant", "eps-left", 78, 78),
    prop("sleeping-cat", "eps-cat", 76, 76),
  ]),
  books: scene("书架还在等第一本长卷", "books", [
    prop("book-registry-desk", "eps-main", 180, 160),
    prop("stamp-seal", "eps-left", 66, 66),
    prop("flower-branch", "eps-tall", 72, 72),
    prop("coffee-mug", "eps-cat", 66, 66),
  ]),
  library: scene("成品架还在等第一份稿件", "library", [
    prop("asset-library-desk", "eps-main", 180, 160),
    prop("publishing-envelope", "eps-left", 72, 72),
    prop("flower-branch", "eps-tall", 72, 72),
    prop("sleeping-cat", "eps-cat", 76, 76),
  ]),
  materials: scene("素材箱还没拆封", "materials", [
    prop("import-crate", "eps-main", 96, 96),
    prop("manuscript-stack", "eps-left", 86, 86),
    prop("potted-plant", "eps-tall", 76, 76),
    prop("flower-branch", "eps-cat", 76, 76),
  ]),
  publish: scene("发布台还在等第一枚邮戳", "publish", [
    prop("publish-dock", "eps-main", 128, 96),
    prop("stamp-seal", "eps-left", 66, 66),
    prop("desk-lamp", "eps-tall", 82, 82),
    prop("sleeping-cat", "eps-cat", 76, 76),
  ]),
  insights: scene("观察窗还在等第一条信号", "insights", [
    prop("radar-desk", "eps-main", 96, 96),
    prop("story-board", "eps-tall", 86, 86),
    prop("coffee-mug", "eps-left", 66, 66),
    prop("flower-branch", "eps-cat", 74, 74),
  ]),
  knowledge: scene("知识柜还在等第一批设定", "knowledge", [
    prop("story-map-desk", "eps-main", 184, 144),
    prop("manuscript-stack", "eps-left", 78, 78),
    prop("desk-lamp", "eps-tall", 74, 74),
    prop("studio-cat", "eps-cat", 76, 76),
  ]),
  graph: scene("关系图还在等人物登场", "graph", [
    prop("story-map-desk", "eps-main", 184, 144),
    prop("coffee-mug", "eps-left", 66, 66),
    prop("desk-lamp", "eps-tall", 74, 74),
    prop("editor-bot", "eps-cat", 74, 74),
  ]),
  editor: scene("稿纸已经铺好", "editor", [
    prop("editor-desk", "eps-main", 132, 92),
    prop("desk-lamp", "eps-tall", 76, 76),
    prop("ink-quill", "eps-left", 64, 64),
    prop("sleeping-cat", "eps-cat", 76, 76),
  ]),
  outline: scene("题板还在等第一条主线", "outline", [
    prop("outline-planning-desk", "eps-main", 184, 144),
    prop("manuscript-stack", "eps-left", 76, 76),
    prop("flower-branch", "eps-tall", 72, 72),
    prop("coffee-mug", "eps-cat", 66, 66),
  ]),
  characters: scene("角色席位还在等人入场", "characters", [
    prop("character-casting-desk", "eps-main", 184, 144),
    prop("flower-bouquet", "eps-left", 78, 78),
    prop("desk-lamp", "eps-tall", 72, 72),
    prop("coffee-mug", "eps-cat", 66, 66),
  ]),
  wiki: scene("Wiki 书页还没翻开", "wiki", [
    prop("book-registry-desk", "eps-main", 178, 156),
    prop("logo-book-quill", "eps-left", 72, 72),
    prop("ink-quill", "eps-tall", 72, 72),
    prop("coffee-mug", "eps-cat", 66, 66),
  ]),
  memory: scene("记忆长卷还没铺开", "memory", [
    prop("memory-scroll-desk", "eps-main", 184, 144),
    prop("seal-desk", "eps-left", 76, 76),
    prop("desk-lamp", "eps-tall", 76, 76),
    prop("flower-branch", "eps-cat", 74, 74),
  ]),
  agents: scene("编辑部成员档案暂时没拿到", "agents", [
    prop("chief-editor", "eps-main", 88, 88),
    prop("editor-bot", "eps-cat", 76, 76),
    prop("settings-gear", "eps-left", 76, 76),
    prop("story-board", "eps-tall", 86, 86),
  ]),
}

const TITLE_VARIANT: Record<string, EmptyArtVariant> = {
  "作品管理": "books",
  "内容库": "library",
  "素材库": "materials",
  "发布管理": "publish",
  "洞察中心": "insights",
  "知识与资产": "knowledge",
  "故事图谱": "graph",
  "章节编辑": "editor",
  "大纲与规划": "outline",
  "角色与设定": "characters",
  "LLM Wiki": "wiki",
  "记忆长卷": "memory",
}

function prop(name: string, className: string, width: number, height: number) {
  return { src: `/brand/props/${name}.webp`, className, width, height }
}

function scene(
  title: string,
  variant: EmptyArtVariant,
  props: EmptyScene["props"],
): EmptyScene {
  return { title, variant, props }
}

/**
 * 空工作区占位 — 路由/外壳已就位,但本地工作区还没有作品(或该域暂无数据)。
 * 用一张温和的像素编辑部静物 + 引导动作,而不是报错式提示。
 */
export function CjPlaceholder({
  title,
  sub,
  variant,
}: {
  title: string
  sub?: string
  variant?: EmptyArtVariant
  /** 兼容旧调用,不再渲染「对接中」字样 */
  source?: string
}) {
  const scene = SCENES[variant ?? TITLE_VARIANT[title] ?? "default"]

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{title}</h1>
        </div>
      </div>
      <div className="empty empty-lg editorial-empty" data-empty-variant={scene.variant}>
        <div className="empty-art">
          <EmptyArt variant={scene.variant} />
        </div>
        <div className="empty-title">{scene.title}</div>
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

/**
 * 卡片内迷你空态 — 一枚 22px 像素道具 + 一句编辑部口吻的话。
 * 与整页空态(像素剧场)同语言但更克制:横排单行,不抢数据区的戏。
 */
export function MiniEmpty({
  icon = "sleeping-cat",
  fill,
  children,
}: {
  /** /brand/props 下的像素道具名,按场景选(sleeping-cat / ink-quill / stamp-seal …) */
  icon?: string
  /** 撑满父容器高度 — 用于固定高度的图表区,保证整行垂直居中 */
  fill?: boolean
  children: ReactNode
}) {
  return (
    <div className={`empty empty-mini${fill ? " empty-mini-fill" : ""}`}>
      <img
        className="empty-mini-ico"
        src={`/brand/props/${icon}.webp`}
        alt=""
        width={22}
        height={22}
        draggable={false}
      />
      <span>{children}</span>
    </div>
  )
}

/** 像素静物占位:稿纸 + 台灯 + 绿植。随主题自适应。 */
export function EmptyArt({ variant = "default" }: { variant?: EmptyArtVariant }) {
  const scene = SCENES[variant]

  return (
    <div className="empty-pixel-scene" data-empty-variant={scene.variant} aria-hidden="true">
      {scene.props.map((item) => (
        <img
          key={`${scene.variant}-${item.src}-${item.className}`}
          className={`eps-prop ${item.className}`}
          src={item.src}
          alt=""
          width={item.width}
          height={item.height}
          draggable={false}
        />
      ))}
      <span className="eps-glow" />
    </div>
  )
}
