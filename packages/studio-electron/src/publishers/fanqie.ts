/**
 * 卷舍 · 番茄小说 发草稿适配器(浏览器自动化,样板)
 *
 * 流程(只发草稿箱,停在「填完正文」——番茄编辑器边打边自动存草稿,不点「下一步/确认发布」):
 *   回我的小说总览 → 定位作品(hover 卡片露出「章节管理」)→ 进章节管理 → 杀新手引导 →
 *   新建章节 → 填序号+标题 → 灌正文 →(番茄自动存草稿)→ 完成。
 *
 * 选择器移植自社区脚本 hchcx/fanqie_auto_publish 的 Playwright 流程,改写为 Electron DOM 自动化。
 * 平台改版会失效——失败信息会明确提示「需更新选择器」。
 */
import type { DraftChapter, PlatformPublisher, PublishResult } from "./types.js"
import type { BrowserController } from "./automation.js"
import { sleep } from "./automation.js"

const HOME = "https://fanqienovel.com/main/writer/?enter_from=author_zone"
const BOOK_MANAGE = "https://fanqienovel.com/main/writer/book-manage"

const j = (s: string): string => JSON.stringify(s ?? "")

export const fanqie: PlatformPublisher = {
  id: "fanqie",
  name: "番茄小说",
  loginUrl: HOME,
  partition: "persist:juanshe-pub-fanqie",
  auth: "browser",

  async isLoggedIn(ctrl: BrowserController): Promise<boolean> {
    await ctrl.goto(BOOK_MANAGE)
    await sleep(1500)
    await ctrl.inject()
    return ctrl.call<boolean>(
      `window.__jp.hasText('我的小说') || window.__jp.hasText('章节管理') || window.__jp.hasText('新建作品') || window.__jp.hasText('作品管理')`,
      false,
    )
  },

  async createDraft(ctrl: BrowserController, chapter: DraftChapter): Promise<PublishResult> {
    const fail = (message: string): PublishResult => ({ ok: false, platform: "fanqie", message })

    // 1) 回我的小说总览
    await ctrl.goto(BOOK_MANAGE)
    await sleep(3000)
    await ctrl.inject()
    if (!(await ctrl.call<boolean>(`window.__jp.hasText('章节管理') || window.__jp.hasText('我的小说')`, false))) {
      return fail("打开番茄作家后台失败——可能未登录或网络异常,请先在『连接账号』里登录番茄。")
    }

    // 2) 定位作品进章节管理。多书时「章节管理」需 hover 卡片才出现:在含书名的卡片上派发 mouseover,再点。
    let entered = await ctrl.call<boolean>(
      `(()=>{
        const T=${j(chapter.bookTitle)};
        const all=[...document.querySelectorAll('div,li,section,article')];
        // 安全:优先「整行精确等于书名」的卡片,避免子串误匹配到名字更长的别的书(如发《三国》却命中《三国演义新传》)。
        // 只有在一个精确卡都没有时,才回退到旧的子串匹配,保证合法发布流不被改坏。
        const exact=all.filter(el=>(el.innerText||'').split('\n').some(t=>t.trim()===T));
        const cards=exact.length?exact:all.filter(el=>(el.innerText||'').includes(T));
        for(const c of cards.reverse()){ try{ c.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})); c.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true})); }catch(e){} }
        return window.__jp.clickText('章节管理');
      })()`,
      false,
    )
    if (!entered) {
      await sleep(1200)
      entered = await ctrl.call<boolean>(`window.__jp.clickText('章节管理')`, false)
    }
    if (!entered) {
      return fail(`没找到作品【${chapter.bookTitle}】的「章节管理」入口。请确认作品名与番茄后台完全一致、且作品已创建。`)
    }
    await sleep(3500)
    await ctrl.inject()

    // 3) 清新手引导弹窗(番茄常弹教学卡,靠 y>100 物理坐标过滤)
    await ctrl.clearGuides(100)

    // 4) 不在编辑器(无标题框/正文区)→ 点「新建章节」
    const inEditor = `window.__jp.hasText('请输入标题') || window.__jp.hasText('请输入章节名') || window.__jp.exists('.ql-editor,.ProseMirror,[contenteditable=true]')`
    if (!(await ctrl.call<boolean>(inEditor, false))) {
      await ctrl.call<boolean>(`window.__jp.clickText('新建章节')`, false)
      await sleep(3500)
      await ctrl.inject()
      await ctrl.clearGuides(100)
    }
    if (!(await ctrl.waitFor(`window.__jp.exists('.ql-editor,.ProseMirror,[contenteditable=true]')`, { timeout: 12000 }))) {
      return fail("进入章节编辑器失败(没找到正文编辑区)。可能番茄改版,需要更新选择器。")
    }
    await ctrl.clearGuides(100)

    // 5) 填序号(可空)+ 标题
    if (chapter.chapterNumber) {
      await ctrl.call<boolean>(`window.__jp.fillFirst('input[type=text]', ${j(chapter.chapterNumber)})`, false)
    }
    await ctrl.call<boolean>(
      `window.__jp.fillPlaceholder('请输入标题', ${j(chapter.title)}) || window.__jp.fillPlaceholder('请输入章节名', ${j(chapter.title)}) || window.__jp.fillLast('input[type=text]', ${j(chapter.title)})`,
      false,
    )
    await sleep(400)

    // 6) 灌正文 → 番茄自动存草稿(不点「下一步/确认发布」,内容留在草稿箱)
    const bodyOk = await ctrl.call<boolean>(
      `window.__jp.setEditor(['.ql-editor','.ProseMirror','[contenteditable=true]'], ${j(chapter.content)})`,
      false,
    )
    if (!bodyOk) return fail("没找到正文编辑区,可能番茄改版,需要更新选择器。")
    await sleep(2800) // 等番茄自动存草稿(它边打边存)

    return {
      ok: true,
      platform: "fanqie",
      message: `已把《${chapter.title}》写入番茄草稿箱。请到番茄作家后台「章节管理」确认后再正式发布。`,
    }
  },
}
