#!/usr/bin/env node
/**
 * 卷舍 打包前自检(go / no-go)
 *
 * 在 electron-builder 真正打包前跑一遍,把"上线雷"固化成可重复的闸门:
 *   ① 个人/私有内容泄漏闸 —— 出包面绝不能出现任何个人书名(用户硬规则)
 *   ② 内嵌产物齐全 —— studio / core / engine 的 dist + studio-web 的 .next/standalone
 *   ③ 首启工作区模板干净 —— 有 hardwrite.json、无任何 books(空书架 → 新手引导)
 *   ④ core 在途告警 —— core/src 脏时 dist 可能过期(本仓库高频坑)
 *
 * 退出码:0 = 可打包;1 = 存在阻断项。告警(warn)不阻断,但会显眼提示。
 * 用法:node scripts/preflight.mjs   (或 pnpm --filter @juanshe/studio-electron preflight)
 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..", "..", "..") // packages/studio-electron/scripts → Autow-source
const sib = resolve(repoRoot, "..", "Autow") // 同级运行/模板目录

// 绝不允许出现在【出包面】的字样(个人书名/角色名)。私有项目名用环境变量注入,不要写进公开仓库。
const FORBIDDEN = (process.env.JUANSHE_PREFLIGHT_FORBIDDEN || "")
  .split(/[,\n]/)
  .map((s) => s.trim())
  .filter(Boolean)

let blocking = 0
let warnings = 0
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const bad = (m) => { console.log(`  \x1b[31m✗ ${m}\x1b[0m`); blocking++ }
const warn = (m) => { console.log(`  \x1b[33m! ${m}\x1b[0m`); warnings++ }
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`)

// ── ② 内嵌产物齐全 ──────────────────────────────────────────
head("② 内嵌产物")
const dists = [
  ["studio 后端", "packages/studio/dist/api/index.js"],
  ["core 核心", "packages/core/dist/index.js"],
  ["engine 引擎", "packages/engine/dist/index.js"],
]
for (const [label, rel] of dists) {
  const p = join(repoRoot, rel)
  existsSync(p) ? ok(`${label} dist 就绪`) : bad(`${label} 缺失:${rel} —— 先 build`)
}
const standalone = join(repoRoot, "packages/studio-web/.next/standalone")
const staticDir = join(repoRoot, "packages/studio-web/.next/static")
existsSync(standalone)
  ? ok("studio-web .next/standalone 就绪")
  : bad("studio-web .next/standalone 缺失 —— 跑 `pnpm --filter studio-web build`(需 output:standalone)")
existsSync(staticDir) ? ok("studio-web .next/static 就绪") : warn(".next/static 缺失,前端静态资源可能不全")

// ── ③ 首启工作区模板干净 ────────────────────────────────────
head("③ 首启工作区模板")
const tplCandidates = [join(sib, "workspace-template"), join(repoRoot, "workspace-template")]
const tpl = tplCandidates.find((p) => existsSync(join(p, "hardwrite.json")))
if (!tpl) {
  bad(`找不到带 hardwrite.json 的 workspace-template(查过:${tplCandidates.join(" , ")})`)
} else {
  ok(`模板:${tpl}`)
  const booksDir = join(tpl, "books")
  if (existsSync(booksDir)) {
    const books = readdirSync(booksDir).filter((n) => !n.startsWith("."))
    books.length === 0
      ? ok("模板 books/ 为空(空书架 → 触发新手引导)")
      : bad(`模板含 ${books.length} 本书,装机会带入:${books.join(", ")} —— 清空 books/`)
  } else {
    ok("模板无 books/ 目录(空书架 → 触发新手引导)")
  }
}

// ── ① 个人内容泄漏闸(最重要)────────────────────────────────
head("① 个人内容泄漏闸(出包面)")
// 只扫【真正会进包】的面:三个 dist(排除 __tests__/test/map/d.ts)+ studio-web 源(app/components/lib)
const scanGlobs = [
  "packages/studio/dist",
  "packages/core/dist",
  "packages/engine/dist",
  "packages/studio-web/app",
  "packages/studio-web/components",
  "packages/studio-web/lib",
]
let leaks = []
for (const term of FORBIDDEN) {
  let hits = ""
  try {
    // grep -rIl:只列文件名;-I 跳二进制。排除测试/产物噪声。
    hits = execFileSync(
      "grep",
      [
        "-rIl",
        "--exclude-dir=__tests__",
        "--exclude=*.test.*",
        "--exclude=*.spec.*",
        "--exclude=*.map",
        "--exclude=*.d.ts",
        "-e",
        term,
        ...scanGlobs.map((g) => join(repoRoot, g)),
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    )
  } catch {
    hits = "" // grep 无匹配时退出码 1 → 视为干净
  }
  const files = hits.split("\n").map((s) => s.trim()).filter(Boolean)
  if (files.length) leaks.push({ term, files })
}
if (leaks.length === 0) {
  ok(`出包面无任何个人字样(扫了 ${FORBIDDEN.length} 个词 × ${scanGlobs.length} 个目录)`)
} else {
  for (const { term, files } of leaks) {
    bad(`出包面出现「${term}」于 ${files.length} 个文件:`)
    for (const f of files.slice(0, 8)) console.log(`      ${f.replace(repoRoot + "/", "")}`)
    if (files.length > 8) console.log(`      …还有 ${files.length - 8} 个`)
  }
}

// ── ④ core 在途告警 ─────────────────────────────────────────
head("④ core dist 新鲜度")
try {
  const dirty = execFileSync("git", ["status", "--porcelain", "packages/core/src"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim()
  if (dirty) {
    const n = dirty.split("\n").length
    warn(`core/src 有 ${n} 处未提交改动 —— 若改动应进包,需先 \`cd packages/core && tsc\` 重建 dist(注意别打包在途半成品)`)
  } else {
    ok("core/src 干净,dist 与源一致")
  }
} catch {
  warn("无法读取 git 状态(非 git 仓库?),请手动确认 core dist 是否最新")
}

// ── 结论 ────────────────────────────────────────────────────
head("结论")
if (blocking > 0) {
  console.log(`\x1b[31m✗ NO-GO:${blocking} 个阻断项${warnings ? `(另有 ${warnings} 个告警)` : ""},修掉后再打包。\x1b[0m\n`)
  process.exit(1)
} else if (warnings > 0) {
  console.log(`\x1b[33m⚠ GO(带 ${warnings} 个告警):可打包,但请先确认上面的告警。\x1b[0m\n`)
  process.exit(0)
} else {
  console.log(`\x1b[32m✓ GO:出包面干净、产物齐全,可以打包。\x1b[0m\n`)
  process.exit(0)
}
