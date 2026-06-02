/**
 * 卷舍 · 多平台「一键发草稿」适配器契约(平台无关)
 *
 * 思路:复用 Electron 自带 Chromium——开持久化分区窗口让作者登录一次(cookie 自动持久化,
 * 无需手搓 state.json),再开隐藏窗口在该分区里自动把一章写进平台草稿箱。
 * 番茄/起点/晋江/七猫 走 DOM 自动化(各家后台无公开发布 API);公众号走官方草稿 API。
 *
 * 只发「草稿箱」、不直接发布:更安全(不发 live 内容、不怕首发被判 AI 灌水、ToS 风险低),
 * 作者在各平台后台二次确认后再正式发。
 */
import type { BrowserController } from "./automation.js"

/** 要发到平台草稿箱的一章(平台无关) */
export interface DraftChapter {
  /** 作品名——用于在作家后台定位对应作品 */
  bookTitle: string
  /** 章节序号(可空,部分平台需要) */
  chapterNumber?: string
  /** 章节标题 */
  title: string
  /** 正文纯文本(段落用换行分隔) */
  content: string
  /** 分卷名(可空) */
  volume?: string
}

export interface PublishResult {
  ok: boolean
  platform: string
  message: string
  /** 草稿在平台后台的可访问位置(若拿得到) */
  draftUrl?: string
}

/** 一个平台的发草稿适配器 */
export interface PlatformPublisher {
  /** 稳定 id:"fanqie" | "qidian" | "jjwxc" | "qimao" | "wechat" */
  readonly id: string
  /** 展示名:"番茄小说" */
  readonly name: string
  /** 作家后台登录/首页 URL(开登录窗加载它) */
  readonly loginUrl: string
  /** 持久化分区名,隔离各平台 cookie(如 "persist:juanshe-pub-fanqie") */
  readonly partition: string
  /** 该平台靠浏览器会话(cookie)还是 API 凭据。api 类不需要开窗登录。 */
  readonly auth: "browser" | "api"
  /** 判断当前会话是否已登录(ctrl 已加载后台页) */
  isLoggedIn(ctrl: BrowserController): Promise<boolean>
  /** 把一章送进该平台草稿箱 */
  createDraft(ctrl: BrowserController, chapter: DraftChapter): Promise<PublishResult>
}
