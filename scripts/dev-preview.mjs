#!/usr/bin/env node
// app/scripts/dev-preview.mjs — 本地开发预览（无 Tauri 依赖）。
//
// 拉起 dsh web（~/.dsh-novel），在 127.0.0.1:<PORT> 起一个反代：
//   * 原版 WebUI 原样转发（含 Cookie 认证与 WebSocket）
//   * 注入右侧文件面板（与 Tauri 成品同一份 panel.js）
//   * /api/fs/*、/api/prefs 由本服务直接对接真实磁盘
// 打开 http://127.0.0.1:<PORT> 即可预览「原版 WebUI + 文件面板」。
//
// 用法：node scripts/dev-preview.mjs [--port 5080] [--home ~/.dsh-novel]

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import url from "node:url";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";

const appRoot = path.resolve(url.fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = path.resolve(appRoot, "..");
const args = process.argv.slice(2);
const get = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const PORT = Number(get("--port", 5080));
// 预览默认使用仓库内 home（不动真实 ~/.dsh-novel）；可用 --home 覆盖。
const dshHome = path.resolve(get("--home", path.join(appRoot, ".preview-home")));
const log = (m) => console.log("[preview] " + m);

// ---- 1. provision（预设 + web profile） ----
// 沙箱/受限环境：spawnSync 默认管道会 EPERM —— 用文件 fd 收集输出。
log("provision 预设与 profile…");
{
  const logDir = path.join(dshHome, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const ofd = fs.openSync(path.join(logDir, "provision.log"), "w");
  const efd = fs.openSync(path.join(logDir, "provision.err"), "w");
  const res = spawnSync("node", [path.join(appRoot, "scripts", "provision-home.mjs"),
    "--home", dshHome, "--library", path.join(appRoot, "agents")],
    { env: { ...process.env, DSH_HOME: dshHome }, stdio: ["ignore", ofd, efd] });
  fs.closeSync(ofd); fs.closeSync(efd);
  if (res.status !== 0) throw new Error("provision 失败（见 logs/provision.log）");
}

// ---- 2. 拉起内核 web ----
const kernelBin = path.join(appRoot, "kernel", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
if (!fs.existsSync(kernelBin)) throw new Error("内核未安装：npm run kernel:install");

function pickPort(base) {
  for (let p = base; p < base + 40; p++) {
    try { const s = net.createServer(); s.listen(p); s.close(); return p; } catch {}
  }
  return base;
}
const kernelPort = pickPort(51999);
const logDir = path.join(dshHome, "logs");
fs.mkdirSync(logDir, { recursive: true });
const webLogPath = path.join(logDir, "web.log");
const webLogFd = fs.openSync(webLogPath, "a");
const devNull = process.platform === "win32" ? "NUL" : "/dev/null";
const dnFd = fs.openSync(devNull, "w");
const kernel = spawn(process.execPath, [kernelBin, "web",
  "--host", "127.0.0.1", "--port", String(kernelPort), "--no-open"], {
  cwd: dshHome,
  env: { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", webLogFd, webLogFd],
});
process.on("exit", () => { try { kernel.kill(); } catch {} });

// ---- 3. 轮询 web.log 捕获 token URL（文件重定向无 EOF 阻塞问题） ----
const tokenByLine = (line) => {
  const m = line.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=\S+/);
  return m ? m[0] : null;
};
async function waitToken(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(webLogPath, "utf8");
      for (const line of text.split("\n")) {
        const u = tokenByLine(line);
        if (u) return u;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
const upstream = await waitToken(120000);
if (!upstream) throw new Error("120 秒内未捕获内核 Web 地址");
const upstreamUrl = new URL(upstream);
log("内核就绪：" + upstream.origin + "（token 已捕获）");
fs.writeFileSync(path.join(appRoot, ".preview-home", "token.txt"), upstream, "utf8");


// ---- 4. 面板注入源 ----
const panelJs = fs.readFileSync(path.join(appRoot, "src-tauri", "src", "inject", "panel.js"), "utf8")
  .replace("__SIDE_PORT__", String(PORT));
const panelCssPatch = "";

// ---- 5. 文件 API + 偏好（真实磁盘） ----
const prefsPath = path.join(dshHome, "prefs.json");
function prefsLoad() {
  try { return JSON.parse(fs.readFileSync(prefsPath, "utf8")); }
  catch { return { workspace: null, recents: [] }; }
}
function countWords(t) {
  let cjk = 0, word = 0, inWord = false;
  for (const ch of t) {
    const c = ch.codePointAt(0);
    const isCjk = (c >= 0x2e80 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff);
    const isW = /[0-9a-zA-Z]/.test(ch);
    if (isCjk) { cjk++; inWord = false; }
    else if (isW) { if (!inWord) { word++; inWord = true; } }
    else inWord = false;
  }
  return cjk + word;
}
function handleApi(pathname, body) {
  const jok = (v) => [200, JSON.stringify(v)];
  const jerr = (m) => [400, JSON.stringify({ error: m })];
  const str = (o, k) => (o && typeof o[k] === "string" ? o[k] : null);
  switch (pathname) {
    case "/api/fs/list": {
      const dir = str(body, "path");
      if (!dir) return jerr("missing path");
      let entries = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const name = e.name;
        if (name.startsWith(".") || name === "Thumbs.db") continue;
        let size = 0; try { size = fs.statSync(path.join(dir, name)).size; } catch {}
        entries.push({ name, dir: e.isDirectory(), size });
      }
      entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      return jok({ entries });
    }
    case "/api/fs/read": {
      const p = str(body, "path");
      if (!p) return jerr("missing path");
      const content = fs.readFileSync(p, "utf8");
      return jok({ content, words: countWords(content) });
    }
    case "/api/fs/write": {
      const p = str(body, "path"), content = str(body, "content") ?? "";
      if (!p) return jerr("missing path");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      return jok({ ok: true, words: countWords(content) });
    }
    case "/api/fs/mkdir": {
      const p = str(body, "path");
      if (!p) return jerr("missing path");
      fs.mkdirSync(p, { recursive: true });
      return jok({ ok: true });
    }
    case "/api/fs/rename": {
      const p = str(body, "path"), nn = str(body, "newName");
      if (!p || !nn) return jerr("missing");
      if (nn.includes("/") || nn.includes("\\\\") || nn.includes("..")) return jerr("名称非法");
      fs.renameSync(p, path.join(path.dirname(p), nn));
      return jok({ ok: true });
    }
    case "/api/fs/delete": {
      const p = str(body, "path");
      if (!p) return jerr("missing path");
      fs.rmSync(p, { recursive: true, force: true });
      return jok({ ok: true });
    }
    case "/api/prefs": {
      if (body && str(body, "workspace")) {
        const prefs = prefsLoad();
        prefs.workspace = body.workspace;
        const recents = Array.isArray(prefs.recents) ? prefs.recents : [];
        const i = recents.indexOf(body.workspace);
        if (i >= 0) recents.splice(i, 1);
        recents.unshift(body.workspace);
        prefs.recents = recents.slice(0, 8);
        fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
      }
      return jok(prefsLoad());
    }
    case "/api/health": return jok({ ok: true });
    default: return null;
  }
}

// ---- 6. 代理 + 注入服务器 ----
const kernelOrigin = upstreamUrl.origin;
let cookie = "";

// 服务端用 token 换取会话 Cookie，之后所有代理请求都带上（浏览器无需感知 token）。
try {
  const authRes = await fetch(upstream, { redirect: "manual" });
  const scs = authRes.headers.getSetCookie ? authRes.headers.getSetCookie() : [];
  for (const sc of scs) {
    cookie = sc.split(";")[0];
  }
  log("内核会话 Cookie 已获取" + (cookie ? " OK" : "（空）"));
} catch (e) {
  log("cookie 获取失败：" + e.message);
}

const server = http.createServer(async (req, res) => {
  const pathname = req.url.split("?")[0];

  // 面板 API
  if (pathname.startsWith("/api/")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch {}
    const [code, text] = handleApi(pathname, parsed) || [404, JSON.stringify({ error: "not found" })];
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(text);
    return;
  }

  // 其余 → 转发内核；HTML 注入面板
  const target = upstreamUrl.origin + req.url;
  const headers = { ...req.headers };
  delete headers.host;
  headers.host = upstreamUrl.host;
  if (cookie) headers.cookie = cookie;

  try {
    const up = await fetch(target, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req,
      redirect: "manual",
    });
    const setCookie = up.headers.getSetCookie ? up.headers.getSetCookie() : [];
    for (const sc of setCookie) cookie = sc.split(";")[0];

    const respHeaders = {};
    for (const [k, v] of up.headers.entries()) {
      if (["set-cookie", "content-length", "content-encoding", "transfer-encoding"].includes(k.toLowerCase())) continue;
      respHeaders[k] = v;
    }
    respHeaders["cache-control"] = "no-store";

    const ctype = up.headers.get("content-type") || "";
    if (ctype.includes("text/html")) {
      let html = await up.text();
      const inject = "<script>" + panelJs + "</script>";
      if (html.includes("</head>")) html = html.replace("</head>", inject + "</head>");
      else html = inject + html;
      respHeaders["content-length"] = Buffer.byteLength(html);
      res.writeHead(up.status, respHeaders);
      res.end(html);
    } else {
      const cl = up.headers.get("content-length"); if (cl) respHeaders["content-length"] = cl;
      res.writeHead(up.status, respHeaders);
      if (up.body) {
        const buf = Buffer.from(await up.arrayBuffer());
        res.end(buf);
      } else res.end();
    }
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("预览代理错误：" + e.message);
  }
});

// WebSocket 透传（内核 /api/remote.mux）
server.on("upgrade", (req, socket, head) => {
  const targetSocket = net.connect(kernelPort, "127.0.0.1", () => {
    const reqLine = req.method + " " + req.url + " HTTP/1.1\r\n";
    const headers = Object.entries(req.headers)
      .filter(([k]) => k.toLowerCase() !== "host")
      .map(([k, v]) => k + ": " + v + "\r\n").join("");
    targetSocket.write(reqLine + "Host: " + upstreamUrl.host + "\r\n" + headers + "\r\n");
    if (head && head.length) targetSocket.write(head);
    socket.pipe(targetSocket);
    targetSocket.pipe(socket);
  });
  targetSocket.on("error", () => socket.destroy());
  socket.on("error", () => targetSocket.destroy());
});

server.listen(PORT, "127.0.0.1", () => {
  log("预览就绪 → http://127.0.0.1:" + PORT + "  （Ctrl+C 退出）");
  log("文件面板已注入右侧；工作区在面板顶栏输入或选择。");
});

