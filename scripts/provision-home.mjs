#!/usr/bin/env node
// scripts/provision-home.mjs — 初始化/更新一个 DSH-Novel 的 DSH_HOME。纯 node 标准库，
// 随应用打包后在运行时复用（Flutter 的 KernelManager 直接 spawn 本脚本）。
//
// 职责（幂等）：
//   1. profiles/novel + profiles/novel-<style>：ACP 写作 profile（bundles =
//      dsh-base + dsh-acp-app，挂 agent-presets roster，default 指向对应预设）；
//   2. .agent-presets/：安装内置智能体预设（novelist 通用 + 各风格）——只覆盖
//      「DSH-Novel 安装且未被用户修改」的预设；用户改过或外来预设一律跳过。
//
// 用法：
//   node scripts/provision-home.mjs --home <dir> [--library <repoRoot>] [--force] [--only <key>]
// 导出：provisionHome(home, library, opts) → 计数对象

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import url from "node:url";

const STAMP_NAME = ".dsh-novel.json";

function sha256buf(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// 目录内容指纹：排序后的 相对路径 + 文件内容（排除 stamp 自身）。目录不存在返回 null。
function treeHash(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile() && e.name !== STAMP_NAME) files.push([r, path.join(d, e.name)]);
    }
  };
  walk(dir, "");
  files.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const h = crypto.createHash("sha256");
  for (const [rel, abs] of files) {
    h.update(rel);
    h.update("\0");
    h.update(fs.readFileSync(abs));
    h.update("\0");
  }
  return h.digest("hex");
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === STAMP_NAME) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function readStamp(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, STAMP_NAME), "utf8"));
  } catch {
    return null;
  }
}

function writeStamp(dir, hash) {
  const body = JSON.stringify({ source: "dsh-novel", treeHash: hash }, null, 2) + "\n";
  fs.writeFileSync(path.join(dir, STAMP_NAME), body, "utf8");
}

// ---- profiles ------------------------------------------------------------

function profilePatchYml(presetKey, label) {
  return [
    "# DSH-Novel 写作 profile：" + label,
    "# 由 scripts/provision-home.mjs 生成（应用托管，请勿手改）。",
    "# 组合：dsh-base + dsh-acp-app（ACP stdio 服务）+ agent-presets roster。",
    "",
    "# 部署级兜底人设：预设挂载失败时仍是写作 Agent 语义（正常路径由预设 persona 接管）。",
    "- id: system-prompt",
    "  config:",
    "    persona: >-",
    "      你是一个面向小说作者的写作智能体，由 {{model}} 驱动，当前工作目录是 {{cwd}}。",
    "",
    "# 预设名单：随附根 + <dshHome>/.agent-presets（includeUserRoot 默认开启）。",
    "- insert:",
    "    - id: agent-presets",
    "      name: '@deepseek-ai/dsh-agent-presets'",
    "      config:",
    "        default: " + presetKey,
    "",
  ].join("\n");
}

function ensureProfile(home, profileName, presetKey, label, log) {
  const dir = path.join(home, "profiles", profileName);
  fs.mkdirSync(dir, { recursive: true });
  const pkg = {
    name: "dsh-profile-" + profileName,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"] } },
  };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(dir, "cordis.patch.yml"), profilePatchYml(presetKey, label), "utf8");
  log("profile " + profileName + " → 预设 " + presetKey);
}

// WebUI 基座 profile：dsh web 默认（bundles = base + web-app；默认预设 = novelist）。
function ensureWebProfile(home, log) {
  const dir = path.join(home, "profiles", "web");
  fs.mkdirSync(dir, { recursive: true });
  const pkg = {
    name: "dsh-profile-web",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
  };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
  // dsh-web-app 的 bundle 已挂 agent-presets（default: standard）——
  // 这里用 id 定点覆盖其 config（不再 insert，重复 id 会让 loader 启动即崩）。
  const patch = [
    "# DSH-Novel WebUI profile（应用托管，请勿手改）。",
    "- id: agent-presets",
    "  config:",
    "    default: novelist",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "cordis.patch.yml"), patch, "utf8");
  log("profile web → WebUI（默认预设 novelist）");
}

// ---- presets -------------------------------------------------------------

function installPreset(home, entry, libraryDir, force, log) {
  const src = path.join(libraryDir, entry.dir);
  const dest = path.join(home, ".agent-presets", entry.key);
  if (force) {
    fs.rmSync(dest, { recursive: true, force: true });
    copyDir(src, dest);
    writeStamp(dest, treeHash(dest));
    log("预设 " + entry.key + "：强制重装");
    return "forced";
  }
  if (!fs.existsSync(dest)) {
    copyDir(src, dest);
    writeStamp(dest, treeHash(dest));
    log("预设 " + entry.key + "：安装");
    return "installed";
  }
  const stamp = readStamp(dest);
  if (!stamp || stamp.source !== "dsh-novel") {
    log("预设 " + entry.key + "：已存在（非 DSH-Novel 安装），跳过");
    return "skipped";
  }
  const currentHash = treeHash(dest);
  if (currentHash !== stamp.treeHash) {
    log("预设 " + entry.key + "：用户已修改，跳过（重装请 --force --only " + entry.key + "）");
    return "skipped";
  }
  const bundledHash = treeHash(src);
  if (bundledHash && currentHash !== bundledHash) {
    fs.rmSync(dest, { recursive: true, force: true });
    copyDir(src, dest);
    writeStamp(dest, treeHash(dest));
    log("预设 " + entry.key + "：更新到内置版本");
    return "updated";
  }
  return "uptodate";
}

// ---- 主入口 --------------------------------------------------------------

export async function provisionHome(home, library, opts = {}) {
  const force = !!opts.force;
  const only = opts.only || null;
  const log = opts.log || (() => {});
  home = path.resolve(home);
  library = path.resolve(library);

  const manifest = JSON.parse(fs.readFileSync(path.join(library, "manifest.json"), "utf8"));
  if (!Array.isArray(manifest) || manifest.length === 0) throw new Error("agents/manifest.json 无效");

  fs.mkdirSync(path.join(home, ".agent-presets"), { recursive: true });
  ensureWebProfile(home, log);

  const counts = {};
  for (const entry of manifest) {
    if (only && entry.key !== only) continue;
    const styleId = entry.key === "novelist" ? null : entry.key.slice("novelist-".length);
    const profileName = styleId ? "novel-" + styleId : "novel";
    ensureProfile(home, profileName, entry.key, entry.name, log);
    const r = installPreset(home, entry, library, force, log);
    counts[r] = (counts[r] || 0) + 1;
  }
  return counts;
}

// ---- CLI -----------------------------------------------------------------

const isCli = (() => {
  try {
    return process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isCli) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const home = get("--home");
  const appRoot = path.resolve(url.fileURLToPath(new URL("..", import.meta.url)));
  const library = get("--library") || path.join(appRoot, "agents");
  const force = args.includes("--force");
  const only = get("--only");
  if (!home) {
    console.error("用法：provision-home.mjs --home <dir> [--library <repoRoot>] [--force] [--only <key>]");
    process.exit(2);
  }
  provisionHome(home, library, { force, only, log: (m) => console.log("[provision] " + m) })
    .then((c) => console.log("[provision] 完成 " + JSON.stringify(c)))
    .catch((e) => {
      console.error("[provision] 失败：" + ((e && e.message) || e));
      process.exit(1);
    });
}
