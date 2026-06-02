# 卷舍 · 多平台「一键发草稿」

把写好的一章,自动写进各小说/内容平台的**草稿箱**(只发草稿、不直接发布——更安全:不发 live 内容、不怕首发被判 AI 灌水、ToS 风险低,作者后台二次确认后再正式发)。

## 架构(复用 Electron 自带 Chromium,不引 Playwright)

```
前端(studio-web)──IPC──▶ 主进程 publishers/
   window.juanshe.publish.*        ├─ index.ts        注册表 + 窗口管理 + IPC
                                    ├─ automation.ts   BrowserController(注入 __jp DOM 工具/自动追新标签页/杀引导弹窗)
                                    ├─ types.ts        PlatformPublisher 契约
                                    └─ <platform>.ts   各平台适配器(loginUrl + createDraft 流程)
```

- **登录**:开「可见」分区窗加载平台后台,作者扫码/密码登录,关窗即把 cookie 持久化进该平台的 `persist:` 分区(下次免登,无需手搓 state.json)。
- **发草稿**:开「隐藏」分区窗(复用同一 cookie),`BrowserController` 在页面里注入 `__jp` 工具做 DOM 自动化,跑完销毁。
- **隔离**:每个平台一个 `persist:juanshe-pub-<id>` 分区,cookie 互不串;退出登录 = 清该分区。
- 仅桌面客户端可用(纯网页模式无主进程);前端据 `window.__ELECTRON__` 决定是否展示入口。

## 前端契约(window.juanshe.publish)

```ts
platforms(): Promise<{id,name,auth}[]>          // 已接入平台
login(platform): Promise<{ok,message}>          // 开登录窗
status(platform): Promise<{platform,loggedIn}>  // 查登录态
draft(platform, {                               // 发一章到草稿箱
  bookTitle, title, content, chapterNumber?, volume?
}): Promise<{ok,platform,message,draftUrl?}>
logout(platform): Promise<{ok}>                 // 退出(清 cookie)
```

正文从后端按当前书/章取,前端拼成 `{bookTitle,title,content}` 调 `draft`。

## 加一个「浏览器自动化」平台

网文后台流程高度同构(进作品→章节管理→新建章节→填标题→灌正文→存草稿),所以有两种加法:

**A. 配置驱动(标准后台,推荐)** —— 在 `web-novel-sites.ts` 加一份 `WebNovelSite` 配置即可,
无需写流程代码。起点/晋江/七猫就是这么加的。每份配置给:URL、登录态特征文字、
「章节管理/新建章节」按钮文字、标题框 placeholder、正文编辑器选择器、「存草稿」按钮文字。
通用流程在 `generic.ts`(`makeWebNovelPublisher`)。

**B. 手写适配器(特殊后台)** —— 照 `fanqie.ts` 写一份(番茄要 hover 卡片露按钮、且编辑器自动存草稿,
属特例)。`automation.ts` 的 `__jp`(`clickText/fillPlaceholder/fillFirst/setEditor/killGuides/hasText/exists`)
平台无关,直接复用。

两种都在 `index.ts` 的 `PUBLISHERS` 登记。

**实测对齐选择器(每个站约 10 分钟)**:桌面客户端跑 `publish.login('<id>')` 登录 →
`publish.draft('<id>', {...})` 看返回 message 卡在哪步 → 在该后台 DevTools 找到真实的
按钮文字/placeholder/编辑器选择器,替换 `web-novel-sites.ts` 里对应数组,把 `verified` 改 `true`。

## 加「API」平台(微信公众号,更稳)

公众号有官方草稿 API,比浏览器自动化稳,但需作者的**服务号/已认证订阅号** appId+secret:

1. 取 token:`GET /cgi-bin/token?grant_type=client_credential&appid=&secret=`
2. 传封面缩略图素材换 `thumb_media_id`(草稿必填封面):`POST /cgi-bin/material/add_material?type=thumb`
3. 建草稿:`POST /cgi-bin/draft/add?access_token=`,body `{articles:[{title,content,thumb_media_id,...}]}`

API 类适配器 `auth:"api"`,不开窗、用存储的凭据走 HTTP(可放主进程或后端)。需作者在设置里填 appId/secret + 选封面。

## 各平台状态

| 平台 | 方式 | 状态 |
|---|---|---|
| 番茄小说 | 浏览器自动化 | ✅ 已实现(`fanqie.ts`,选择器移植自社区脚本,待真账号实测) |
| 起点中文网 | 浏览器自动化 | 🟡 骨架已就位(`web-novel-sites.ts`),选择器待实测对齐 |
| 晋江文学城 | 浏览器自动化 | 🟡 骨架已就位,选择器待实测对齐 |
| 七猫中文网 | 浏览器自动化 | 🟡 骨架已就位,选择器待实测对齐 |
| 微信公众号 | 浏览器自动化 | 🟡 骨架已就位(`wechat.ts`,登录即发、无需 appId);选择器待实测(正文在 UEditor iframe,用 `setEditorDeep`) |
| 微信公众号(可选) | 官方草稿 API | ⏳ 未做(更稳,但需每人填自己公众号 appId/secret + 配 IP 白名单,留作高级可选项) |

## 实测番茄(用你的真账号)

1. 打包/起桌面客户端(`pnpm --filter @juanshe/studio-electron pack:mac` 或 dev 起 Electron)。
2. 前端(或临时在 DevTools)调:`await window.juanshe.publish.login('fanqie')` → 弹窗里登录番茄作家后台 → 关窗。
3. `await window.juanshe.publish.status('fanqie')` → `{loggedIn:true}`。
4. `await window.juanshe.publish.draft('fanqie', {bookTitle:'你的作品名', title:'第1章 测试', content:'正文...\n第二段...'})`。
5. 去番茄作家后台「章节管理」看草稿箱是否出现该章。

> ⚠️ 浏览器自动化打的是平台后台网页,平台改版会让选择器失效——失败信息会明确提示「需更新选择器」。属各家 ToS 灰区,只发草稿、由作者确认后再发,风险最低。
