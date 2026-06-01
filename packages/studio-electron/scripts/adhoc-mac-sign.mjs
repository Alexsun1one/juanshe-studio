import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function runBestEffort(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.warn(`[juanshe] warning: ${command} ${args.join(" ")} exited ${result.status}`);
  }
}

function findAppBundle(appOutDir) {
  const apps = readdirSync(appOutDir)
    .filter((entry) => entry.endsWith(".app"))
    .map((entry) => join(appOutDir, entry))
    .filter((entry) => statSync(entry).isDirectory());

  if (apps.length !== 1) {
    throw new Error(`Expected one .app bundle in ${appOutDir}, found ${apps.length}`);
  }

  return apps[0];
}

export default async function adhocMacSign(context) {
  if (process.platform !== "darwin" || context.electronPlatformName !== "darwin") {
    return;
  }

  if (process.env.JUANSHE_MAC_ADHOC_SIGN === "0") {
    console.log("[juanshe] skipped macOS ad-hoc signing");
    return;
  }

  const appPath = findAppBundle(context.appOutDir);
  console.log(`[juanshe] ad-hoc signing macOS bundle: ${appPath}`);

  runBestEffort("xattr", ["-c", appPath]);
  run("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath]);
  run("codesign", ["--verify", "--deep", "--verbose=2", appPath]);
}
