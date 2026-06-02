/**
 * 卷舍 · 配置驱动的「网文后台发草稿」通用流程
 *
 * 番茄/起点/晋江/七猫 这类作家后台的发草稿流程高度同构:
 *   回作品总览 → 进作品章节管理 → 新建章节 → 填标题(可含序号)→ 灌正文 → 存草稿(不发布)。
 * 差异只在「URL + 各步骤的按钮文字/选择器」。于是把流程做成通用器,每个站只写一份配置。
 *
 * 只发草稿:saveDraftText 用**精确匹配**点「存草稿」类按钮(绝不点含"发布/提交"的按钮);
 * saveDraftText=null 表示平台编辑器自动存草稿(如番茄),填完正文等一会即可。
 *
 * 注意:浏览器自动化打第三方后台,平台改版/选择器不准就会失败——失败信息会指明卡在哪步。
 */
import type { DraftChapter, PlatformPublisher, PublishResult } from "./types.js"
import type { BrowserController } from "./automation.js"
import { sleep } from "./automation.js"

export interface WebNovelSite {
  id: string
  name: string
  loginUrl: string
  bookManageUrl: string
  partition: string
  /** 登录态特征文字(任一命中即视为已登录) */
  loggedInText: string[]
  /** 进入「章节管理」的按钮文字候选 */
  enterChapterText: string[]
  /** 「新建章节」按钮文字候选 */
  newChapterText: string[]
  /** 标题输入框 placeholder 关键词候选 */
  titlePlaceholders: string[]
  /** 正文编辑器 CSS 选择器候选 */
  editorSelectors: string[]
  /** 「存草稿」按钮文字候选(精确匹配);null = 平台自动存草稿(如番茄) */
  saveDraftText: string[] | null
  /** 是否需要单独填章节序号 */
  needsChapterNumber?: boolean
  /** 选择器是否已用真账号实测对齐 */
  verified?: boolean
}

const j = (s: string): string => JSON.stringify(s ?? "")
/** 拼 `__jp.fn("a") || __jp.fn("b")`(extra 给第二个参数,如标题值) */
const anyOf = (fn: string, texts: string[], extra = ""): string =>
  texts.map((t) => `window.__jp.${fn}(${j(t)}${extra})`).join(" || ") || "false"

export function makeWebNovelPublisher(site: WebNovelSite): PlatformPublisher {
  const note = site.verified ? "" : "(选择器待实测对齐)"

  return {
    id: site.id,
    name: site.name,
    loginUrl: site.loginUrl,
    partition: site.partition,
    auth: "browser",

    async isLoggedIn(ctrl: BrowserController): Promise<boolean> {
      await ctrl.goto(site.bookManageUrl)
      await sleep(1500)
      await ctrl.inject()
      return ctrl.call<boolean>(anyOf("hasText", site.loggedInText), false)
    },

    async createDraft(ctrl: BrowserController, chapter: DraftChapter): Promise<PublishResult> {
      const fail = (m: string): PublishResult => ({ ok: false, platform: site.id, message: m })

      // 1) 回作品总览
      await ctrl.goto(site.bookManageUrl)
      await sleep(2800)
      await ctrl.inject()
      if (!(await ctrl.call<boolean>(anyOf("hasText", site.loggedInText), false))) {
        return fail(`打开${site.name}作家后台失败——可能未登录或网络异常,请先在『连接账号』里登录${site.name}。`)
      }

      // 2) 进作品的章节管理(先在含书名的卡片上派发 mouseover——有的站按钮 hover 才出现)
      let entered = await ctrl.call<boolean>(
        `(()=>{ const cards=[...document.querySelectorAll('div,li,tr,section,article')].filter(el=>(el.innerText||'').includes(${j(chapter.bookTitle)}));
          for(const c of cards.reverse()){ try{ c.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})); c.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true})); }catch(e){} }
          return ${anyOf("clickText", site.enterChapterText)}; })()`,
        false,
      )
      if (!entered) {
        await sleep(1200)
        entered = await ctrl.call<boolean>(anyOf("clickText", site.enterChapterText), false)
      }
      if (!entered) {
        return fail(`没找到作品【${chapter.bookTitle}】的章节管理入口${note}。请确认作品名与${site.name}后台完全一致、且作品已创建。`)
      }
      await sleep(3200)
      await ctrl.inject()
      await ctrl.clearGuides(100)

      // 3) 不在编辑器 → 新建章节
      const inEditor = `${anyOf("hasText", site.titlePlaceholders)} || window.__jp.exists(${j(site.editorSelectors.join(","))})`
      if (!(await ctrl.call<boolean>(inEditor, false))) {
        await ctrl.call<boolean>(anyOf("clickText", site.newChapterText), false)
        await sleep(3200)
        await ctrl.inject()
        await ctrl.clearGuides(100)
      }
      if (!(await ctrl.waitFor(`window.__jp.exists(${j(site.editorSelectors.join(","))})`, { timeout: 12000 }))) {
        return fail(`进入${site.name}章节编辑器失败${note}(没找到正文编辑区)。`)
      }
      await ctrl.clearGuides(100)

      // 4) 填序号(可选)+ 标题
      if (site.needsChapterNumber && chapter.chapterNumber) {
        await ctrl.call<boolean>(`window.__jp.fillFirst('input[type=text]', ${j(chapter.chapterNumber)})`, false)
      }
      await ctrl.call<boolean>(
        `${anyOf("fillPlaceholder", site.titlePlaceholders, `, ${j(chapter.title)}`)} || window.__jp.fillLast('input[type=text]', ${j(chapter.title)})`,
        false,
      )
      await sleep(400)

      // 5) 灌正文
      const bodyOk = await ctrl.call<boolean>(
        `window.__jp.setEditor(${JSON.stringify(site.editorSelectors)}, ${j(chapter.content)})`,
        false,
      )
      if (!bodyOk) return fail(`没找到${site.name}正文编辑区${note}。`)
      await sleep(900)

      // 6) 存草稿(精确匹配「存草稿」类按钮,绝不点发布);null = 平台自动存
      if (site.saveDraftText) {
        const saveExpr = site.saveDraftText.map((t) => `window.__jp.clickText(${j(t)}, {exact:true})`).join(" || ")
        const saved = await ctrl.call<boolean>(saveExpr, false)
        await sleep(1500)
        if (!saved) return fail(`正文已填好,但没找到「存草稿」按钮${note}——内容可能未保存。`)
      } else {
        await sleep(2500) // 等平台编辑器自动存草稿
      }

      return {
        ok: true,
        platform: site.id,
        message: `已把《${chapter.title}》存入${site.name}草稿箱。请到${site.name}作家后台确认后再正式发布。`,
      }
    },
  }
}
