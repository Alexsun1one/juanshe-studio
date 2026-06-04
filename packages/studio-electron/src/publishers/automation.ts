/**
 * 卷舍 · 浏览器自动化核心(复用 Electron 自带 Chromium,替代 Playwright)
 *
 * BrowserController 包一个 BrowserWindow:
 *  - 自动追踪「当前页」:平台后台常在点击后开新标签页(如番茄点「章节管理/新建章节」),
 *    这里 allow 新窗口并把 current 切到它,适配器无感。
 *  - 每次 dom-ready 自动重注入页面工具 __jp(查可见元素/按文字点/杀引导弹窗/填输入/灌正文)。
 *  - call()/waitFor() 在「当前页」上下文跑 JS,失败兜底不抛,自动化更稳。
 *
 * 注意:executeJavaScript 在页面世界跑(contextIsolation 不影响主动 eval),拿的是真实 DOM。
 */
import { BrowserWindow, type WebContents } from "electron"

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// 注入页面的 DOM 工具(每次导航后由 dom-ready 重注入)。纯 DOM 操作,不依赖任何库。
// 正文一律走 textContent / createElement,绝不用 innerHTML,无 XSS 路径。
const HELPER = String.raw`
window.__jp = {
  vis(el){ if(!el) return false; const r=el.getBoundingClientRect(); const s=getComputedStyle(el);
    return r.width>1 && r.height>1 && s.visibility!=='hidden' && s.display!=='none' && s.opacity!=='0'; },
  all(sel){ try{ return [...document.querySelectorAll(sel)]; }catch(e){ return []; } },
  byText(text, exact){ const els=[...document.querySelectorAll('button,a,span,div,li,td,label,p,h1,h2,h3,i')];
    return els.filter(el=>{ const t=(el.innerText||el.textContent||'').trim();
      return (exact? t===text : t.includes(text)) && window.__jp.vis(el); }); },
  clickText(text, opt){ opt=opt||{}; const els=window.__jp.byText(text, !!opt.exact);
    for(const el of els){ const r=el.getBoundingClientRect();
      if(opt.minY!=null && r.top<=opt.minY) continue;
      if(opt.maxY!=null && r.top>=opt.maxY) continue;
      el.click(); return true; } return false; },
  // 杀新手引导:点掉所有 y>minY(不在顶部工具栏)的"下一步/完成/我知道了/跳过"——靠物理坐标过滤,文字易失效
  killGuides(minY){ let n=0; for(const t of ['下一步','完成','我知道了','知道了','跳过','我知道','确定了']){
    for(const el of window.__jp.byText(t,true)){ const r=el.getBoundingClientRect(); if(r.top>minY){ try{el.click(); n++;}catch(e){} } } } return n; },
  setVal(el, val){ if(!el) return false; el.focus();
    const proto = el.tagName==='TEXTAREA'? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto,'value').set; setter.call(el, val);
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; },
  fillFirst(sel, val){ const el=window.__jp.all(sel).find(e=>window.__jp.vis(e)); return window.__jp.setVal(el, val); },
  fillLast(sel, val){ const els=window.__jp.all(sel).filter(e=>window.__jp.vis(e)); return window.__jp.setVal(els[els.length-1], val); },
  fillPlaceholder(ph, val){ const el=window.__jp.all('input,textarea').find(e=>window.__jp.vis(e)&&(e.placeholder||'').includes(ph)); return window.__jp.setVal(el, val); },
  // 灌正文:番茄是 Quill(.ql-editor)/ProseMirror/contenteditable;按段落建 <p>(textContent 安全),
  // 触发 input,平台据此自动存草稿。清空用 removeChild,不碰 innerHTML。
  setEditor(sels, text){ let ed=null; for(const s of sels){ ed=window.__jp.all(s).find(e=>window.__jp.vis(e)); if(ed) break; }
    if(!ed) return false; ed.focus();
    while(ed.firstChild) ed.removeChild(ed.firstChild);
    const paras = String(text).split(/\n+/).map(s=>s.trim()).filter(Boolean);
    if(paras.length){ for(const p of paras){ const d=document.createElement('p'); d.textContent=p; ed.appendChild(d); } }
    else { ed.textContent = String(text); }
    ed.dispatchEvent(new InputEvent('input',{bubbles:true})); ed.dispatchEvent(new Event('change',{bubbles:true})); return true; },
  // 同 setEditor,但也钻进同源 iframe 找编辑器(公众号图文正文常在 UEditor 的 <iframe> 里)
  setEditorDeep(sels, text){ if(window.__jp.setEditor(sels, text)) return true;
    for(const f of document.querySelectorAll('iframe')){ try{ const d=f.contentDocument; if(!d) continue;
      for(const s of sels.concat(['body'])){ const ed=[...d.querySelectorAll(s)].find(e=>e); if(!ed) continue;
        if(ed.focus) ed.focus(); while(ed.firstChild) ed.removeChild(ed.firstChild);
        const paras=String(text).split(/\n+/).map(x=>x.trim()).filter(Boolean);
        if(paras.length){ for(const p of paras){ const el=d.createElement('p'); el.textContent=p; ed.appendChild(el); } } else { ed.textContent=String(text); }
        ed.dispatchEvent(new InputEvent('input',{bubbles:true})); return true; } }
      catch(e){} } return false; },
  exists(sel){ return window.__jp.all(sel).some(e=>window.__jp.vis(e)); },
  hasText(text){ return window.__jp.byText(text,false).length>0; },
};
true;
`

export class BrowserController {
  readonly win: BrowserWindow
  /** 当前正在自动化的页面(新标签打开时自动切到新页) */
  private cur: WebContents
  /** 可信域名白名单:只在这些站注入页面工具/稿件。杜绝 origin 混淆——把用户稿件注入到任意/钓鱼页面。 */
  private readonly allowedHosts: readonly string[]

  constructor(win: BrowserWindow, allowedHosts: readonly string[] = []) {
    this.win = win
    this.cur = win.webContents
    this.allowedHosts = allowedHosts
    this.track(win.webContents)
  }

  /** 给定页是否落在可信域名(含子域)内。白名单为空 = 回退允许(兼容旧调用)。 */
  private isTrusted(wc: WebContents = this.cur): boolean {
    if (this.allowedHosts.length === 0) return true
    let host = ""
    try { host = new URL(wc.getURL()).hostname.toLowerCase() } catch { return false }
    return this.allowedHosts.some((h) => host === h || host.endsWith("." + h))
  }

  get wc(): WebContents {
    return this.cur
  }

  private track(wc: WebContents): void {
    // 允许平台后台开新标签页(如番茄编辑页),并把「当前页」切过去
    wc.setWindowOpenHandler(() => ({ action: "allow" }))
    wc.on("did-create-window", (child) => {
      this.cur = child.webContents
      this.track(child.webContents)
    })
    // 每次 dom-ready 重注入页面工具(导航后 __jp 会丢失)——但只在可信域名注入,
    // 否则跳过:绝不给钓鱼/任意 origin 装上稿件注入能力。
    wc.on("dom-ready", () => {
      if (this.isTrusted(wc)) wc.executeJavaScript(HELPER, true).catch(() => {})
    })
  }

  /** 导航到 url 并等加载完成 + 注入工具 */
  async goto(url: string): Promise<void> {
    await this.cur.loadURL(url).catch(() => {})
    await sleep(400)
    await this.inject()
  }

  /** 手动重注入页面工具(导航/切页后调用一次保险) */
  async inject(): Promise<void> {
    if (!this.isTrusted()) return
    await this.cur.executeJavaScript(HELPER, true).catch(() => {})
  }

  /** 在当前页执行 JS,异常兜底返回 fallback(不抛) */
  async call<T>(expr: string, fallback: T): Promise<T> {
    // 安全核心:稿件填充就是经 call() 注入页面的。绝不在非可信 origin 执行——
    // origin 混淆(被诱导跳到任意页)时直接拒绝,用户稿件不会外泄到钓鱼站。
    if (!this.isTrusted()) return fallback
    try {
      const wrapped = `(()=>{ try { return (${expr}); } catch (e) { return ${JSON.stringify(fallback)}; } })()`
      return (await this.cur.executeJavaScript(wrapped, true)) as T
    } catch {
      return fallback
    }
  }

  /** 轮询直到页面内谓词为真 */
  async waitFor(expr: string, { timeout = 15000, interval = 400 } = {}): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await this.call<boolean>(expr, false)) return true
      await sleep(interval)
    }
    return false
  }

  /** 连续几轮把不在顶部(y>minY)的新手引导点掉,直到清干净 */
  async clearGuides(minY = 100, rounds = 6): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      const n = await this.call<number>(`window.__jp.killGuides(${minY})`, 0)
      if (!n) break
      await sleep(500)
    }
  }
}
