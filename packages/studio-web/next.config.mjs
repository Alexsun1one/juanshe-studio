import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // 关掉开发模式左下角的 Next.js Dev Tools 浮标(Route/Bundler/Preferences);生产构建本来就没有。
  devIndicators: false,
  output: "standalone",
  outputFileTracingRoot: join(packageRoot, "../.."),
  // 显式锁定 Turbopack 根为 monorepo 根(与 outputFileTracingRoot 对齐)。
  // 不设时 Turbopack 会从 app/ 反推 workspace root,在多 lockfile 的 pnpm monorepo 里
  // 偶发"找不到 next/package.json"→ 热重启时 build 失败崩溃(本机曾复现)。
  turbopack: {
    root: join(packageRoot, "../.."),
  },
  experimental: {
    webpackBuildWorker: false,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
