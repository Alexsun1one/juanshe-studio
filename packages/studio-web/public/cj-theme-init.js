/* 卷舍 · 主题色防闪初始化(静态文件,无 XSS 面)
   在 React 注水前同步执行:把 localStorage 里选的主题色写到 <html data-cj-theme>,
   避免首屏先渲染默认柔紫再跳变。默认(violet 或未设)不写属性,沿用 design.css 原值。 */
(function () {
  try {
    var t = localStorage.getItem("cj.theme-color");
    if (t && t !== "violet") {
      document.documentElement.setAttribute("data-cj-theme", t);
    }
  } catch (e) {
    /* localStorage 不可用时静默降级到默认主题 */
  }
})();
