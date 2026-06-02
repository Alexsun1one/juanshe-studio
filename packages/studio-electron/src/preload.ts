/**
 * 卷舍 桌面客户端 · preload
 * - 标记 __ELECTRON__(前端据此渲染原生标题栏 / 隐藏"在浏览器打开"等)。
 * - 拦截整页刷新(F5 / Cmd+R / location.reload):保持"真客户端不刷新"的手感。
 *   (DOM 与真实页面共享,故在此加监听 / 改 location 对页面生效;JS 作用域隔离不影响。)
 */
import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("__ELECTRON__", true)
contextBridge.exposeInMainWorld("juanshe", {
  platform: process.platform,
  isDesktop: true,
  // 多平台「一键发草稿」桥(只在桌面客户端可用;前端可据 window.__ELECTRON__ 决定是否展示入口)
  publish: {
    /** 列出已接入平台:[{id,name,auth}] */
    platforms: () => ipcRenderer.invoke("publish:platforms"),
    /** 开登录窗让作者登录该平台(关窗即存会话) */
    login: (platform: string) => ipcRenderer.invoke("publish:login", platform),
    /** 查该平台是否已登录:{platform,loggedIn} */
    status: (platform: string) => ipcRenderer.invoke("publish:status", platform),
    /** 把一章发到该平台草稿箱:draft(platform,{bookTitle,title,content,chapterNumber?,volume?}) */
    draft: (platform: string, chapter: unknown) => ipcRenderer.invoke("publish:draft", platform, chapter),
    /** 退出该平台登录(清分区 cookie) */
    logout: (platform: string) => ipcRenderer.invoke("publish:logout", platform),
  },
})

// 拦 F5 / Cmd+R / Ctrl+R 整页刷新
window.addEventListener(
  "keydown",
  (e) => {
    const k = e.key.toLowerCase()
    if (k === "f5" || ((e.metaKey || e.ctrlKey) && k === "r")) {
      e.preventDefault()
      e.stopPropagation()
    }
  },
  true,
)

// 阻止脚本触发的 location.reload()(整页刷新)
try {
  Object.defineProperty(window.location, "reload", {
    configurable: true,
    value: () => {
      /* blocked: 客户端不整页刷新 */
    },
  })
} catch {
  /* ignore */
}
