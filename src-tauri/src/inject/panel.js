// DSH-Novel 文件面板（注入 DSH 原版 WebUI）。
// 激活条件：页面源是本机内核（127.0.0.1 且非边车端口）；幂等。
(function () {
  "use strict";
  if (window.__DSH_NOVEL_PANEL__) return;
  var SIDE_PORT = "__SIDE_PORT__";
  var API = "http://127.0.0.1:" + SIDE_PORT;
  var m = location.hostname;
  if (m !== "127.0.0.1" && m !== "localhost") return;
  if (String(location.port) === String(SIDE_PORT)) return;
  window.__DSH_NOVEL_PANEL__ = true;

  var BT = String.fromCharCode(96);
  var FENCE = BT + BT + BT;

  // ---------- 状态 ----------
  var S = {
    workspace: null,
    recents: [],
    expanded: {},       // dirPath -> true
    file: null,         // 当前文件绝对路径
    mode: "view",       // view | edit
    content: "",
    saved: "",
    dirty: false,
    open: true,
    width: 360,
  };

  // ---------- 工具 ----------
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === "style") n.style.cssText = attrs[k];
        else if (k === "text") n.textContent = attrs[k];
        else if (k === "html") n.innerHTML = attrs[k];
        else if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), attrs[k]);
        else n.setAttribute(k, attrs[k]);
      }
    }
    if (children) for (var i = 0; i < children.length; i++) if (children[i]) n.appendChild(children[i]);
    return n;
  }
  function esc(t) {
    return String(t == null ? "" : t)
      .split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;")
      .split('"').join("&quot;");
  }
  function api(path, body) {
    return fetch(API + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return { error: "响应解析失败" }; });
    }).then(function (j) {
      if (j && j.error) throw new Error(j.error);
      return j;
    });
  }
  function toast(msg, isErr) {
    var t = el("div", {
      text: msg,
      style:
        "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:2147483000;" +
        "padding:8px 14px;border-radius:8px;font-size:12.5px;max-width:70vw;" +
        "background:" + (isErr ? "rgba(176,32,32,.92)" : "rgba(61,90,128,.92)") + ";color:#fff;" +
        "box-shadow:0 4px 14px rgba(0,0,0,.25);pointer-events:none;transition:opacity .3s;",
    });
    document.body.appendChild(t);
    setTimeout(function () { t.style.opacity = "0"; }, 2600);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3000);
  }
  function baseName(p) { var i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")); return i < 0 ? p : p.slice(i + 1); }
  function joinPath(dir, name) {
    var sep = dir.indexOf("\\") >= 0 && dir.indexOf("/") < 0 ? "\\" : "/";
    return dir.replace(/[\/\\]+$/, "") + sep + name;
  }
  function isTextFile(name) {
    var i = name.lastIndexOf(".");
    var ext = i < 0 ? "" : name.slice(i + 1).toLowerCase();
    return ["md", "txt", "yml", "yaml", "json", "js", "mjs", "csv"].indexOf(ext) >= 0;
  }

  // ---------- 轻量 Markdown ----------
  function inlineHtml(t) {
    var h = esc(t);
    // 行内：**bold**、*italic*、code
    h = h.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    var re = new RegExp(BT + "([^" + BT + "\\n]+)" + BT, "g");
    h = h.replace(re, "<code>$1</code>");
    return h;
  }
  function mdToHtml(src) {
    var lines = String(src).replace(/\r\n/g, "\n").split("\n");
    var out = [];
    var i = 0;
    var liRe = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
    while (i < lines.length) {
      var t = lines[i].trim();
      if (!t) { i++; continue; }
      if (t.indexOf(FENCE) === 0) {
        var buf = [];
        i++;
        while (i < lines.length && lines[i].trim().indexOf(FENCE) !== 0) { buf.push(lines[i]); i++; }
        i++;
        out.push("<pre class='dn-pre'>" + esc(buf.join("\n")) + "</pre>");
        continue;
      }
      var hm = /^(#{1,6})\s+(.*)$/.exec(t);
      if (hm) {
        var lv = hm[1].length + 1;
        out.push("<h" + lv + " class='dn-h'>" + inlineHtml(hm[2]) + "</h" + lv + ">");
        i++; continue;
      }
      if (/^(---|\*\*\*|___)$/.test(t)) { out.push("<hr class='dn-hr'>"); i++; continue; }
      if (t.indexOf("> ") === 0) {
        var q = [];
        while (i < lines.length && lines[i].trim().indexOf("> ") === 0) { q.push(lines[i].trim().slice(2)); i++; }
        out.push("<blockquote class='dn-quote'>" + inlineHtml(q.join(" ")) + "</blockquote>");
        continue;
      }
      var lm = liRe.exec(t);
      if (lm) {
        var items = [];
        while (i < lines.length) {
          var mm = liRe.exec(lines[i].trim());
          if (!mm) break;
          items.push(mm[3]);
          i++;
        }
        out.push("<ul class='dn-ul'>" + items.map(function (x) { return "<li>" + inlineHtml(x) + "</li>"; }).join("") + "</ul>");
        continue;
      }
      // 段落
      var para = [t];
      i++;
      while (i < lines.length) {
        var nt = lines[i].trim();
        if (!nt || nt.indexOf("#") === 0 || nt.indexOf(FENCE) === 0 || nt.indexOf("> ") === 0 || liRe.test(nt)) break;
        para.push(nt);
        i++;
      }
      out.push("<p class='dn-p'>" + inlineHtml(para.join("\n")) + "</p>");
    }
    return out.join("");
  }

  // ---------- 面板骨架 ----------
  var CSS = [
    ".dn-root{position:fixed;top:0;right:0;bottom:0;z-index:2147482000;display:flex;",
    "font-family:inherit;font-size:13px;color:var(--dsw-alias-label-primary,inherit);",
    "pointer-events:none;}",
    ".dn-tab{pointer-events:auto;align-self:center;writing-mode:vertical-lr;letter-spacing:4px;",
    "padding:14px 6px;border-radius:8px 0 0 8px;cursor:pointer;user-select:none;",
    "background:var(--dsw-alias-bg-layer-2,#33383f);color:var(--dsw-alias-label-secondary,#e8e6e1);",
    "box-shadow:-2px 0 10px rgba(0,0,0,.18);font-size:12px;white-space:nowrap;}",
    ".dn-panel{pointer-events:auto;display:flex;flex-direction:column;width:100%;height:100%;",
    "background:var(--dsw-alias-bg-layer-1,#1e2128);border-left:1px solid var(--dsw-alias-border-l2,#2a2e37);",
    "box-shadow:-6px 0 24px rgba(0,0,0,.22);}",
    ".dn-resize{position:absolute;left:0;top:0;bottom:0;width:5px;cursor:col-resize;z-index:2;}",
    ".dn-bar{display:flex;align-items:center;gap:6px;padding:10px 12px;",
    "border-bottom:1px solid var(--dsw-alias-border-l2,#2a2e37);flex:none;}",
    ".dn-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
    "font-size:12px;color:var(--dsw-alias-label-secondary,#999);cursor:pointer;}",
    ".dn-btn{border:1px solid var(--dsw-alias-border-l2,#2a2e37);background:transparent;",
    "color:var(--dsw-alias-label-primary,inherit);border-radius:6px;padding:3px 8px;font-size:12px;",
    "cursor:pointer;flex:none;line-height:1.4;}",
    ".dn-btn:hover{background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.15));}",
    ".dn-btn.primary{background:var(--dsw-alias-brand-primary,#3d5a80);border-color:transparent;color:#fff;}",
    ".dn-tree{flex:1.2 1 0;overflow:auto;padding:6px 4px;min-height:90px;}",
    ".dn-row{display:flex;align-items:center;gap:5px;padding:3px 6px;border-radius:5px;cursor:pointer;",
    "white-space:nowrap;overflow:hidden;}",
    ".dn-row:hover{background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));}",
    ".dn-row.sel{background:var(--dsw-alias-brand-primary,#3d5a80);color:#fff;}",
    ".dn-name{overflow:hidden;text-overflow:ellipsis;}",
    ".dn-size{margin-left:auto;font-size:10px;opacity:.55;flex:none;}",
    ".dn-view{flex:2 1 0;display:flex;flex-direction:column;min-height:120px;",
    "border-top:1px solid var(--dsw-alias-border-l2,#2a2e37);}",
    ".dn-viewbar{display:flex;align-items:center;gap:8px;padding:7px 12px;flex:none;",
    "border-bottom:1px solid var(--dsw-alias-border-l2,#2a2e37);}",
    ".dn-file{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
    "font-size:12px;font-weight:600;}",
    ".dn-words{font-size:11px;color:var(--dsw-alias-label-tertiary,#888);}",
    ".dn-body{flex:1;overflow:auto;padding:18px 20px;}",
    ".dn-body.reading{font-size:15px;line-height:2;}",
    ".dn-p{margin:0 0 12px;text-indent:2em;}",
    ".dn-h{margin:14px 0 8px;line-height:1.4;font-weight:700;}",
    ".dn-quote{margin:0 0 12px;padding:6px 12px;border-left:3px solid var(--dsw-alias-brand-primary,#3d5a80);",
    "background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));border-radius:4px;}",
    ".dn-pre{background:var(--dsw-alias-markdown-code-block,rgba(128,128,128,.12));padding:10px 12px;",
    "border-radius:8px;overflow:auto;font-size:12px;margin:0 0 12px;white-space:pre;}",
    ".dn-ul{margin:0 0 12px;padding-left:20px;}",
    ".dn-hr{border:none;border-top:1px solid var(--dsw-alias-border-l2,#2a2e37);margin:14px 0;}",
    ".dn-body code{background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.15));padding:1px 5px;border-radius:4px;font-size:.9em;}",
    ".dn-editor{flex:1;width:100%;border:none;outline:none;resize:none;padding:14px 16px;",
    "background:transparent;color:inherit;font-family:monospace;font-size:13px;line-height:1.9;",
    "white-space:pre-wrap;}",
    ".dn-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;",
    "color:var(--dsw-alias-label-tertiary,#777);font-size:12px;}",
    ".dn-menu{position:fixed;z-index:2147483000;background:var(--dsw-alias-bg-layer-2,#2b2f36);",
    "border:1px solid var(--dsw-alias-border-l2,#3a3f49);border-radius:8px;padding:4px;min-width:120px;",
    "box-shadow:0 8px 24px rgba(0,0,0,.3);}",
    ".dn-menu div{padding:6px 12px;border-radius:5px;cursor:pointer;font-size:12.5px;}",
    ".dn-menu div:hover{background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.15));}",
    ".dn-wsrow{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#2a2e37);}",
    ".dn-wsinput{flex:1;min-width:0;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));",
    "border:1px solid var(--dsw-alias-border-l2,#3a3f49);border-radius:6px;padding:4px 8px;",
    "color:inherit;font-size:12px;outline:none;}",
  ].join("");

  var root, tab, panel, treeEl, viewEl, bodyEl, fileLabel, wordsEl, editBtnState;

  function build() {
    var style = el("style", { text: CSS });
    document.head.appendChild(style);

    root = el("div", { class: "dn-root", style: "width:" + S.width + "px" });
    tab = el("div", { class: "dn-tab", text: "文件面板", onclick: toggleOpen });
    panel = el("div", { class: "dn-panel" });

    // 顶栏：工作区
    var bar = el("div", { class: "dn-bar" }, [
      el("div", {
        class: "dn-path", title: "点击切换工作区",
        onclick: pickWorkspace,
      }),
      el("button", { class: "dn-btn", text: "刷新", onclick: function () { renderTree(); } }),
      el("button", { class: "dn-btn", text: "新文件", onclick: function () { createItem(false); } }),
      el("button", { class: "dn-btn", text: "新目录", onclick: function () { createItem(true); } }),
    ]);
    treeEl = el("div", { class: "dn-tree" });

    viewEl = el("div", { class: "dn-view" });
    var viewbar = el("div", { class: "dn-viewbar" });
    fileLabel = el("div", { class: "dn-file", text: "未打开文件" });
    wordsEl = el("div", { class: "dn-words", text: "" });
    editBtnState = el("button", { class: "dn-btn", text: "编辑", onclick: startEdit });
    viewbar.appendChild(fileLabel);
    viewbar.appendChild(wordsEl);
    viewbar.appendChild(el("div", { style: "flex:1" }));
    viewbar.appendChild(editBtnState);
    bodyEl = el("div", { class: "dn-body reading" });
    viewEl.appendChild(viewbar);
    viewEl.appendChild(bodyEl);

    panel.appendChild(bar);
    panel.appendChild(treeEl);
    panel.appendChild(viewEl);

    var resize = el("div", {
      class: "dn-resize",
      onmousedown: startResize,
    });
    panel.appendChild(resize);
    panel.style.position = "relative";

    root.appendChild(tab);
    root.appendChild(panel);
    document.body.appendChild(root);
    applyOpen();

    root.pathEl = bar.firstChild;
    renderEmpty();
    loadPrefs();
  }

  function applyOpen() {
    panel.style.display = S.open ? "flex" : "none";
    tab.style.display = S.open ? "none" : "block";
    tab.textContent = "文件面板";
    root.style.width = S.open ? S.width + "px" : "auto";
  }
  function toggleOpen() {
    S.open = !S.open;
    applyOpen();
    if (S.open && !S.workspace) loadPrefs();
  }

  function startResize(e) {
    e.preventDefault();
    var startX = e.clientX;
    var startW = S.width;
    function move(ev) {
      var w = startW + (startX - ev.clientX);
      if (w < 280) w = 280;
      if (w > Math.floor(window.innerWidth * 0.6)) w = Math.floor(window.innerWidth * 0.6);
      S.width = w;
      root.style.width = w + "px";
    }
    function up() {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  // ---------- 偏好 ----------
  function loadPrefs() {
    api("/api/prefs").then(function (p) {
      S.recents = p.recents || [];
      if (p.workspace) setWorkspace(p.workspace, true);
      else pickWorkspace();
    }).catch(function (e) { toast(e.message, true); });
  }
  function pickWorkspace() {
    bodyEl.className = "dn-body";
    bodyEl.innerHTML = "";
    var input = el("input", { class: "dn-wsinput", placeholder: "输入作品目录绝对路径（如 D:\\Novels\\我的书）" });
    var go = el("button", { class: "dn-btn primary", text: "打开", onclick: function () {
      var v = input.value.trim();
      if (v) setWorkspace(v, false);
    }});
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") go.click(); });
    var row = el("div", { class: "dn-wsrow" }, [input, go]);
    var wrap = el("div", { class: "dn-empty" });
    wrap.appendChild(el("div", { text: "选择作品工作区" }));
    wrap.appendChild(row);
    if (S.recents.length) {
      wrap.appendChild(el("div", { text: "最近使用", style: "margin-top:6px;align-self:stretch;padding:0 4px;" }));
      S.recents.forEach(function (r) {
        wrap.appendChild(el("div", {
          class: "dn-row", text: r, title: r,
          onclick: function () { setWorkspace(r, false); },
        }));
      });
    }
    bodyEl.innerHTML = "";
    bodyEl.appendChild(wrap);
    setTimeout(function () { input.focus(); }, 30);
  }
  function setWorkspace(ws, silent) {
    return api("/api/prefs", { workspace: ws }).then(function () {
      S.workspace = ws;
      S.file = null;
      root.pathEl.textContent = ws;
      root.pathEl.title = ws;
      renderTree();
      renderEmpty();
    }).catch(function (e) {
      toast(e.message, true);
      pickWorkspace();
    });
  }

  // ---------- 目录树 ----------
  function renderTree() {
    if (!S.workspace) return;
    treeEl.innerHTML = "";
    loadChildren(S.workspace, treeEl, 0);
  }
  function loadChildren(dir, container, depth) {
    api("/api/fs/list", { path: dir }).then(function (r) {
      r.entries.forEach(function (e) {
        var full = joinPath(dir, e.name);
        var row = el("div", { class: "dn-row" });
        row.style.paddingLeft = 6 + depth * 13 + "px";
        if (S.file === full) row.classList.add("sel");

        if (e.dir) {
          var arrow = el("span", { text: S.expanded[full] ? "▾" : "▸", style: "width:12px;flex:none;opacity:.7;font-size:10px;" });
          row.appendChild(arrow);
          row.appendChild(el("span", { text: "📁", style: "font-size:11px;" }));
          row.appendChild(el("span", { class: "dn-name", text: e.name }));
          row.onclick = function () {
            S.expanded[full] = !S.expanded[full];
            renderTree();
          };
          row.oncontextmenu = function (ev) { ev.preventDefault(); itemMenu(ev, full, e.name, true); };
          container.appendChild(row);
          if (S.expanded[full]) {
            var wrap = el("div");
            container.appendChild(wrap);
            loadChildren(full, wrap, depth + 1);
          }
        } else {
          row.appendChild(el("span", { style: "width:12px;flex:none;" }));
          var isTxt = isTextFile(e.name);
          row.appendChild(el("span", { text: isTxt ? "📄" : "📦", style: "font-size:11px;" }));
          row.appendChild(el("span", { class: "dn-name", text: e.name }));
          row.appendChild(el("span", { class: "dn-size", text: fmtSize(e.size) }));
          row.onclick = function () {
            if (!isTxt) { toast("仅支持文本文件预览"); return; }
            openFile(full);
          };
          row.oncontextmenu = function (ev) { ev.preventDefault(); itemMenu(ev, full, e.name, false); };
          container.appendChild(row);
        }
      });
    }).catch(function (e) {
      container.appendChild(el("div", { text: "（读取失败：" + e.message + "）", style: "padding:6px;opacity:.6;font-size:11px;" }));
    });
  }
  function fmtSize(n) {
    if (!n) return "";
    if (n < 1024) return "";
    if (n < 1024 * 1024) return Math.round(n / 1024) + "K";
    return (n / 1024 / 1024).toFixed(1) + "M";
  }

  function itemMenu(ev, full, name, isDir) {
    closeMenu();
    var menu = el("div", { class: "dn-menu" });
    menu.appendChild(el("div", { text: "重命名", onclick: function () { closeMenu(); renameItem(full, name); } }));
    menu.appendChild(el("div", { text: "删除", onclick: function () { closeMenu(); deleteItem(full, name, isDir); } }));
    menu.style.left = ev.clientX + "px";
    menu.style.top = Math.min(ev.clientY, window.innerHeight - 110) + "px";
    document.body.appendChild(menu);
    setTimeout(function () {
      document.addEventListener("mousedown", closeMenuOnce);
    }, 0);
    function closeMenuOnce() { closeMenu(); }
    window.__dnCloseMenu = closeMenu;
  }
  function closeMenu() {
    var old = document.querySelector(".dn-menu");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    document.removeEventListener("mousedown", closeMenu);
  }

  function createItem(isDir) {
    if (!S.workspace) return;
    var name = prompt(isDir ? "新目录名（可含相对路径）" : "新文件名（如 正文/第001章-开篇.md）");
    if (!name) return;
    var full = joinPath(S.workspace, name);
    var call = isDir ? api("/api/fs/mkdir", { path: full }) : api("/api/fs/write", { path: full, content: "" });
    call.then(function () {
      var parts = name.replace(/\\/g, "/").split("/");
      parts.pop();
      var cur = S.workspace;
      parts.forEach(function (p) { cur = joinPath(cur, p); S.expanded[cur] = true; });
      renderTree();
      if (!isDir) openFile(full);
      toast(isDir ? "目录已创建" : "文件已创建");
    }).catch(function (e) { toast(e.message, true); });
  }
  function renameItem(full, name) {
    var nn = prompt("重命名", name);
    if (!nn || nn === name) return;
    api("/api/fs/rename", { path: full, newName: nn }).then(function () {
      if (S.file === full) { S.file = null; renderEmpty(); }
      renderTree();
      toast("已重命名");
    }).catch(function (e) { toast(e.message, true); });
  }
  function deleteItem(full, name, isDir) {
    var hint = isDir ? "目录及其全部内容将删除" : "确定删除该文件？";
    if (!confirm(hint + "\n" + name)) return;
    api("/api/fs/delete", { path: full }).then(function () {
      if (S.file === full) { S.file = null; renderEmpty(); }
      renderTree();
      toast("已删除");
    }).catch(function (e) { toast(e.message, true); });
  }

  // ---------- 预览 / 编辑 ----------
  function renderEmpty() {
    bodyEl.className = "dn-body";
    bodyEl.innerHTML = "";
    var e0 = el("div", { class: "dn-empty" }, [
      el("div", { text: "📂" }),
      el("div", { text: "点击左侧文件预览" }),
    ]);
    bodyEl.appendChild(e0);
    fileLabel.textContent = "未打开文件";
    wordsEl.textContent = "";
    editBtnState.style.display = "";
    editBtnState.textContent = "编辑";
  }

  function openFile(full) {
    S.file = full;
    api("/api/fs/read", { path: full }).then(function (r) {
      S.content = r.content;
      S.saved = r.content;
      S.mode = "view";
      renderView();
      renderTree();
    }).catch(function (e) { toast(e.message, true); });
  }

  function renderView() {
    fileLabel.textContent = baseName(S.file);
    fileLabel.title = S.file;
    var isMd = /\.md$/i.test(S.file);
    if (S.mode === "view") {
      bodyEl.className = "dn-body reading";
      bodyEl.innerHTML = isMd ? mdToHtml(S.content) : "<p class='dn-p' style='text-indent:0;white-space:pre-wrap;'>" + esc(S.content) + "</p>";
      wordsEl.textContent = countWords(S.content) + " 字";
      editBtnState.textContent = "编辑";
      editBtnState.style.display = "";
    } else {
      bodyEl.className = "dn-body";
      bodyEl.innerHTML = "";
      var ta = el("textarea", { class: "dn-editor", spellcheck: "false" });
      ta.value = S.content;
      ta.addEventListener("input", function () {
        S.content = ta.value;
        S.dirty = ta.value !== S.saved;
        wordsEl.textContent = countWords(S.content) + " 字" + (S.dirty ? " · 未保存" : "");
        editBtnState.textContent = S.dirty ? "保存" : "完成";
      });
      ta.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          saveEdit();
        }
        if (e.key === "Escape") { finishEdit(true); }
      });
      bodyEl.appendChild(ta);
      wordsEl.textContent = countWords(S.content) + " 字" + (S.dirty ? " · 未保存" : "");
      editBtnState.textContent = "完成";
      setTimeout(function () { ta.focus(); }, 30);
    }
  }

  function startEdit() {
    if (S.mode === "view") {
      if (!S.file) return;
      S.mode = "edit";
      S.dirty = false;
      renderView();
    } else {
      if (S.dirty) saveEdit();
      else finishEdit(false);
    }
  }
  function saveEdit() {
    api("/api/fs/write", { path: S.file, content: S.content }).then(function () {
      S.saved = S.content;
      S.dirty = false;
      toast("已保存");
      finishEdit(false);
    }).catch(function (e) { toast(e.message, true); });
  }
  function finishEdit(askSave) {
    if (askSave && S.dirty) {
      if (confirm("有未保存的修改，保存吗？")) { saveEdit(); return; }
    }
    S.mode = "view";
    renderView();
  }

  function countWords(t) {
    var cjk = 0, word = 0, inWord = false;
    for (var i = 0; i < t.length; i++) {
      var c = t.charCodeAt(i);
      var isCjk = (c >= 0x2e80 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff);
      var isW = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
      if (isCjk) { cjk++; inWord = false; }
      else if (isW) { if (!inWord) { word++; inWord = true; } }
      else inWord = false;
    }
    return cjk + word;
  }

  // 启动
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
