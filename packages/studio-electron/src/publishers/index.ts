/**
 * 卷舍 · 发布器注册表 + 窗口管理 + IPC
 *
 * - 登录:开「可见」分区窗加载平台后台,用户登录后关窗 → cookie 持久化在该分区(下次免登)。
 * - 查态/发草稿:开「隐藏」分区窗(复用同一 cookie),跑适配器,用完销毁。
 * - 各平台 cookie 用独立 persist 分区隔离;退出登录 = 清该分区存储。
 *
 * 前端经 preload 的 window.juanshe.publish.* 调这些 IPC。浏览器自动化只在桌面客户端可用
 * (纯网页模式无 Electron 主进程,前端应据 window.__ELECTRON__ 决定是否显示「一键发草稿」)。
 */
import { BrowserWindow, ipcMain, session } from "electron"
import { BrowserController } from "./automation.js"
import type { DraftChapter, PlatformPublisher, PublishResult } from "./types.js"
import { fanqie } from "./fanqie.js"
import { qidian, jjwxc, qimao } from "./web-novel-sites.js"
import { wechat } from "./wechat.js"

// 已接入的平台。新增一个站 = 加一个适配器/配置并在此登记(详见 ./README.md)。
const PUBLISHERS: Record<string, PlatformPublisher> = {
  [fanqie.id]: fanqie, // 已实现(选择器移植自社区脚本,待真账号实测)
  [qidian.id]: qidian, // 骨架(配置驱动),选择器待实测对齐
  [jjwxc.id]: jjwxc, // 骨架,选择器待实测对齐
  [qimao.id]: qimao, // 骨架,选择器待实测对齐
  [wechat.id]: wechat, // 骨架(浏览器自动化,非 API),选择器待实测对齐
}

function get(platform: string): PlatformPublisher | null {
  return PUBLISHERS[platform] ?? null
}

/**
 * 该平台的可信域名(供 BrowserController 限定只在自家站注入页面工具/稿件)。
 * 各平台 loginUrl 与其作品管理页同域,取 loginUrl 的 host 即可;子域由 isTrusted 的 endsWith 覆盖。
 * 注:平台跳到任意第三方页(被诱导 / origin 混淆)时,稿件注入会被拒,不外泄。
 */
function publisherHosts(pub: PlatformPublisher): string[] {
  const hosts: string[] = []
  for (const url of [pub.loginUrl]) {
    if (!url) continue
    try { hosts.push(new URL(url).hostname.toLowerCase()) } catch { /* 非法 URL 忽略 */ }
  }
  return hosts
}

function openWindow(pub: PlatformPublisher, visible: boolean): BrowserWindow {
  return new BrowserWindow({
    width: 1180,
    height: 820,
    show: visible,
    title: visible ? `连接 ${pub.name}` : `${pub.name} · 后台`,
    autoHideMenuBar: true,
    webPreferences: {
      partition: pub.partition, // cookie 按平台持久化隔离
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      // 不挂卷舍 preload:这是平台自己的页面
    },
  })
}

/** 登录:开可见窗加载平台后台,用户登录后关窗即保存会话(分区持久化) */
function login(platform: string): Promise<{ ok: boolean; message: string }> {
  const pub = get(platform)
  if (!pub) return Promise.resolve({ ok: false, message: `未知平台:${platform}` })
  if (pub.auth === "api") {
    return Promise.resolve({ ok: false, message: `${pub.name} 用 API 凭据(在设置里填 appId/secret),无需登录窗。` })
  }
  return new Promise((resolve) => {
    const win = openWindow(pub, true)
    let settled = false
    win.loadURL(pub.loginUrl).catch(() => {})
    win.on("closed", () => {
      if (!settled) {
        settled = true
        resolve({ ok: true, message: `${pub.name} 登录窗已关闭,会话已保存(下次免登)。` })
      }
    })
  })
}

/** 查登录态:开隐藏窗加载后台跑 isLoggedIn,用完销毁 */
async function status(platform: string): Promise<{ platform: string; loggedIn: boolean }> {
  const pub = get(platform)
  if (!pub) return { platform, loggedIn: false }
  const win = openWindow(pub, false)
  const ctrl = new BrowserController(win, publisherHosts(pub))
  try {
    return { platform, loggedIn: await pub.isLoggedIn(ctrl) }
  } catch {
    return { platform, loggedIn: false }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/** 发草稿:开隐藏窗跑 createDraft,用完销毁 */
async function sendDraft(platform: string, chapter: DraftChapter): Promise<PublishResult> {
  const pub = get(platform)
  if (!pub) return { ok: false, platform, message: `未知平台:${platform}` }
  if (!chapter?.title || !chapter?.content) {
    return { ok: false, platform, message: "缺少标题或正文。" }
  }
  const win = openWindow(pub, false)
  const ctrl = new BrowserController(win, publisherHosts(pub))
  try {
    if (!(await pub.isLoggedIn(ctrl))) {
      return { ok: false, platform, message: `还没登录 ${pub.name},请先在『连接账号』里登录。` }
    }
    return await pub.createDraft(ctrl, chapter)
  } catch (e) {
    return { ok: false, platform, message: `发草稿出错:${e instanceof Error ? e.message : String(e)}` }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/** 在 app.whenReady 后调用,注册发布相关 IPC */
export function registerPublishers(): void {
  ipcMain.handle("publish:platforms", () =>
    Object.values(PUBLISHERS).map((p) => ({ id: p.id, name: p.name, auth: p.auth })),
  )
  ipcMain.handle("publish:login", (_e, platform: string) => login(platform))
  ipcMain.handle("publish:status", (_e, platform: string) => status(platform))
  ipcMain.handle("publish:draft", (_e, platform: string, chapter: DraftChapter) => sendDraft(platform, chapter))
  ipcMain.handle("publish:logout", async (_e, platform: string) => {
    const pub = get(platform)
    if (!pub) return { ok: false }
    try {
      await session.fromPartition(pub.partition).clearStorageData()
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })
}
