/**
 * 卷舍 · 微信公众号 发草稿适配器(浏览器自动化,骨架)
 *
 * 走 mp.weixin.qq.com 后台:扫码登录 → 新建图文 → 填标题+正文 → 保存为草稿。
 * 不用 appId/secret、不用 IP 白名单——和番茄/起点同模式,凭据=用户自己的登录会话(存本机分区)。
 *
 * ⚠️ 骨架(verified:false):选择器为最佳猜测,首次实测前很可能要改。
 *    公众号图文正文历史上是 UEditor 的 <iframe>,故正文用 setEditorDeep(会钻进同源 iframe)。
 * 🔒 安全:只精确点「保存为草稿」,绝不点「群发 / 发表」——发草稿不外发。
 *
 * 注:公众号没有"作品"概念,这里忽略 chapter.bookTitle,只用 title + content 建一篇图文草稿。
 */
import type { DraftChapter, PlatformPublisher, PublishResult } from "./types.js"
import type { BrowserController } from "./automation.js"
import { sleep } from "./automation.js"

const HOME = "https://mp.weixin.qq.com/"
const NOTE = "(公众号选择器待实测对齐)"
const j = (s: string): string => JSON.stringify(s ?? "")

export const wechat: PlatformPublisher = {
  id: "wechat",
  name: "微信公众号",
  loginUrl: HOME,
  partition: "persist:juanshe-pub-wechat",
  auth: "browser",

  async isLoggedIn(ctrl: BrowserController): Promise<boolean> {
    await ctrl.goto(HOME)
    await sleep(2200)
    await ctrl.inject()
    return ctrl.call<boolean>(
      `window.__jp.hasText('草稿箱') || window.__jp.hasText('新的创作') || window.__jp.hasText('内容与互动') || window.__jp.hasText('素材管理') || window.__jp.hasText('图文消息')`,
      false,
    )
  },

  async createDraft(ctrl: BrowserController, chapter: DraftChapter): Promise<PublishResult> {
    const fail = (m: string): PublishResult => ({ ok: false, platform: "wechat", message: m })

    await ctrl.goto(HOME)
    await sleep(2500)
    await ctrl.inject()
    if (!(await ctrl.call<boolean>(`window.__jp.hasText('草稿箱') || window.__jp.hasText('新的创作') || window.__jp.hasText('素材管理')`, false))) {
      return fail("打开公众号后台失败——可能未登录,请先在『连接账号』里扫码登录公众号。")
    }

    // 1) 新建图文(「新的创作」→「图文消息/写新图文」;公众号常在新标签开编辑器,BrowserController 自动切到新页)
    await ctrl.call<boolean>(`window.__jp.clickText('新的创作') || window.__jp.clickText('图文消息') || window.__jp.clickText('写新图文')`, false)
    await sleep(1600)
    await ctrl.inject()
    await ctrl.call<boolean>(`window.__jp.clickText('图文消息') || window.__jp.clickText('写新图文')`, false)
    await sleep(3500)
    await ctrl.inject()
    if (!(await ctrl.waitFor(`window.__jp.hasText('请在这里输入标题') || window.__jp.exists('[contenteditable=true],iframe') || window.__jp.hasText('封面和摘要') || window.__jp.hasText('封面')`, { timeout: 15000 }))) {
      return fail(`进入公众号图文编辑器失败${NOTE}。`)
    }
    await ctrl.clearGuides(100)

    // 2) 填标题
    await ctrl.call<boolean>(
      `window.__jp.fillPlaceholder('请在这里输入标题', ${j(chapter.title)}) || window.__jp.fillPlaceholder('标题', ${j(chapter.title)}) || window.__jp.fillFirst('textarea,input[type=text]', ${j(chapter.title)})`,
      false,
    )
    await sleep(400)

    // 3) 灌正文(图文正文常在 UEditor iframe → setEditorDeep 钻进同源 iframe)
    const bodyOk = await ctrl.call<boolean>(
      `window.__jp.setEditorDeep(['.ProseMirror','[contenteditable=true]','.rich_media_content'], ${j(chapter.content)})`,
      false,
    )
    if (!bodyOk) return fail(`没找到公众号正文编辑区${NOTE}(可能在 iframe 里或已改版)。`)
    await sleep(1200)

    // 4) 保存为草稿(精确匹配,🔒 绝不点群发/发表)
    const saved = await ctrl.call<boolean>(
      `window.__jp.clickText('保存为草稿',{exact:true}) || window.__jp.clickText('保存草稿',{exact:true}) || window.__jp.clickText('保存',{exact:true})`,
      false,
    )
    await sleep(2200)
    if (!saved) return fail(`正文已填好,但没找到「保存为草稿」按钮${NOTE}——内容可能未保存。`)

    return {
      ok: true,
      platform: "wechat",
      message: `已把《${chapter.title}》存入公众号草稿箱。请到公众号后台「草稿箱」确认后再群发/发表。`,
    }
  },
}
