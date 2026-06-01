# 卷舍 桌面客户端(Electron 外壳)

把卷舍打成"像真客户端"的桌面 App:无边框原生窗(macOS 红绿灯)、暖色背景跟主题、
**无整页刷新**(禁 Cmd+R/F5 + 拦外链 + 拦 location.reload)、**可缩放**(Cmd/Ctrl +/-/0)、
内嵌启动后端 + 前端、就绪门轮询后再显示(冷启动不闪白)。

## 开发预览(已运行 :3100/:4569 时)
```bash
# 1) 起前后端(另开两个终端,或用根 pnpm dev)
#    前端 :3100 / 后端 :4569
# 2) 编译 + 起 Electron(载已运行的 :3100)
pnpm --filter @juanshe/studio-electron build
ELECTRON_DEV=1 pnpm --filter @juanshe/studio-electron dev
```
> 首次需让 electron 下载二进制:根目录 `pnpm approve-builds`(选 electron)或已设 `allowBuilds.electron: true` 后重装。

## 出安装包(.dmg / .exe)
打包前先产出内嵌的后端/前端/核心产物:
```bash
# 核心 & 后端 & 引擎 dist(注意:core 有在途改动时先确认再 build)
cd packages/core && ./node_modules/.bin/tsc && cd -
pnpm --filter @juanshe/studio build
pnpm --filter @juanshe/engine build
# 前端 standalone(用 webpack 构建,turbopack 不出 standalone)
pnpm --filter studio-web build
# 出包
pnpm --filter @juanshe/studio-electron pack:mac     # → release/卷舍-*.dmg
pnpm --filter @juanshe/studio-electron pack:win     # → release/卷舍-*.exe
```

## 关键文件
- `src/main.ts` — 主进程:原生窗 + spawn 后端/前端 + 就绪门 + 菜单/缩放 + will-navigate 拦外链。
- `src/preload.ts` — 暴露 `window.__ELECTRON__` + 拦 F5/Cmd+R/location.reload。
- `electron-builder.yml` — 把 studio/core/engine dist + studio-web `.next/standalone` 打进资源。

## 上线注意
- **打包内容不带任何私人书**:安装包只带空工作区 / 通用示例书,绝不捆 `hardwrite-workspace` 的个人作品。
- **激活门禁默认开启**:客户端内嵌后端默认使用 `HARDWRITE_ACTIVATION_REQUIRED=1` 和远端 `HARDWRITE_ACTIVATION_VERIFY_URL`;需要本地调试时可在 `~/Library/Application Support/卷舍/.env` 覆盖。
- **微信分发**:当前可在公众号后台用关键词自动回复 `领码` / `下载`，回复下载页 `https://api.nextapi.top/juanshe-download/` 与内测激活码；若要一人一码，需要再接公众号开发者服务器 webhook。
- **macOS 签名**:无 Apple Developer ID 时，打包流程会做内测用 ad-hoc bundle 签名，避免 Gatekeeper 把半签名 Electron bundle 判成"已损坏"。浏览器下载后仍可能带 quarantine，本机内测可执行 `xattr -dr com.apple.quarantine /Applications/卷舍.app` 后再打开。
- **正式分发**:macOS 线上分发仍需 Apple Developer ID 签名 + notarytool 公证；Windows 正式分发也需要代码签名证书以减少 SmartScreen 拦截。
- BYOK:用户在 App 内「服务设置」填自己的模型 Key,仅存本地后端,不上传。
