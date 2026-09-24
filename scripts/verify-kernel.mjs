#!/usr/bin/env node
// scripts/verify-kernel.mjs — DSH-Novel 内核 ACP 冒烟测试（批处理式）。
//
// 说明：本脚本运行在受限沙箱里（Node 子进程禁止 pipe stdio），因此经
// cmd/shell 重定向从文件喂 ACP 帧、把 stdout 落盘再解析——对内核侧协议
// 的验证效果与交互式一致。生产环境中 Flutter 以真实 pipe 与内核通信。
//
// 流程：kernel/ 安装 → provision 测试 home → "dsh --profile novel"（ACP stdio）
// 执行 initialize / session/new / session/list / session/close → stdin EOF 优雅退出。
// 不需要 API Key（不发起 LLM 调用）。
//
// 用法：node scripts/verify-kernel.mjs [--home .testhome] [--node <node.exe>]

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { provisionHome } from "./provision-home.mjs";

const repoRoot = path.resolve(url.fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const get = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const home = path.resolve(repoRoot, get("--home", ".testhome"));
const nodeBin = get("--node", process.execPath);
const kernelBin = path.join(repoRoot, "kernel", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

if (!fs.existsSync(kernelBin)) {
  console.error("[verify] 内核未安装，先运行：npm run kernel:install");
  process.exit(1);
}

const ws = path.join(home, "workspace-demo");
fs.mkdirSync(ws, { recursive: true });

console.log("[verify] node: " + nodeBin);
console.log("[verify] home: " + home);
const counts = await provisionHome(home, path.join(repoRoot, "agents"), { log: (m) => console.log("[provision] " + m) });
console.log("[verify] provision: " + JSON.stringify(counts));

// ---- 批处理 ACP 帧 ---------------------------------------------------------

const frames = [];
const q = [];
function request(method, params) {
  const id = q.length + 1;
  q.push(method);
  frames.push(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}
request("initialize", { protocolVersion: 1, clientCapabilities: {} });
request("session/new", { cwd: ws, mcpServers: {} });
request("session/list", {});
// session/close 依赖 session/new 的返回 id —— 这里不能静态写。
// 顺序执行两轮：第一轮拿 sessionId，第二轮只发 close。

async function runBatch(extraFrames) {
  const all = frames.concat(extraFrames || []);
  const inFile = path.join(home, ".acp-in.jsonl");
  const outFile = path.join(home, ".acp-out.jsonl");
  const errFile = path.join(home, ".acp-err.log");
  fs.writeFileSync(inFile, all.join("\n") + "\n", "utf8");
  // 沙箱禁止 pipe stdio；直接以文件 fd 作为子进程 stdio（等价于 shell 重定向，
  // 无命名管道、无 cmd 引号转义问题）。
  const inFd = fs.openSync(inFile, "r");
  const outFd = fs.openSync(outFile, "w");
  const errFd = fs.openSync(errFile, "w");
  const child = spawn(nodeBin, [kernelBin, "--profile", "novel"], {
    cwd: home,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1" },
    stdio: [inFd, outFd, errFd],
  });
  const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
  const out = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
  const err = fs.existsSync(errFile) ? fs.readFileSync(errFile, "utf8") : "";
  return { code, out, err };
}

function parseFrames(text) {
  const parsed = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      parsed.push(JSON.parse(t));
    } catch {
      parsed.push({ nonjson: t });
    }
  }
  return parsed;
}

console.log("[verify] 第一轮握手（initialize / session/new / session/list）...");
const r1 = await runBatch([]);
const frames1 = parseFrames(r1.out);
const byId = new Map();
const notifies = [];
for (const f of frames1) {
  if (f.id !== undefined && (f.result !== undefined || f.error !== undefined)) byId.set(f.id, f);
  else if (f.method) notifies.push(f);
  else console.log("[acp:other] " + JSON.stringify(f).slice(0, 200));
}
function resultOf(id, label) {
  const f = byId.get(id);
  if (!f) throw new Error(label + "：无响应（id=" + id + "）\nstderr:\n" + r1.err.slice(-2000));
  if (f.error) throw new Error(label + "：错误 " + JSON.stringify(f.error));
  return f.result;
}

let failed = false;
try {
  const init = resultOf(1, "initialize");
  console.log("[verify] initialize OK：protocolVersion=" + init.protocolVersion);
  console.log("         agentInfo: " + JSON.stringify(init.agentInfo));
  console.log("         capabilities: " + JSON.stringify(init.agentCapabilities ?? init.serverCapabilities ?? null).slice(0, 400));

  const session = resultOf(2, "session/new");
  console.log("[verify] session/new OK：sessionId=" + session.sessionId);
  console.log("         keys: " + Object.keys(session).join(", "));
  console.log("         configOptions: " + JSON.stringify(session.configOptions).slice(0, 600));

  const list = resultOf(3, "session/list");
  console.log("[verify] session/list OK：sessions=" + (list.sessions ? list.sessions.length : "?"));
  if (list.sessions && list.sessions[0]) {
    console.log("         first: " + JSON.stringify(list.sessions[0]).slice(0, 400));
  }

  console.log("[verify] 第二轮：session/close ...");
  const closeFrame = [JSON.stringify({ jsonrpc: "2.0", id: 10, method: "session/close", params: { sessionId: session.sessionId } })];
  const r2 = await runBatch(closeFrame);
  const frames2 = parseFrames(r2.out);
  const close = frames2.find((f) => f.id === 10);
  if (!close) throw new Error("session/close：无响应\nstderr:\n" + r2.err.slice(-2000));
  if (close.error) throw new Error("session/close：错误 " + JSON.stringify(close.error));
  console.log("[verify] session/close OK：" + JSON.stringify(close.result).slice(0, 200));

  console.log("");
  console.log("PASS — 内核 ACP 链路可用（profile=novel，默认预设 novelist）");
  console.log("（第一轮进程退出码 " + r1.code + "，通知 " + notifies.length + " 条）");
  process.exit(0);
} catch (err) {
  failed = true;
  console.error("[verify] 失败：" + ((err && err.message) || err));
  if (r1.err) console.error("--- stderr tail ---\n" + r1.err.slice(-3000));
  process.exit(1);
}
