#!/usr/bin/env node
/**
 * Build self-contained Electron resources that cannot be represented by plain
 * workspace copies. The Studio API imports production dependencies at runtime,
 * so the packaged app must include a deployed node_modules tree, not only dist.
 */
import { execFileSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, "..")
const repoRoot = resolve(packageRoot, "..", "..")
const resourcesRoot = join(packageRoot, ".electron-resources")
const studioTarget = join(resourcesRoot, "app", "packages", "studio")
const pnpmCommand = "pnpm"

function run(command, args) {
  console.log(`[prepare:resources] ${command} ${args.join(" ")}`)
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  })
}

rmSync(resourcesRoot, { recursive: true, force: true })
run(pnpmCommand, [
  "--filter",
  "@juanshe/studio",
  "deploy",
  "--prod",
  "--legacy",
  "--ignore-scripts",
  studioTarget,
])

if (!existsSync(join(studioTarget, "dist", "api", "index.js"))) {
  throw new Error("deployed Studio API is missing dist/api/index.js")
}

if (!existsSync(join(studioTarget, "node_modules", "hono"))) {
  throw new Error("deployed Studio API is missing production dependency hono")
}
