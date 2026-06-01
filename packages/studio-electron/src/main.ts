/**
 * 卷舍 桌面客户端 · Electron 主进程
 *
 * 目标(用户原话):像真客户端,不乱刷新、固定边栏、可缩放、颜值到位,不像"网页打的包"。
 * - 无边框/隐藏标题栏(macOS hiddenInset 露出红绿灯),暖色背景跟主题。
 * - 生产:内嵌启动后端(studio)+ 前端(next start),就绪门轮询后再 loadURL,冷启动不闪白。
 * - 开发:ELECTRON_DEV=1 直接载已运行的 :3100。
 * - 无整页刷新:禁用 Cmd+R/F5(菜单不放 reload)+ will-navigate 拦外链 + preload 拦 location.reload。
 * - 缩放:Cmd/Ctrl +/-/0。
 */
import {
  app,
  BrowserWindow,
  Menu,
  shell,
  nativeTheme,
  utilityProcess,
  type MenuItemConstructorOptions,
  type UtilityProcess,
} from "electron"
import { dirname, join } from "node:path"
import { appendFileSync, existsSync, mkdirSync, cpSync, writeFileSync } from "node:fs"
import http from "node:http"

const DEV = process.env.ELECTRON_DEV === "1"
const FRONT_PORT = Number(process.env.JUANSHE_WEB_PORT || 3100)
const API_PORT = Number(process.env.JUANSHE_API_PORT || 4569)
const FRONT_URL = `http://localhost:${FRONT_PORT}`
const DEFAULT_ACTIVATION_VERIFY_URL = "https://api.nextapi.top/juanshe-activation/verify"

let win: BrowserWindow | null = null
const children: UtilityProcess[] = []

function logPath(name: string): string {
  const dir = app.getPath("logs")
  mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

function appendLog(file: string, message: string | Buffer) {
  appendFileSync(file, message)
}

function attachUtilityLogs(child: UtilityProcess, label: string, fileName: string) {
  const file = logPath(fileName)
  const line = (message: string) => appendLog(file, `[${new Date().toISOString()}] ${label}: ${message}\n`)
  child.stdout?.on("data", (chunk) => appendLog(file, chunk))
  child.stderr?.on("data", (chunk) => appendLog(file, chunk))
  child.on("spawn", () => line(`spawned pid=${child.pid ?? "unknown"}`))
  child.on("exit", (code) => line(`exited code=${code}`))
  child.on("error", (type, location, report) => {
    line(`fatal ${type} at ${location}`)
    appendLog(file, `${report}\n`)
  })
}

/**
 * 解析并(首启时)播种工作区。
 * 关键:打包后绝不能把工作区放进只读的 .app 包内,也绝不能依赖 cwd(从 Finder 启动常是 "/")。
 * 一律落到用户数据目录(userData/workspace),首启从打包内的干净模板(无个人书、空书架→触发新手引导)拷贝。
 * 用户可用 JUANSHE_WORKSPACE 覆盖到自有目录。
 */
function resolveWorkspace(): string {
  const custom = process.env.JUANSHE_WORKSPACE || process.env.HARDWRITE_PROJECT_ROOT
  const ws = custom || join(app.getPath("userData"), "workspace")
  if (existsSync(join(ws, "hardwrite.json"))) return ws // 已有(老用户),保留其作品

  mkdirSync(ws, { recursive: true })
  // 打包内模板候选:extraResources 落在 Contents/Resources/(process.resourcesPath)
  const templateCandidates = [
    join(process.resourcesPath || "", "workspace-template"),
    join(process.resourcesPath || "", "app", "workspace-template"),
  ]
  const src = templateCandidates.find((p) => p && existsSync(join(p, "hardwrite.json")))
  if (src) {
    try {
      cpSync(src, ws, { recursive: true, errorOnExist: false })
    } catch {
      /* 拷贝失败走下方兜底 */
    }
  }
  // 兜底:模板缺失也至少写最小 hardwrite.json,保证后端能起(空书架 → 新手引导)
  if (!existsSync(join(ws, "hardwrite.json"))) {
    writeFileSync(
      join(ws, "hardwrite.json"),
      JSON.stringify({ name: "juanshe", version: "0.1.0", type: "novel", language: "zh" }, null, 2),
      "utf-8",
    )
  }
  return ws
}

function waitForUrl(url: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve()
      })
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`等待 ${url} 就绪超时`))
        else setTimeout(tick, 400)
      })
    }
    tick()
  })
}

function spawnBackends() {
  const root = app.isPackaged ? join(process.resourcesPath, "app") : join(__dirname, "..", "..", "..")
  const workspace = resolveWorkspace()
  const activationExplicitlyDisabled = process.env.HARDWRITE_ACTIVATION_REQUIRED === "0"
  const activationVerifyUrl = activationExplicitlyDisabled
    ? ""
    : process.env.HARDWRITE_ACTIVATION_VERIFY_URL || DEFAULT_ACTIVATION_VERIFY_URL
  const standaloneRoot = join(root, "packages", "studio-web")
  const webServer =
    [join(standaloneRoot, "packages", "studio-web", "server.js"), join(standaloneRoot, "server.js")]
      .find((candidate) => existsSync(candidate)) || join(standaloneRoot, "packages", "studio-web", "server.js")
  // 后端:用 utilityProcess 跑隐藏 Node 服务,避免 macOS Dock 出现可见的 "exec" 子应用。
  const api = utilityProcess.fork(
    join(root, "packages", "studio", "dist", "api", "index.js"),
    [workspace],
    {
      env: {
        ...process.env,
        JUANSHE_API_PORT: String(API_PORT),
        JUANSHE_WORKSPACE: workspace,
        HARDWRITE_STUDIO_PORT: String(API_PORT),
        HARDWRITE_PROJECT_ROOT: workspace,
        HARDWRITE_ACTIVATION_REQUIRED: activationExplicitlyDisabled ? "0" : process.env.HARDWRITE_ACTIVATION_REQUIRED || "1",
        HARDWRITE_ACTIVATION_VERIFY_URL: activationVerifyUrl,
      },
      serviceName: "Juanshe Studio API",
      stdio: "pipe",
    },
  )
  const next = utilityProcess.fork(
    webServer,
    [],
    {
      cwd: dirname(webServer),
      env: {
        ...process.env,
        HOSTNAME: "127.0.0.1",
        PORT: String(FRONT_PORT),
        JUANSHE_API_BASE: `http://localhost:${API_PORT}`,
        NEXT_PUBLIC_JUANSHE_API_BASE: `http://localhost:${API_PORT}`,
        HARDWRITE_API_BASE: `http://localhost:${API_PORT}`,
        NEXT_PUBLIC_HARDWRITE_API_BASE: `http://localhost:${API_PORT}`,
      },
      serviceName: "Juanshe Web Server",
      stdio: "pipe",
    },
  )
  attachUtilityLogs(api, "api", "backend.log")
  attachUtilityLogs(next, "web", "studio-web.log")
  children.push(api, next)
}

function zoom(delta: number) {
  if (!win) return
  const z = win.webContents.getZoomFactor()
  win.webContents.setZoomFactor(Math.max(0.6, Math.min(2, Math.round((z + delta) * 100) / 100)))
}

function buildMenu() {
  const isMac = process.platform === "darwin"
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    { role: "editMenu" },
    {
      label: "视图",
      submenu: [
        { label: "放大", accelerator: "CmdOrCtrl+=", click: () => zoom(0.1) },
        { label: "缩小", accelerator: "CmdOrCtrl+-", click: () => zoom(-0.1) },
        { label: "实际大小", accelerator: "CmdOrCtrl+0", click: () => win?.webContents.setZoomFactor(1) },
        { type: "separator" },
        ...(DEV ? [{ role: "toggleDevTools" as const }] : []),
        { role: "togglefullscreen" as const },
      ],
    },
    { role: "windowMenu" },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: dark ? "#1A1610" : "#FAF6EF", // 暖色,跟主题(冷启动不闪白)
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 16 },
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  })

  // 非内部导航 → 系统浏览器开;内部 SPA 导航放行(不整页刷新)
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(FRONT_URL)) {
      e.preventDefault()
      void shell.openExternal(url)
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: "deny" }
  })

  win.once("ready-to-show", () => win?.show())
  await win.loadURL(FRONT_URL)
}

app.whenReady().then(async () => {
  buildMenu()
  if (!DEV) {
    spawnBackends()
    try {
      await waitForUrl(FRONT_URL, 30000)
    } catch {
      /* 就绪门超时也尝试加载,loadURL 自身会重试展示 */
    }
  }
  await createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
app.on("before-quit", () => {
  for (const c of children) {
    try {
      c.kill()
    } catch {
      /* ignore */
    }
  }
})
