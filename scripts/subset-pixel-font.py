#!/usr/bin/env python3
"""卷舍像素 UI 字体 unicode-range 切片脚本(可重复执行,产物路径固定)。

背景:全站 UI 默认字体「缝合像素 12px Proportional zh_hans」原先是 602KB 单体
woff2,首访必须整只下完才翻转像素。治本 = 按 unicode-range 切两片:
  slice1 = ASCII/Latin-1 + 通用标点/箭头/技术符号(⌘)/几何图形 + CJK 标点/全角
           + GB2312 一级(~3755 高频简体字)——首屏 UI 短文本几乎全部命中,
           root layout.tsx 只 preload 这一片;
  slice2 = 原字体 cmap 里其余全部字符(GB2312 二级/生僻/扩展),按需懒加载。

授权(OFL Reserved Font Name):上游字体 name 表 nameID 0 写明
  "Copyright (c) 2022, TakWolf (https://takwolf.com), with Reserved Font Name
  'Fusion Pixel'."(SIL OFL 1.1,nameID 13/14)。
切片(subset)属于 OFL 定义的 Modified Version,按 OFL §3 不得继续用 RFN 命名,
故切片后 family 改名为 'Juanshe Pixel 12px SC'(名表 1/3/4/6/16/17 同步改写,
版权与许可证记录 nameID 0/13/14 原样保留以满足 OFL 随附义务)。
globals.css 的 --font-pixel-ui 与本目录 index.css 均使用新 family 名。

运行:python3 scripts/subset-pixel-font.py   (依赖 fontTools>=4.x + brotli,本机已装)
产物:packages/studio-web/public/fonts/fusion-pixel/files/juanshe-pixel-12px-sc-slice{1,2}-400-normal.woff2
      packages/studio-web/public/fonts/fusion-pixel/index.css(整文件生成,勿手改)
源字体:files/ 里的 602KB 单体已删除;脚本会自动从 git 历史恢复源字体到临时文件再切。
"""

from __future__ import annotations

import io
import subprocess
import sys
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / "packages/studio-web/public/fonts/fusion-pixel"
FILES_DIR = FONT_DIR / "files"
INDEX_CSS = FONT_DIR / "index.css"

SRC_REL = (
    "packages/studio-web/public/fonts/fusion-pixel/files/"
    "fusion-pixel-12px-proportional-sc-latin-400-normal.woff2"
)
SRC_LOCAL = ROOT / SRC_REL

NEW_FAMILY = "Juanshe Pixel 12px SC"
NEW_PS_NAME = "JuanshePixel12pxSC-Regular"

SLICE1_OUT = FILES_DIR / "juanshe-pixel-12px-sc-slice1-400-normal.woff2"
SLICE2_OUT = FILES_DIR / "juanshe-pixel-12px-sc-slice2-400-normal.woff2"
SLICE1_HREF = "./files/juanshe-pixel-12px-sc-slice1-400-normal.woff2"

SLICE1_SIZE_BUDGET = 250 * 1024  # 验收红线:preload 片 ≤ 250KB

# UI 高频抽样串:必须全部命中 slice1(⌘ 属 U+2300-23FF 杂项技术符号,
# 为它把该块整体并入 slice1——快捷键提示是 UI 常客,不能落到懒加载片)。
SAMPLE_UI_TEXT = "卷舍工作台设置继续创作批量连写0123⌘K像素编辑部"

# slice1 的请求区块(与实际 cmap 取交集后才是真正塞进去的字符)
SLICE1_BLOCKS = [
    (0x0020, 0x00FF),  # ASCII + Latin-1 可见区
    (0x2000, 0x206F),  # 通用标点(— … ‘ ’ “ ”)
    (0x2190, 0x21FF),  # 箭头
    (0x2300, 0x23FF),  # 杂项技术符号(⌘ ⌥ ⌃ ⎋)
    (0x2460, 0x24FF),  # 带圈字母数字
    (0x25A0, 0x26FF),  # 几何图形 + 杂项符号(■ ▲ ● ☆)
    (0x2700, 0x27BF),  # Dingbats(✓ ✗ ✦)
    (0x3000, 0x303F),  # CJK 标点(、。「」《》)
    (0xFF00, 0xFFEF),  # 半角/全角形式(:!?)
]


def gb2312_level1() -> set[int]:
    """用 codecs 离线推导 GB2312 一级字表:区位 0xB0A1-0xD7F9,共 3755 字,确定性。"""
    chars: set[int] = set()
    for hi in range(0xB0, 0xD8):
        lo_end = 0xF9 if hi == 0xD7 else 0xFE
        for lo in range(0xA1, lo_end + 1):
            try:
                chars.add(ord(bytes((hi, lo)).decode("gb2312")))
            except UnicodeDecodeError:
                continue
    assert len(chars) == 3755, f"GB2312 一级字表应为 3755 字,实得 {len(chars)}"
    return chars


def load_source_font_bytes() -> bytes:
    """优先读本地源字体;已删除时从 git 历史恢复(保证脚本可重复执行)。"""
    if SRC_LOCAL.exists():
        return SRC_LOCAL.read_bytes()
    rev = subprocess.run(
        ["git", "log", "--all", "--format=%H", "-1", "--", SRC_REL],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()
    if not rev:
        sys.exit(f"源字体不在本地也不在 git 历史: {SRC_REL}")
    blob = subprocess.run(
        ["git", "show", f"{rev}:{SRC_REL}"],
        cwd=ROOT, capture_output=True, check=True,
    ).stdout
    print(f"· 源字体已从 git {rev[:10]} 恢复({len(blob) / 1024:.0f}KB)")
    return blob


def rename_family(font: TTFont) -> None:
    """改写名表 family 相关记录(OFL RFN 合规);版权/许可证(0/13/14)不动。"""
    name = font["name"]
    rewrites = {
        1: NEW_FAMILY,
        3: f"{NEW_PS_NAME};juanshe-subset",
        4: f"{NEW_FAMILY} Regular",
        6: NEW_PS_NAME,
        16: NEW_FAMILY,
        17: "Regular",
    }
    for rec in list(name.names):
        if rec.nameID in rewrites:
            name.setName(
                rewrites[rec.nameID], rec.nameID,
                rec.platformID, rec.platEncID, rec.langID,
            )


def subset_to(src: bytes, unicodes: set[int], out: Path) -> set[int]:
    """切一片 woff2,返回该片实际 cmap 码点集合。"""
    opts = Options()
    opts.name_IDs = ["*"]        # 名表全保留(rename_family 再精确改写 family 项)
    opts.name_languages = ["*"]  # mac/win 双平台记录都留,版权与许可证不丢
    font = TTFont(io.BytesIO(src))
    subsetter = Subsetter(options=opts)
    subsetter.populate(unicodes=sorted(unicodes))
    subsetter.subset(font)
    rename_family(font)
    font.flavor = "woff2"
    out.parent.mkdir(parents=True, exist_ok=True)
    font.save(out)
    cmap = set(TTFont(out).getBestCmap())
    font.close()
    return cmap


def to_unicode_range(codepoints: set[int]) -> str:
    """把码点集合压成精确的 CSS unicode-range(连续段合并),每 16 项折一行。"""
    pts = sorted(codepoints)
    spans: list[str] = []
    start = prev = pts[0]
    for cp in pts[1:] + [None]:  # type: ignore[list-item]
        if cp is not None and cp == prev + 1:
            prev = cp
            continue
        spans.append(f"U+{start:04X}" if start == prev else f"U+{start:04X}-{prev:04X}")
        if cp is not None:
            start = prev = cp
    lines = [",".join(spans[i : i + 16]) for i in range(0, len(spans), 16)]
    return ",\n    ".join(lines)


def write_index_css(slice1_cmap: set[int], slice2_cmap: set[int]) -> None:
    css = f"""\
/* 卷舍像素 UI 字体(unicode-range 切片版)
   ⚠ 本文件由 scripts/subset-pixel-font.py 整体生成,勿手改;改策略请改脚本重跑。

   上游:缝合像素 Fusion Pixel 12px Proportional zh_hans(TakWolf,
   https://fusion-pixel-font.takwolf.com),SIL OFL 1.1。
   授权结论:字体 name 表 nameID 0 写明 "with Reserved Font Name 'Fusion Pixel'",
   即 OFL 带 RFN;切片属 OFL Modified Version,按 §3 不得沿用 RFN 命名,
   故 family 改名 'Juanshe Pixel 12px SC'(名表已同步改写,版权/许可证记录保留;
   globals.css 的 --font-pixel-ui 使用同名)。

   切片策略:slice1 = ASCII/Latin-1 + 通用标点/箭头/⌘ 技术符号/几何图形
   + CJK 标点/全角 + GB2312 一级(~3755 高频字),首屏 UI 基本全命中;
   root layout.tsx 只对 slice1 做 <link rel="preload" as="font">,
   两边 URL 必须保持逐字一致。slice2 = 其余全部字符,unicode-range 按需懒加载。
   font-display 维持 swap:这是全站 UI 默认字体,block 只会让首屏文字隐身 3s
   后照样跳变,optional 会让首访整页失去像素世界观——swap+preload 是正确组合。
   src 只留 woff2:files/ 里没有 .woff,旧回退是 404 死链。 */
@font-face {{
  font-family: '{NEW_FAMILY}';
  font-style: normal;
  font-display: swap;
  font-weight: 400;
  src: url({SLICE1_HREF}) format('woff2');
  unicode-range: {to_unicode_range(slice1_cmap)};
}}
@font-face {{
  font-family: '{NEW_FAMILY}';
  font-style: normal;
  font-display: swap;
  font-weight: 400;
  src: url(./files/{SLICE2_OUT.name}) format('woff2');
  unicode-range: {to_unicode_range(slice2_cmap)};
}}
"""
    INDEX_CSS.write_text(css, encoding="utf-8")


def main() -> None:
    src = load_source_font_bytes()
    orig_cmap = set(TTFont(io.BytesIO(src)).getBestCmap())
    print(f"· 源字体 cmap {len(orig_cmap)} 字符,{len(src) / 1024:.0f}KB")

    slice1_request = gb2312_level1()
    for lo, hi in SLICE1_BLOCKS:
        slice1_request.update(range(lo, hi + 1))

    slice1_cmap = subset_to(src, slice1_request & orig_cmap, SLICE1_OUT)
    slice2_cmap = subset_to(src, orig_cmap - slice1_cmap, SLICE2_OUT)
    write_index_css(slice1_cmap, slice2_cmap)

    # ———— 验收断言 ————
    s1_size = SLICE1_OUT.stat().st_size
    s2_size = SLICE2_OUT.stat().st_size
    assert s1_size <= SLICE1_SIZE_BUDGET, (
        f"slice1 {s1_size / 1024:.0f}KB 超出预算 {SLICE1_SIZE_BUDGET / 1024:.0f}KB"
    )
    assert slice1_cmap | slice2_cmap == orig_cmap, "两片 cmap 并集 ≠ 原字体 cmap(有丢字)"
    assert slice1_cmap.isdisjoint(slice2_cmap), "两片 cmap 有重叠"
    missed = [ch for ch in SAMPLE_UI_TEXT if ord(ch) not in slice1_cmap]
    assert not missed, f"UI 高频抽样未全命中 slice1,落空: {missed}"

    print(f"· slice1 {SLICE1_OUT.name}: {s1_size / 1024:.1f}KB,{len(slice1_cmap)} 字符")
    print(f"· slice2 {SLICE2_OUT.name}: {s2_size / 1024:.1f}KB,{len(slice2_cmap)} 字符")
    print(f"· index.css 已生成({INDEX_CSS.stat().st_size / 1024:.1f}KB);全部断言通过 ✓")


if __name__ == "__main__":
    main()
