/**
 * 卷舍 · 起点 / 晋江 / 七猫 发草稿适配器(配置驱动,骨架)
 *
 * ⚠️ 骨架(verified:false):下面的 URL 与按钮文字/选择器,是「按各平台作家后台常见结构的
 *    最佳猜测」,首次实测前很可能要改。对齐方法(每个站约 10 分钟):
 *      1. 桌面客户端里 await window.juanshe.publish.login('<id>') → 登录该平台后台。
 *      2. await window.juanshe.publish.draft('<id>', {bookTitle, title, content}) → 看返回 message 卡在哪步。
 *      3. 在该后台页面 DevTools 里找到真实的「章节管理/新建章节」按钮文字、标题框 placeholder、
 *         正文编辑器选择器、「存草稿」按钮文字,替换对应数组,把 verified 改成 true。
 *    通用流程在 ./generic.ts,平台无关的 DOM 工具在 ./automation.ts。
 */
import { makeWebNovelPublisher, type WebNovelSite } from "./generic.js"

// 起点中文网 · 作家专区(男频主战场)
const QIDIAN: WebNovelSite = {
  id: "qidian",
  name: "起点中文网",
  loginUrl: "https://write.qidian.com/", // TODO 实测:起点作家专区登录入口
  bookManageUrl: "https://write.qidian.com/", // TODO 实测:作品/章节管理页 URL
  partition: "persist:juanshe-pub-qidian",
  loggedInText: ["我的作品", "章节管理", "作家助手", "作品管理"],
  enterChapterText: ["章节管理", "管理作品", "作品详情", "管理"],
  newChapterText: ["新建章节", "写新章节", "发新章节", "新增章节", "写作"],
  titlePlaceholders: ["章节名", "请输入标题", "标题"],
  editorSelectors: [".ql-editor", ".ProseMirror", "[contenteditable=true]", "textarea"],
  saveDraftText: ["存草稿", "保存草稿", "保存"],
  needsChapterNumber: false,
  verified: false,
}

// 晋江文学城 · 作者专区(女频主战场;晋江本就有「存稿箱」概念,天然契合发草稿)
const JJWXC: WebNovelSite = {
  id: "jjwxc",
  name: "晋江文学城",
  loginUrl: "https://www.jjwxc.net/", // TODO 实测:晋江登录 → 作者专区
  bookManageUrl: "https://www.jjwxc.net/", // TODO 实测:作者专区→我的作品→章节管理
  partition: "persist:juanshe-pub-jjwxc",
  loggedInText: ["作者专区", "我的作品", "存稿箱", "作品管理"],
  enterChapterText: ["章节管理", "管理章节", "我的作品", "管理"],
  newChapterText: ["发表文章", "新建章节", "发布新章", "上传新章", "写文章"],
  titlePlaceholders: ["章节标题", "标题", "请输入"],
  editorSelectors: ["textarea", ".ql-editor", ".ProseMirror", "[contenteditable=true]"],
  saveDraftText: ["存草稿", "存入存稿箱", "保存草稿", "保存"],
  needsChapterNumber: false,
  verified: false,
}

// 七猫中文网 · 作家平台
const QIMAO: WebNovelSite = {
  id: "qimao",
  name: "七猫中文网",
  loginUrl: "https://writer.qimao.com/", // TODO 实测:七猫作家平台登录
  bookManageUrl: "https://writer.qimao.com/", // TODO 实测
  partition: "persist:juanshe-pub-qimao",
  loggedInText: ["我的作品", "章节管理", "作品管理", "作家中心"],
  enterChapterText: ["章节管理", "作品详情", "管理"],
  newChapterText: ["新建章节", "写新章节", "新增章节", "写作"],
  titlePlaceholders: ["章节名", "请输入标题", "标题"],
  editorSelectors: [".ql-editor", ".ProseMirror", "[contenteditable=true]", "textarea"],
  saveDraftText: ["存草稿", "保存草稿", "保存"],
  needsChapterNumber: false,
  verified: false,
}

export const qidian = makeWebNovelPublisher(QIDIAN)
export const jjwxc = makeWebNovelPublisher(JJWXC)
export const qimao = makeWebNovelPublisher(QIMAO)
