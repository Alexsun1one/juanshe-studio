import { describe, expect, it } from "vitest";
import { markdownToContentDocument } from "../content/markdown-to-ast.js";
import { renderWechat } from "../platforms/wechat/renderer.js";
import {
  renderForPlatform,
  renderZhihu,
  renderXiaohongshu,
  renderX,
} from "../platforms/index.js";
import type { ContentDocument } from "../content/ast.js";

describe("markdownToContentDocument", () => {
  it("parses headings, paragraphs, quotes, lists and dividers", () => {
    const md = [
      "# 标题一",
      "",
      "第一段正文。",
      "",
      "## 小标题",
      "> 一句引用",
      "",
      "- 列表项 A",
      "- 列表项 B",
      "",
      "---",
      "",
      "1. 有序一",
      "2. 有序二",
    ].join("\n");
    const doc = markdownToContentDocument(md);
    expect(doc.title).toBe("标题一");
    // 首个一级标题被抽为 doc.title,不重复出现在 blocks。
    const types = doc.blocks.map((b) => b.type);
    expect(types).toEqual([
      "paragraph",
      "heading",
      "quote",
      "list",
      "divider",
      "list",
    ]);
    const ul = doc.blocks.find((b) => b.type === "list" && !b.ordered);
    expect(ul && ul.type === "list" ? ul.items : []).toEqual(["列表项 A", "列表项 B"]);
    const ol = doc.blocks.find((b) => b.type === "list" && b.ordered);
    expect(ol && ol.type === "list" ? ol.ordered : false).toBe(true);
  });
});

describe("renderWechat", () => {
  const doc: ContentDocument = {
    title: "测试文章",
    subtitle: "副标题",
    blocks: [
      { type: "heading", level: 2, text: "第一节" },
      { type: "paragraph", text: "这是 **加粗** 与 `代码` 的段落。" },
      { type: "quote", text: "引用一句", source: "某人" },
      { type: "list", ordered: false, items: ["甲", "乙"] },
      { type: "cta", text: "", intent: "follow" },
    ],
  };

  it("emits inline styles and no class attributes (公众号编辑器会剥 class)", () => {
    const { html } = renderWechat(doc);
    expect(html).toContain("style=");
    expect(html).not.toContain("class=");
    expect(html).not.toContain("<style");
  });

  it("renders title, heading, bold and inline code", () => {
    const { html } = renderWechat(doc);
    expect(html).toContain("测试文章");
    expect(html).toContain("第一节");
    expect(html).toContain("<strong");
    expect(html).toContain("加粗");
    expect(html).toContain("<code");
  });

  it("escapes raw html in text", () => {
    const { html } = renderWechat({ blocks: [{ type: "paragraph", text: "<script>x</script>" }] });
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("falls back to a default CTA label when text is empty", () => {
    const { html, plainText } = renderWechat(doc);
    expect(html).toContain("点个关注不迷路");
    expect(plainText).toContain("测试文章");
    expect(plainText).toContain("引用一句");
  });
});

describe("multi-platform renderers", () => {
  const doc: ContentDocument = {
    title: "标题",
    blocks: [
      { type: "heading", level: 2, text: "谜题" },
      { type: "paragraph", text: "第一句。第二句。第三句很长很长用来测试拆条逻辑是否会按句子边界切分成多条推文。" },
      { type: "list", ordered: false, items: ["甲", "乙"] },
    ],
  };

  it("renderForPlatform dispatches by platform id", () => {
    expect(renderForPlatform("wechat", doc).platform).toBe("wechat");
    expect(renderForPlatform("zhihu", doc).platform).toBe("zhihu");
    expect(renderForPlatform("xiaohongshu", doc).platform).toBe("xiaohongshu");
    expect(renderForPlatform("x", doc).platform).toBe("x");
    expect(renderForPlatform("newsletter", doc).platform).toBe("newsletter");
  });

  it("zhihu emits semantic html + markdown plainText", () => {
    const r = renderZhihu(doc);
    expect(r.html).toContain("<h1>标题</h1>");
    expect(r.html).toContain("<h2>谜题</h2>");
    expect(r.plainText).toContain("# 标题");
    expect(r.plainText).toContain("## 谜题");
  });

  it("xiaohongshu produces hashtags and short-form plainText", () => {
    const r = renderXiaohongshu(doc);
    expect(r.plainText).toContain("📖 标题");
    expect(r.plainText).toContain("#谜题");
  });

  it("newsletter emits email-friendly html and newsletter plainText", () => {
    const r = renderForPlatform("newsletter", doc);
    expect(r.html).toContain("Newsletter");
    expect(r.html).toContain("max-width:640px");
    expect(r.plainText).toContain("# 标题");
    expect(r.plainText).toContain("感谢阅读");
  });

  it("x splits long content into numbered tweets", () => {
    const longSentence = "这是一句用来撑长度的话足够长以触发按句子边界拆分。";
    const longDoc: ContentDocument = {
      title: "长内容",
      blocks: [{ type: "paragraph", text: longSentence.repeat(20) }],
    };
    const r = renderX(longDoc);
    expect(r.plainText).toMatch(/\d+\/\d+/);
    expect(r.html).toContain("1/");
  });
});
