#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(repoRoot, "dist");
const releaseRoot = join(distRoot, "Juanshe-mac");
const appName = "卷舍";
const appBundle = join(releaseRoot, `${appName}.app`);
const contentsDir = join(appBundle, "Contents");
const macosDir = join(contentsDir, "MacOS");
const resourcesDir = join(contentsDir, "Resources");
const packagedRoot = join(resourcesDir, "app");
const zipPath = join(distRoot, "Juanshe-mac.zip");
const dmgPath = join(distRoot, "Juanshe-mac.dmg");

const env = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: "1",
};

function log(message) {
  console.log(`[package:mac] ${message}`);
}

function run(command, args, options = {}) {
  log(`${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    ...options,
  });
}

function requirePath(path, label = path) {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing: ${path}`);
  }
}

function copyPath(from, to) {
  requirePath(from);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, {
    recursive: true,
    dereference: false,
    force: true,
    preserveTimestamps: true,
  });
}

function copyPackage(packagePath, entries) {
  for (const entry of entries) {
    const source = join(repoRoot, packagePath, entry);
    if (!existsSync(source)) {
      continue;
    }
    copyPath(source, join(packagedRoot, packagePath, entry));
  }
}

function isPathInside(path, root) {
  const inner = relative(root, path);
  return inner === "" || (!inner.startsWith("..") && !isAbsolute(inner));
}

function resolveForPackaging(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function relativizeInternalSymlinks(
  root,
  sourceRoot = root,
  packagedSourceRoot = root,
  additionalMappings = [],
) {
  const rootPath = resolveForPackaging(root);
  const pathMappings = [
    {
      sourceRootPath: resolveForPackaging(sourceRoot),
      packagedSourceRootPath: resolveForPackaging(packagedSourceRoot),
    },
    ...additionalMappings.map((mapping) => ({
      sourceRootPath: resolveForPackaging(mapping.sourceRoot),
      packagedSourceRootPath: resolveForPackaging(mapping.packagedSourceRoot),
    })),
  ];
  let rewritten = 0;

  function mapPackageTarget(targetPath) {
    for (const mapping of pathMappings) {
      if (isPathInside(targetPath, mapping.sourceRootPath)) {
        return resolve(
          mapping.packagedSourceRootPath,
          relative(mapping.sourceRootPath, targetPath),
        );
      }
    }
    return targetPath;
  }

  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const entryPath = join(dir, entry);
      const entryStat = lstatSync(entryPath);

      if (entryStat.isSymbolicLink()) {
        const target = readlinkSync(entryPath);
        if (isAbsolute(target)) {
          const targetPath = resolveForPackaging(target);
          const mappedTargetPath = mapPackageTarget(targetPath);

          if (!isPathInside(mappedTargetPath, rootPath)) {
            throw new Error(`Refusing to package external symlink: ${entryPath} -> ${target}`);
          }

          let relativeTarget = relative(dirname(entryPath), mappedTargetPath);
          if (!relativeTarget.startsWith(".")) {
            relativeTarget = `./${relativeTarget}`;
          }
          unlinkSync(entryPath);
          symlinkSync(relativeTarget, entryPath);
          rewritten += 1;
        }
        continue;
      }

      if (entryStat.isDirectory()) {
        walk(entryPath);
      }
    }
  }

  walk(rootPath);
  if (rewritten > 0) {
    log(`rewrote ${rewritten} internal symlink(s) under ${root}`);
  }
}

function assertNoAbsoluteSymlinks(root) {
  const rootPath = resolveForPackaging(root);
  const absoluteSymlinks = [];

  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const entryPath = join(dir, entry);
      const entryStat = lstatSync(entryPath);

      if (entryStat.isSymbolicLink()) {
        const target = readlinkSync(entryPath);
        if (isAbsolute(target)) {
          absoluteSymlinks.push(`${entryPath} -> ${target}`);
        }
        continue;
      }

      if (entryStat.isDirectory()) {
        walk(entryPath);
      }
    }
  }

  walk(rootPath);

  if (absoluteSymlinks.length > 0) {
    throw new Error(
      `Package still contains ${absoluteSymlinks.length} absolute symlink(s):\n${absoluteSymlinks
        .slice(0, 20)
        .join("\n")}`,
    );
  }
}

function deployStudioBackend() {
  const deployRoot = realpathSync(mkdtempSync(join(tmpdir(), "juanshe-studio-deploy-")));
  const targetRoot = join(packagedRoot, "packages/studio");
  const studioSourceRoot = join(repoRoot, "packages/studio");
  try {
    run("pnpm", [
      "--filter",
      "@juanshe/studio",
      "deploy",
      "--prod",
      "--legacy",
      deployRoot,
    ]);
    relativizeInternalSymlinks(deployRoot, deployRoot, deployRoot, [
      { sourceRoot: studioSourceRoot, packagedSourceRoot: deployRoot },
    ]);
    copyPath(deployRoot, targetRoot);
    relativizeInternalSymlinks(targetRoot, deployRoot, targetRoot, [
      { sourceRoot: studioSourceRoot, packagedSourceRoot: targetRoot },
    ]);
  } finally {
    rmSync(deployRoot, { recursive: true, force: true });
  }
}

function rewriteStudioWebStandaloneSymlinks() {
  const sourceStandaloneRoot = join(repoRoot, "packages/studio-web/.next/standalone");
  const packagedStandaloneRoot = join(packagedRoot, "packages/studio-web/.next/standalone");
  relativizeInternalSymlinks(
    packagedStandaloneRoot,
    sourceStandaloneRoot,
    packagedStandaloneRoot,
  );
}

function writeText(path, contents, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  if (mode) {
    chmodSync(path, mode);
  }
}

function copyNextStaticIntoStandalone() {
  const webRoot = join(packagedRoot, "packages/studio-web");
  const standaloneRoot = join(webRoot, ".next/standalone");
  const staticSource = join(repoRoot, "packages/studio-web/.next/static");
  const publicSource = join(repoRoot, "packages/studio-web/public");
  const nestedWebRoot = join(standaloneRoot, "packages/studio-web");
  const standaloneWebRoot = existsSync(nestedWebRoot) ? nestedWebRoot : standaloneRoot;

  if (existsSync(staticSource)) {
    copyPath(staticSource, join(webRoot, ".next/static"));
    copyPath(staticSource, join(standaloneWebRoot, ".next/static"));
  }

  if (existsSync(publicSource)) {
    copyPath(publicSource, join(webRoot, "public"));
    copyPath(publicSource, join(standaloneWebRoot, "public"));
  }
}

function writeInfoPlist() {
  writeText(
    join(contentsDir, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${appName}</string>
  <key>CFBundleExecutable</key>
  <string>${appName}</string>
  <key>CFBundleIdentifier</key>
  <string>com.juanshe.studio</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.3.10</string>
  <key>CFBundleVersion</key>
  <string>1.3.10</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`,
  );
}

function writeLauncher() {
  writeText(
    join(macosDir, appName),
    `#!/usr/bin/env bash
set -u

APP_ROOT="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
NODE="$APP_ROOT/runtime/node"
if [ ! -x "$NODE" ]; then
  NODE="$(command -v node || true)"
fi

if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  /usr/bin/osascript -e 'display dialog "卷舍 could not find a Node runtime." buttons {"OK"} default button "OK"' >/dev/null 2>&1 || true
  exit 1
fi

DATA_DIR="\${JUANSHE_DATA_DIR:-$HOME/Library/Application Support/卷舍}"
WORKSPACE_DIR="\${JUANSHE_WORKSPACE:-\${HARDWRITE_PROJECT_ROOT:-$DATA_DIR/workspace}}"
LOG_DIR="\${JUANSHE_LOG_DIR:-$HOME/Library/Logs/卷舍}"
mkdir -p "$DATA_DIR" "$WORKSPACE_DIR" "$LOG_DIR"

ENV_FILE="$DATA_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

ensure_workspace() {
  mkdir -p "$WORKSPACE_DIR/books" "$WORKSPACE_DIR/radar" "$WORKSPACE_DIR/.hardwrite"

  if [ ! -f "$WORKSPACE_DIR/hardwrite.json" ]; then
    cat > "$WORKSPACE_DIR/hardwrite.json" <<'JSON'
{
  "name": "卷舍 Workspace",
  "version": "0.1.0",
  "language": "zh",
  "llm": {
    "provider": "openai",
    "service": "custom",
    "configSource": "studio",
    "baseUrl": "",
    "model": "",
    "apiFormat": "chat",
    "stream": true
  },
  "notify": [],
  "inputGovernanceMode": "v2",
  "daemon": {
    "schedule": {
      "radarCron": "0 */6 * * *",
      "writeCron": "*/15 * * * *"
    },
    "maxConcurrentBooks": 3
  }
}
JSON
  fi

  if [ ! -f "$WORKSPACE_DIR/.env" ]; then
    cat > "$WORKSPACE_DIR/.env" <<'ENV'
# Optional provider configuration for 卷舍.
# Keep real keys on this machine; they are never bundled into the app.
# OPENAI_API_KEY=
# JUANSHE_API_BASE=
ENV
  fi

  if [ ! -f "$WORKSPACE_DIR/.gitignore" ]; then
    cat > "$WORKSPACE_DIR/.gitignore" <<'GITIGNORE'
.env
.hardwrite/secrets.json
node_modules/
.DS_Store
GITIGNORE
  fi

  if [ ! -f "$WORKSPACE_DIR/README.md" ]; then
    cat > "$WORKSPACE_DIR/README.md" <<'README'
# 卷舍 Workspace

这里是卷舍桌面版的本地小说工作区。

- books/ 保存作品、章节、大纲、伏笔和运行状态。
- hardwrite.json 保存工作区配置。
- .env 可放置本机专用的模型服务配置，不会被打包分发。

双击卷舍.app 会自动启动本地 API 和写作台。
README
  fi
}

ensure_workspace

export NODE_ENV=production
export HARDWRITE_STUDIO_PORT="\${JUANSHE_API_PORT:-\${HARDWRITE_STUDIO_PORT:-4567}}"
export AUTOW_STUDIO_WEB_HOST="\${JUANSHE_WEB_HOST:-\${AUTOW_STUDIO_WEB_HOST:-127.0.0.1}}"
export HOSTNAME="$AUTOW_STUDIO_WEB_HOST"
export AUTOW_STUDIO_WEB_PORT="\${JUANSHE_WEB_PORT:-\${AUTOW_STUDIO_WEB_PORT:-3100}}"
export PORT="$AUTOW_STUDIO_WEB_PORT"
export HARDWRITE_PROJECT_ROOT="$WORKSPACE_DIR"
USER_JUANSHE_API_BASE="\${JUANSHE_API_BASE:-\${HARDWRITE_API_BASE:-}}"
USER_NEXT_PUBLIC_JUANSHE_API_BASE="\${NEXT_PUBLIC_JUANSHE_API_BASE:-\${NEXT_PUBLIC_HARDWRITE_API_BASE:-}}"
export HARDWRITE_BACKEND_TIMEOUT_MS="\${JUANSHE_BACKEND_TIMEOUT_MS:-\${HARDWRITE_BACKEND_TIMEOUT_MS:-10000}}"
export NEXT_TELEMETRY_DISABLED=1

BACKEND_PID_FILE="$DATA_DIR/backend.pid"
WEB_PID_FILE="$DATA_DIR/studio-web.pid"
touch "$LOG_DIR/launcher.log"

url_ready() {
  /usr/bin/curl -fsS --max-time 2 "$1" >/dev/null 2>&1
}

fetch_text() {
  /usr/bin/curl -fsS --max-time 5 "$1" 2>/dev/null || true
}

port_listening() {
  /usr/bin/nc -z 127.0.0.1 "$1" >/dev/null 2>&1
}

refresh_urls() {
  if [ -n "$USER_JUANSHE_API_BASE" ]; then
    export JUANSHE_API_BASE="$USER_JUANSHE_API_BASE"
  else
    export JUANSHE_API_BASE="http://127.0.0.1:$HARDWRITE_STUDIO_PORT"
  fi
  export HARDWRITE_API_BASE="$JUANSHE_API_BASE"
  if [ -n "$USER_NEXT_PUBLIC_JUANSHE_API_BASE" ]; then
    export NEXT_PUBLIC_JUANSHE_API_BASE="$USER_NEXT_PUBLIC_JUANSHE_API_BASE"
  else
    export NEXT_PUBLIC_JUANSHE_API_BASE="$JUANSHE_API_BASE"
  fi
  export NEXT_PUBLIC_HARDWRITE_API_BASE="$NEXT_PUBLIC_JUANSHE_API_BASE"
  export PORT="$AUTOW_STUDIO_WEB_PORT"
  BACKEND_URL="http://127.0.0.1:$HARDWRITE_STUDIO_PORT/api/v1/books"
  WEB_URL="http://$AUTOW_STUDIO_WEB_HOST:$AUTOW_STUDIO_WEB_PORT"
}

pid_alive() {
  local file="$1"
  if [ ! -f "$file" ]; then
    return 1
  fi
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    return 1
  fi
  kill -0 "$pid" >/dev/null 2>&1
}

stop_pid_file() {
  local file="$1"
  if ! pid_alive "$file"; then
    rm -f "$file"
    return 0
  fi
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') stopping stale owned process pid=$pid file=$file" >> "$LOG_DIR/launcher.log"
  kill "$pid" >/dev/null 2>&1 || true
  sleep 1
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$file"
}

backend_ready() {
  url_ready "$BACKEND_URL" || return 1
  fetch_text "http://127.0.0.1:$HARDWRITE_STUDIO_PORT/api/v1/models" | /usr/bin/grep -Eq '"groups"|"models"' || return 1
  fetch_text "http://127.0.0.1:$HARDWRITE_STUDIO_PORT/api/v1/workflow-contract" | /usr/bin/grep -Eq 'continue-writing|taskFlows|stages' || return 1
}

web_ready() {
  url_ready "$WEB_URL/" || return 1
  fetch_text "$WEB_URL/api/v1/system/health" | /usr/bin/grep -Eq '"status"' || return 1
  fetch_text "$WEB_URL/api/v1/workflow-contract" | /usr/bin/grep -Eq 'continue-writing|planner|writer' || return 1
}

wait_for_backend() {
  local tries="\${1:-80}"
  local i=0
  while [ "$i" -lt "$tries" ]; do
    if backend_ready; then
      return 0
    fi
    i=$((i + 1))
    sleep 0.5
  done
  return 1
}

wait_for_web() {
  local tries="\${1:-100}"
  local i=0
  while [ "$i" -lt "$tries" ]; do
    if web_ready; then
      return 0
    fi
    i=$((i + 1))
    sleep 0.5
  done
  return 1
}

pick_backend_port() {
  if pid_alive "$BACKEND_PID_FILE" && backend_ready; then
    return 0
  fi
  if pid_alive "$BACKEND_PID_FILE"; then
    stop_pid_file "$BACKEND_PID_FILE"
  fi
  if ! port_listening "$HARDWRITE_STUDIO_PORT"; then
    return 0
  fi
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') backend port $HARDWRITE_STUDIO_PORT is occupied by an incompatible or unowned service; selecting fallback" >> "$LOG_DIR/launcher.log"
  for candidate in 4568 4569 4570 4571 4572 4573 4574 4575 4576 4577 4578 4579; do
    if [ "$candidate" = "$HARDWRITE_STUDIO_PORT" ]; then
      continue
    fi
    if ! port_listening "$candidate"; then
      export HARDWRITE_STUDIO_PORT="$candidate"
      refresh_urls
      return 0
    fi
  done
  return 1
}

pick_web_port() {
  if pid_alive "$WEB_PID_FILE" && web_ready; then
    return 0
  fi
  if pid_alive "$WEB_PID_FILE"; then
    stop_pid_file "$WEB_PID_FILE"
  fi
  if ! port_listening "$AUTOW_STUDIO_WEB_PORT"; then
    return 0
  fi
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') web port $AUTOW_STUDIO_WEB_PORT is occupied by an incompatible or unowned service; selecting fallback" >> "$LOG_DIR/launcher.log"
  for candidate in 3101 3102 3103 3104 3105 3106 3107 3108 3109; do
    if [ "$candidate" = "$AUTOW_STUDIO_WEB_PORT" ]; then
      continue
    fi
    if ! port_listening "$candidate"; then
      export AUTOW_STUDIO_WEB_PORT="$candidate"
      refresh_urls
      return 0
    fi
  done
  return 1
}

start_backend() {
  /usr/bin/nohup /bin/bash -c '
    set -u
    app_cwd="$1"
    node_bin="$2"
    api_entry="$3"
    workspace="$4"
    cd "$app_cwd"
    echo "$(date -u "+%Y-%m-%dT%H:%M:%SZ") starting backend cwd=$PWD node=$("$node_bin" -v 2>/dev/null)"
    exec "$node_bin" "$api_entry" "$workspace"
  ' bash "$APP_ROOT/packages/studio" "$NODE" "$APP_ROOT/packages/studio/dist/api/index.js" "$WORKSPACE_DIR" >> "$LOG_DIR/backend.log" 2>&1 &
  echo "$!" > "$DATA_DIR/backend.pid"
}

start_web() {
  local standalone_root="$APP_ROOT/packages/studio-web/.next/standalone"
  local server="$standalone_root/packages/studio-web/server.js"
  if [ ! -f "$server" ]; then
    server="$standalone_root/server.js"
  fi

  if [ ! -f "$server" ]; then
    echo "Missing Next standalone server: $server" >> "$LOG_DIR/studio-web.log"
    return 1
  fi

  /usr/bin/nohup /bin/bash -c '
    set -u
    standalone_root="$1"
    node_bin="$2"
    server="$3"
    cd "$standalone_root"
    echo "$(date -u "+%Y-%m-%dT%H:%M:%SZ") starting studio-web cwd=$PWD node=$("$node_bin" -v 2>/dev/null) server=$server"
    exec "$node_bin" "$server"
  ' bash "$standalone_root" "$NODE" "$server" >> "$LOG_DIR/studio-web.log" 2>&1 &
  echo "$!" > "$DATA_DIR/studio-web.pid"
}

refresh_urls
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') workspace=$WORKSPACE_DIR api=$HARDWRITE_STUDIO_PORT web=$AUTOW_STUDIO_WEB_HOST:$AUTOW_STUDIO_WEB_PORT" >> "$LOG_DIR/launcher.log"

if ! pick_backend_port; then
  /usr/bin/open "$LOG_DIR" >/dev/null 2>&1 || true
  /usr/bin/osascript -e 'display dialog "卷舍 could not find a free backend port. Logs have been opened." buttons {"OK"} default button "OK"' >/dev/null 2>&1 || true
  exit 1
fi

if ! backend_ready; then
  start_backend
fi

if ! wait_for_backend 80; then
  /usr/bin/open "$LOG_DIR" >/dev/null 2>&1 || true
  /usr/bin/osascript -e 'display dialog "卷舍 backend did not start. Logs have been opened." buttons {"OK"} default button "OK"' >/dev/null 2>&1 || true
  exit 1
fi

if ! pick_web_port; then
  /usr/bin/open "$LOG_DIR" >/dev/null 2>&1 || true
  /usr/bin/osascript -e 'display dialog "卷舍 could not find a free web port. Logs have been opened." buttons {"OK"} default button "OK"' >/dev/null 2>&1 || true
  exit 1
fi

if ! web_ready; then
  start_web
fi

if ! wait_for_web 100; then
  /usr/bin/open "$LOG_DIR" >/dev/null 2>&1 || true
  /usr/bin/osascript -e 'display dialog "卷舍 Studio did not start. Logs have been opened." buttons {"OK"} default button "OK"' >/dev/null 2>&1 || true
  exit 1
fi

if [ "\${JUANSHE_NO_OPEN:-0}" != "1" ]; then
  /usr/bin/open "$WEB_URL"
fi
exit 0
`,
    0o755,
  );
}

function writeReadme() {
  writeText(
    join(releaseRoot, "README.txt"),
    `卷舍 macOS package

Double-click "卷舍.app" to start the local writing workbench.

Default ports:
- Studio Web: http://127.0.0.1:3100
- Studio API: http://127.0.0.1:4567

User data:
- Workspace: ~/Library/Application Support/卷舍/workspace
- Optional env file: ~/Library/Application Support/卷舍/.env
- Logs: ~/Library/Logs/卷舍

Secrets are not bundled. Put provider keys in the optional env file if the
writing engine needs them outside the existing local configuration.
`,
  );
}

function writeManifest() {
  const manifest = {
    name: appName,
    builtAt: new Date().toISOString(),
    appBundle: relative(repoRoot, appBundle),
    runtime: {
      node: process.version,
    },
    services: {
      studioApiDefaultPort: 4567,
      studioWebDefaultPort: 3100,
    },
    data: {
      workspace: "~/Library/Application Support/卷舍/workspace",
      logs: "~/Library/Logs/卷舍",
    },
  };
  writeText(join(releaseRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function createZip() {
  rmSync(zipPath, { force: true });
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appBundle, zipPath]);
}

function createDmg() {
  rmSync(dmgPath, { force: true });
  try {
    run("hdiutil", [
      "create",
      "-volname",
      appName,
      "-srcfolder",
      releaseRoot,
      "-ov",
      "-format",
      "UDZO",
      dmgPath,
    ]);
  } catch (error) {
    log(`Skipping dmg creation: ${error.message}`);
  }
}

function main() {
  requirePath(join(repoRoot, "node_modules"), "root dependencies");

  // studio-web 是已废弃的旧 Next 迁移版（非 CLI/生产产品）。
  // 仓库可不含该包；存在时才参与打包，缺失则整段优雅跳过。
  const hasStudioWeb = existsSync(join(repoRoot, "packages/studio-web"));

  run("pnpm", ["--filter", "@juanshe/core", "build"]);
  run("pnpm", ["--filter", "@juanshe/studio", "build"]);
  if (hasStudioWeb) {
    run("pnpm", ["--filter", "@juanshe/studio-web", "build"]);
  }

  requirePath(join(repoRoot, "packages/studio/dist/index.html"), "studio client build");
  requirePath(join(repoRoot, "packages/studio/dist/api/index.js"), "studio api build");
  if (hasStudioWeb) {
    requirePath(join(repoRoot, "packages/studio-web/.next/standalone"), "studio web standalone build");
  }

  log(`cleaning ${releaseRoot}`);
  rmSync(releaseRoot, { recursive: true, force: true });
  mkdirSync(macosDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });
  mkdirSync(packagedRoot, { recursive: true });

  log("copying bundled Node runtime");
  copyPath(realpathSync(process.execPath), join(packagedRoot, "runtime/node"));
  chmodSync(join(packagedRoot, "runtime/node"), 0o755);

  log("deploying backend runtime dependencies");
  deployStudioBackend();

  if (hasStudioWeb) {
    log("copying Studio Web standalone output");
    copyPackage("packages/studio-web", ["package.json", ".next/standalone"]);
    copyNextStaticIntoStandalone();
    rewriteStudioWebStandaloneSymlinks();
  } else {
    log("studio-web absent — skipping deprecated web bundling");
  }
  assertNoAbsoluteSymlinks(packagedRoot);

  writeInfoPlist();
  writeLauncher();
  writeReadme();
  writeManifest();

  const size = statSync(appBundle).isDirectory() ? "ready" : "missing";
  log(`app bundle ${size}: ${appBundle}`);
  createZip();
  createDmg();
  log(`done: ${releaseRoot}`);
}

main();
