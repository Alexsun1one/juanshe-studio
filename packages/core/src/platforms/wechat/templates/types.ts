/**
 * 公众号模板系统 — 同一份 ContentAST 可以套不同 template 渲染出不同视觉。
 *
 * Template = 一组(block-type → inline-style HTML)的渲染函数 + 文档级配置(背景/字体/标题样式)。
 * 公众号编辑器会剥掉 <style>/class,所有样式必须 inline。
 */

import type { ContentBlock, ContentDocument } from "../../../content/ast.js";

/** 文档级"封皮" — 包裹整个 body,提供字体/底色 */
export interface TemplateDocShell {
  /** 整个文档的最外层 section style 字符串 */
  rootStyle: string;
  /** 标题(doc.title)样式 */
  titleStyle: string;
  /** 副标题(doc.subtitle)样式 */
  subtitleStyle: string;
}

/** 模板接口 — 每种 block 类型对应一个 inline-style HTML 渲染函数 */
export interface WechatTemplate {
  /** 模板唯一 id(用于 URL / API) */
  readonly id: string;
  /** 显示名 */
  readonly label: string;
  /** 一句话风格描述,UI 下拉里看到 */
  readonly tagline: string;
  /** 文档级"封皮" */
  shell(doc: ContentDocument): TemplateDocShell;
  /** 单个 block → inline HTML */
  renderBlock(block: ContentBlock, index: number, total: number): string;
}

/** 公共工具:HTML 转义 */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 行内格式 — 所有 template 共用。
 * 支持:**粗体** / *斜体* / `行内码` / ==高亮==
 * highlight 颜色由模板传入(每个 template 用自己的品牌色)。
 */
export function inline(s: string, opts?: { highlightColor?: string; accent?: string }): string {
  const hl = opts?.highlightColor ?? "#FFE45A";
  const accent = opts?.accent ?? "#5b5bd6";
  let out = esc(s);
  // ==高亮== 在 esc 之后处理(因为 == 没被转义)
  out = out.replace(
    /==([^=]+)==/g,
    `<mark style="background:linear-gradient(180deg,transparent 55%,${hl} 55%);padding:0 2px;color:inherit;font-weight:600;">$1</mark>`,
  );
  out = out.replace(
    /`([^`]+)`/g,
    `<code style="font-family:SFMono-Regular,Consolas,monospace;font-size:14px;background:#f2f2f7;color:${accent};padding:1px 5px;border-radius:4px;">$1</code>`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong style="font-weight:700;color:#1f1f24;">$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em style="font-style:italic;">$2</em>');
  return out;
}
