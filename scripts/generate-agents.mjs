#!/usr/bin/env node
// app/scripts/generate-agents.mjs — 组装 app/agents/ 完整智能体库（平铺）。
//
// 单一事实源：基准预设在仓库根 novelist/（不动），风格差异在
// app/agents/styles.yml。本脚本生成平铺库 app/agents/
//   manifest.json + novelist/（基准副本）+ novelist-<style>/（风格预设）
// 供 provision-home.mjs（dev 库根 = app/agents）与打包（resources/ 平铺同构）共用。
// 生成物不入库（gitignore 仅保留 styles.yml）。
//
// 用法：node scripts/generate-agents.mjs [--clean]   （在 app/ 下运行）

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import yaml from "js-yaml";

const appRoot = path.resolve(url.fileURLToPath(new URL("..", import.meta.url)));
// 基准目录：独立仓库用 agents/novelist/（随仓库提交）；mono 开发树用根 novelist/。
const vendored = path.join(appRoot, "agents", "novelist");
const baseDir = fs.existsSync(path.join(vendored, "preset.yml"))
  ? vendored
  : path.resolve(appRoot, "..", "novelist");
const agentsDir = path.join(appRoot, "agents");
const stylesFile = path.join(agentsDir, "styles.yml");

const args = process.argv.slice(2);
if (args.includes("--clean")) {
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("novelist")) {
      fs.rmSync(path.join(agentsDir, entry.name), { recursive: true, force: true });
      console.log("removed", entry.name);
    }
  }
}

if (!fs.existsSync(baseDir)) throw new Error("基准预设不存在：" + baseDir);
const styles = yaml.load(fs.readFileSync(stylesFile, "utf8")).styles;
if (!Array.isArray(styles) || styles.length === 0) throw new Error("styles.yml 未定义任何风格");

const composition = fs.readFileSync(path.join(baseDir, "agent.cordis.yml"), "utf8");

// ---- 定位 persona 块（text: >- 折叠块，内容行缩进 6 空格） ----
// CRLF 归一：Windows checkout（autocrlf）下行尾是 CR+LF，严格等值匹配会失效。
const lines = composition.replace(/\r\n/g, "\n").split("\n");
const personaStart = lines.findIndex((l) => l === "- id: persona");
const textStart = lines.findIndex((l, i) => i > personaStart && l === "    text: >-");
if (personaStart < 0 || textStart < 0) throw new Error("在 novelist/agent.cordis.yml 中找不到 persona text 块");
let personaEnd = textStart + 1;
while (personaEnd < lines.length && lines[personaEnd] !== "- id: agent-instructions") personaEnd++;
if (personaEnd >= lines.length) throw new Error("persona 块未在 agent-instructions 前结束");
const personaLines = lines.slice(textStart + 1, personaEnd);
while (personaLines.length && personaLines[personaLines.length - 1].trim() === "") personaLines.pop();

function indentBlock(text) {
  return String(text).replace(/\r\n/g, "\n").split("\n")
    .map((l) => (l.trim() === "" ? "" : "      " + l))
    .join("\n");
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ---- 1. 基准副本：agents/novelist（每次全量刷新） ----
fs.rmSync(path.join(agentsDir, "novelist"), { recursive: true, force: true });
copyDir(baseDir, path.join(agentsDir, "novelist"));
console.log("copied  novelist — 小说助手（基准副本）");

// ---- 2. 风格预设 ----
const manifest = [
  {
    key: "novelist",
    dir: "novelist",
    name: "小说助手",
    tag: "通用",
    description: "以写小说为核心的全能创作 Agent（基准预设，维护在仓库根 novelist/）",
  },
];

const generated = [];
for (const style of styles) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(style.id)) throw new Error("风格 id 不合法：" + style.id);
  const key = "novelist-" + style.id;
  const outDir = path.join(agentsDir, key);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  copyDir(path.join(baseDir, "skills"), path.join(outDir, "skills"));
  copyDir(path.join(baseDir, "plugins"), path.join(outDir, "plugins"));

  const desc = String(style.description).replace(/[\r\n]+/g, " ").trim();
  const presetYml = "name: " + style.name + "\ndescription: " + desc + "\n";
  fs.writeFileSync(path.join(outDir, "preset.yml"), presetYml, "utf8");

  const newPersona = [];
  const opening = String(style.opening).trim();
  const styleBlock = indentBlock(String(style.style).trim());
  let replacedFirst = false;
  for (const l of personaLines) {
    if (!replacedFirst && l.trim().startsWith("你是")) {
      newPersona.push("      " + opening);
      replacedFirst = true;
    } else {
      newPersona.push(l);
    }
  }
  if (!replacedFirst) throw new Error("[" + key + "] 未能定位人设首句（你是…）");
  const next = lines.slice();
  next.splice(textStart + 1, personaLines.length,
    ...newPersona, "", ...styleBlock.split("\n"));
  const header = "# The " + key + " agent preset (" + style.name + "): generated from novelist/ + agents/styles.yml by scripts/generate-agents.mjs — edit styles.yml and regenerate, not this file.";
  next[0] = header;
  fs.writeFileSync(path.join(outDir, "agent.cordis.yml"), next.join("\n"), "utf8");
  generated.push(key);
  manifest.push({
    key: key,
    dir: key,
    name: style.name,
    tag: style.tag,
    description: desc,
  });
  console.log("generated", key, "—", style.name);
}

fs.writeFileSync(path.join(agentsDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log("manifest: " + manifest.length + " 个预设 → agents/manifest.json");
console.log("");
console.log("库就绪（app/agents/，平铺）：" + manifest.length + " 个预设");
