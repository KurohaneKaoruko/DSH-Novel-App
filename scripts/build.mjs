#!/usr/bin/env node
// app/scripts/build.mjs — DSH-Novel（Tauri）多平台构建。
//
// 流程：生成智能体库 → 安装内核 → 组装 staging 资源（kernel/agents/scripts/node）
//      → npx tauri build（安装器：nsis/dmg/deb/appimage）→ 收集产物 → 校验和。
//
// 用法：node scripts/build.mjs [--skip-node]
// 产物：app/dist/

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import url from "node:url";
import { spawnSync } from "node:child_process";

const appRoot = path.resolve(url.fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = path.resolve(appRoot, "..");
const distDir = path.join(appRoot, "dist");
const staging = path.join(appRoot, "src-tauri", "staging");
const VERSION = JSON.parse(fs.readFileSync(path.join(appRoot, "src-tauri", "tauri.conf.json"), "utf8")).version;
const tauriDir = path.join(appRoot, "src-tauri");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
const arch = process.arch;
const buildLog = [];
let lastThrown = "";
const log = (m) => {
  console.log("[build] " + m);
  buildLog.push("[build] " + m);
};

function sh(file, cmdArgs, opts = {}) {
  log([file, ...cmdArgs].join(" "));
  const res = spawnSync(file, cmdArgs, { stdio: "pipe", maxBuffer: 128 * 1024 * 1024, ...opts });
  const out = res.stdout ? res.stdout.toString() : "";
  const err = res.stderr ? res.stderr.toString() : "";
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  buildLog.push((out + "\n" + err).slice(-4000));
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(file + " 失败（exit " + res.status + "）\n" + err.slice(-2000));
  }
}

// 失败落盘（CI issue 上报读取）：任何异常路径都要留下诊断。
function dumpFailure(msg) {
  try {
    fs.mkdirSync(distDir, { recursive: true });
    const body =
      buildLog.slice(-8000).join("\n") +
      (msg ? "\n\n[thrown] " + msg : "");
    fs.writeFileSync(path.join(distDir, "build-failure.txt"), body.slice(-9000), "utf8");
  } catch {}
}
process.on("exit", (code) => {
  if (code !== 0) dumpFailure(lastThrown || "exit " + code);
});
process.on("uncaughtException", (e) => {
  lastThrown = String((e && e.stack) || e);
  console.error("[build] 未捕获异常：", lastThrown);
  dumpFailure(lastThrown);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  lastThrown = String((e && e.stack) || e);
  console.error("[build] 未捕获拒绝：", lastThrown);
  dumpFailure(lastThrown);
  process.exit(1);
});

// ---- 1. 智能体库 + 内核 ------------------------------------------------------

if (!fs.existsSync(path.join(appRoot, "agents", "manifest.json"))) {
  log("生成智能体库…");
  sh("node", ["scripts/generate-agents.mjs"], { cwd: appRoot });
}
const kernelBin = path.join(appRoot, "kernel", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
if (!fs.existsSync(kernelBin)) {
  log("安装内核…");
  sh("node", ["scripts/kernel-install.mjs"], { cwd: appRoot });
}

// ---- 2. 组装 staging 资源 ----------------------------------------------------

log("组装 staging 资源…");
fs.rmSync(staging, { recursive: true, force: true });

const PLAT_KEY = { win: "win32", mac: "darwin", linux: "linux" };

/** 按目标平台剪除内核树里的死重：跨平台预编译二进制、SourceMap、文档等。 */
function pruneKernel(stagingDir, plat, arch) {
  const nm = path.join(stagingDir, "kernel", "node_modules");
  if (!fs.existsSync(nm)) return;
  const wantPty = plat + "-" + arch; // node-pty prebuilds 目录命名：darwin-arm64 / linux-x64 / win32-x64
  let removed = 0;

  const rmRf = (p) => { fs.rmSync(p, { recursive: true, force: true }); removed++; };

  // 1) node-pty：只留当前平台的 prebuilds（每个平台可到 11MB+）
  const ptyPre = path.join(nm, "node-pty", "prebuilds");
  if (fs.existsSync(ptyPre)) {
    for (const e of fs.readdirSync(ptyPre, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== wantPty) rmRf(path.join(ptyPre, e.name));
    }
  }

  // 2) 平台专属可选依赖（koffi / sharp）：npm 已只装本平台，防御性再清一次
  for (const scope of ["@koromix", "@img"]) {
    const d = path.join(nm, scope);
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const n = e.name;
      const hit =
        n.includes("-" + (plat === "win" ? "win32" : plat) + "-") ||
        n.includes((plat === "win" ? "win32" : plat) + "-" + arch) ||
        (plat === "win" && n.includes("win32-x64") && arch === "x64") ||
        (plat === "mac" && n.includes("darwin-" + arch));
      if (!hit) rmRf(path.join(d, e.name));
    }
  }

  // 3) SourceMap / Markdown 文档 / CI 目录（运行时不读）
  const stripFiles = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === ".github" || e.name === "docs") { rmRf(p); continue; }
        walk(p);
      } else if (e.name.endsWith(".map")) {
        stripFiles.push(p);
      }
    }
  };
  walk(nm);
  for (const p of stripFiles) { fs.rmSync(p, { force: true }); removed++; }

  log("内核剪除完成（移除 " + removed + " 项跨平台/调试产物）");
}

function copyDir(src, dest, filter) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (filter && filter(e.name, e.isDirectory())) continue;
    if (e.isDirectory()) copyDir(s, d, filter);
    else if (e.isSymbolicLink()) {
      try { fs.symlinkSync(fs.readlinkSync(s), d); } catch {}
    } else fs.copyFileSync(s, d);
  }
}

// kernel（node_modules 全量 → 按目标平台剪除死重）
copyDir(path.join(appRoot, "kernel"), path.join(staging, "kernel"));
pruneKernel(staging, platform, arch);
// agents（平铺库；排除 styles.yml 源文件）
copyDir(path.join(appRoot, "agents"), path.join(staging, "agents"), (name) => name === "styles.yml");
// scripts（provision）
fs.mkdirSync(path.join(staging, "scripts"), { recursive: true });
fs.copyFileSync(path.join(appRoot, "scripts", "provision-home.mjs"), path.join(staging, "scripts", "provision-home.mjs"));

// node 运行时
const NODE_VERSION = "24.19.0";
const nodeDir = path.join(staging, "node");
fs.mkdirSync(nodeDir, { recursive: true });

const fileName = platform === "win"
  ? "node-v" + NODE_VERSION + "-win-" + arch + ".zip"
  : "node-v" + NODE_VERSION + "-" + (platform === "mac" ? "darwin" : "linux") + "-" + arch + ".tar.gz";
const urls = [
  "https://nodejs.org/dist/v" + NODE_VERSION + "/" + fileName,
  "https://npmmirror.com/mirrors/node/v" + NODE_VERSION + "/" + fileName,
];
const tmp = path.join(appRoot, "dist", ".dl-" + fileName);
fs.mkdirSync(path.dirname(tmp), { recursive: true });
let ok = false;
for (const u of urls) {
  try {
    log("下载 node 运行时：" + u);
    const res = await fetch(u);
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    ok = true;
    break;
  } catch (e) {
    log("  失败：" + e.message);
  }
}
if (!ok) throw new Error("node 运行时下载失败");
const extractDir = path.join(appRoot, "dist", ".node-extract");
fs.rmSync(extractDir, { recursive: true, force: true });
fs.mkdirSync(extractDir, { recursive: true });
sh("tar", [platform === "win" ? "-xf" : "-xzf", tmp, "-C", extractDir]);
fs.rmSync(tmp, { force: true });
const inner = fs.readdirSync(extractDir, { withFileTypes: true }).find((e) => e.isDirectory());
const innerDir = inner ? path.join(extractDir, inner.name) : extractDir;
if (platform === "win") {
  for (const f of fs.readdirSync(innerDir)) {
    if (f === "node.exe" || f.endsWith(".dll") || f === "LICENSE.md" || f.endsWith(".txt")) {
      fs.copyFileSync(path.join(innerDir, f), path.join(nodeDir, f));
    }
  }
} else {
  fs.mkdirSync(path.join(nodeDir, "bin"), { recursive: true });
  fs.copyFileSync(path.join(innerDir, "bin", "node"), path.join(nodeDir, "bin", "node"));
  fs.chmodSync(path.join(nodeDir, "bin", "node"), 0o755);
}
fs.rmSync(extractDir, { recursive: true, force: true });
log("staging 就绪");

// ---- 3. tauri build ----------------------------------------------------------

log("tauri build（安装器）…");
// 捕获输出（失败详情进诊断文件）
if (process.platform === "win32") {
  sh("cmd.exe", ["/d", "/s", "/c", "npx", "tauri", "build"], { cwd: appRoot });
} else {
  sh("npx", ["tauri", "build"], { cwd: appRoot });
}

// ---- 4. 收集产物 --------------------------------------------------------------

fs.mkdirSync(distDir, { recursive: true });
const bundle = path.join(tauriDir, "target", "release", "bundle");
const artifacts = [];

function collect(rel, outName) {
  const src = path.join(bundle, rel);
  if (!fs.existsSync(src)) return;
  const dest = path.join(distDir, outName);
  fs.copyFileSync(src, dest);
  artifacts.push(dest);
  log("收集 " + outName);
}
collect(path.join("nsis", "DSH-Novel_" + VERSION + "_x64-setup.exe"), "DSH-Novel-" + VERSION + "-setup-x64.exe");
collect(path.join("dmg", "DSH-Novel_" + VERSION + "_aarch64.dmg"), "DSH-Novel-" + VERSION + "-macos-arm64.dmg");
collect(path.join("deb", "dsh-novel_" + VERSION + "_amd64.deb"), "DSH-Novel-" + VERSION + "-linux-x64.deb");

// ---- 5. 便携 zip（exe/app + resources） ---------------------------------------

log("组装便携版…");
const exePath = path.join(tauriDir, "target", "release");
let portableName;
if (platform === "win") {
  portableName = "DSH-Novel-" + VERSION + "-win-x64";
  const pdir = path.join(distDir, portableName);
  fs.rmSync(pdir, { recursive: true, force: true });
  fs.mkdirSync(pdir, { recursive: true });
  fs.copyFileSync(path.join(exePath, "dsh-novel.exe"), path.join(pdir, "DSH-Novel.exe"));
  copyDir(staging, path.join(pdir, "resources"));
  const zipPath = path.join(distDir, portableName + ".zip");
  fs.rmSync(zipPath, { force: true });
  sh("powershell", ["-NoProfile", "-Command",
    "Compress-Archive -Path '" + pdir + "' -DestinationPath '" + zipPath + "'"]);
  fs.rmSync(pdir, { recursive: true, force: true });
  artifacts.push(zipPath);
} else {
  // POSIX：tar.gz（含 app 或 bundle）
  portableName = "DSH-Novel-" + VERSION + "-" + platform + "-" + arch;
  const pdir = path.join(distDir, portableName);
  fs.rmSync(pdir, { recursive: true, force: true });
  fs.mkdirSync(pdir, { recursive: true });
  copyDir(staging, path.join(pdir, "resources"));
  if (platform === "mac") {
    const app = fs.readdirSync(path.join(tauriDir, "target", "release", "bundle", "macos"))
      .find((n) => n.endsWith(".app"));
    if (app) copyDir(path.join(tauriDir, "target", "release", "bundle", "macos", app), path.join(pdir, app));
  } else {
    const exe = path.join(exePath, "dsh-novel");
    if (fs.existsSync(exe)) {
      fs.copyFileSync(exe, path.join(pdir, "dsh-novel"));
      fs.chmodSync(path.join(pdir, "dsh-novel"), 0o755);
    }
  }
  const tgz = path.join(distDir, portableName + ".tar.gz");
  fs.rmSync(tgz, { force: true });
  sh("tar", ["-czf", tgz, "-C", distDir, portableName]);
  fs.rmSync(pdir, { recursive: true, force: true });
  artifacts.push(tgz);
}

// ---- 6. 校验和 ----------------------------------------------------------------

fs.writeFileSync(path.join(distDir, "checksums.txt"),
  artifacts.map((a) => crypto.createHash("sha256").update(fs.readFileSync(a)).digest("hex") + "  " + path.basename(a)).join("\n") + "\n",
  "utf8");
log("完成。产物：");
for (const a of artifacts) log("  - " + path.basename(a));
