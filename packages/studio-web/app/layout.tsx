import type { Metadata, Viewport } from "next"
import Script from "next/script"
import { Analytics } from "@vercel/analytics/next"
import { ThemeProvider } from "next-themes"
import { LocaleProvider } from "@/lib/i18n"
import { WorkspaceProvider } from "@/lib/workspace-context"
import { SwrProvider } from "@/components/providers/swr-provider"
import { Toaster } from "@/components/ui/sonner"
import "./globals.css"
import "./design.css"
import "./themes.css"
import "./kit.css"
import "./agent-avatars.css"

// 字体策略(中文优先 · 自托管):
// Inter/Lora(拉丁)+ 思源黑体/宋体 Noto Sans/Serif SC(中文)全部自托管在 public/fonts,
// 经 <link> 引入(见下方 <body>),@fontsource variable 版按 unicode-range 懒加载。
// 这样不依赖被墙的 fonts.gstatic.com → Turbopack 可冷构建;字体族变量在 globals.css :root 定义。
const FONT_STYLESHEETS = [
  "/fonts/inter/index.css",
  "/fonts/lora/index.css",
  "/fonts/noto-sans-sc/index.css",
  "/fonts/noto-serif-sc/index.css",
  "/fonts/fusion-pixel/index.css", // 缝合像素 12px 简体 — UI 短文本可爱像素感(清晰),见 --font-pixel-ui
  "/fonts/pixel/index.css",
] as const

// 缝合像素是全站 UI 默认字体(design.css .app),但它是 602KB 单体 woff2、未按
// unicode-range 切片:不 preload 就得等 CSS 下载解析后才排队,首访整页先 PingFang
// 再翻转像素。preload 让它与样式表并行下载,压缩 swap 跳变窗口。
// URL 必须与 fusion-pixel/index.css 的 src 逐字一致,否则缓存 key 不同会白下载两份;
// crossOrigin 必填——字体一律按 CORS 匿名模式拉取,缺了 preload 不会被复用。
const PIXEL_FONT_PRELOAD_HREF =
  "/fonts/fusion-pixel/files/fusion-pixel-12px-proportional-sc-latin-400-normal.woff2"

const enableVercelAnalytics =
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PUBLIC_VERCEL_ANALYTICS === "1"

export const metadata: Metadata = {
  title: "卷舍 · AI 编辑部",
  description:
    "像素时代的 AI 写作工作室 — 17 位编辑部角色协作完成从选题到发布的全流程长篇创作",
  icons: {
    icon: "/brand/brand-icon.png",
    apple: "/brand/apple-icon.png",
  },
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7fb" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0f1c" },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning className="bg-background">
      <body className="font-sans antialiased">
        {/* 主题色防闪:beforeInteractive 在页面交互前加载执行,把 localStorage 选的主题色
            写到 <html data-cj-theme>,避免首屏柔紫闪变。脚本是 public/cj-theme-init.js 静态文件。 */}
        <Script src="/cj-theme-init.js" strategy="beforeInteractive" />
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
          href={PIXEL_FONT_PRELOAD_HREF}
        />
        {FONT_STYLESHEETS.map((href) => (
          <link key={href} rel="stylesheet" href={href} precedence="default" />
        ))}
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange={false}
        >
          <LocaleProvider>
            <SwrProvider>
              <WorkspaceProvider>
                {children}
                <Toaster />
              </WorkspaceProvider>
            </SwrProvider>
          </LocaleProvider>
        </ThemeProvider>
        {enableVercelAnalytics && <Analytics />}
      </body>
    </html>
  )
}
