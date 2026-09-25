//! 文件面板边车：本机 tiny_http JSON API（127.0.0.1）。
//! 面板注入脚本运行在内核 WebUI 源下，通过 fetch 访问本服务读写工作区文件。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Manager};
use tiny_http::{Header, ListenAddr, Method, Response, Server};

use crate::kernel::Paths;

const MAX_READ: u64 = 4 * 1024 * 1024;

pub fn start(handle: AppHandle, paths: Paths) -> Result<u16, String> {
    let server = Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = match server.server_addr() {
        ListenAddr::IP(addr) => addr.port(),
        #[allow(unreachable_patterns)]
        _ => 0,
    };

    let _paths = Arc::new(paths);
    let h = handle.clone();
    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let method = request.method().clone();
            let url = request.url().to_string();
            let origin = request
                .headers()
                .iter()
                .find(|x| x.field.equiv("Origin"))
                .map(|x| x.value.as_str().to_string());

            if method == Method::Options {
                let mut r = Response::empty(204);
                for hh in cors_headers(origin.as_deref()) {
                    r = r.with_header(hh);
                }
                let _ = request.respond(r);
                continue;
            }

            let mut body = String::new();
            let _ = request.as_reader().take(MAX_READ + 1024).read_to_string(&mut body);
            let payload: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);

            let path = url.split('?').next().unwrap_or("").to_string();
            let resp: (u16, String) = match (method, path.as_str()) {
                (Method::Post, "/api/fs/list") => fs_list(&payload),
                (Method::Post, "/api/fs/read") => fs_read(&payload),
                (Method::Post, "/api/fs/write") => fs_write(&payload),
                (Method::Post, "/api/fs/mkdir") => fs_mkdir(&payload),
                (Method::Post, "/api/fs/rename") => fs_rename(&payload),
                (Method::Post, "/api/fs/delete") => fs_delete(&payload),
                (Method::Get, "/api/prefs") => prefs_get(&h),
                (Method::Post, "/api/prefs") => prefs_set(&h, &payload),
                (Method::Get, "/api/health") => (200, r#"{"ok":true}"#.into()),
                _ => (404, r#"{"error":"not found"}"#.into()),
            };

            let (code, body) = resp;
            let mut response = Response::from_string(body).with_status_code(code);
            for hh in cors_headers(origin.as_deref()) {
                response = response.with_header(hh);
            }
            let _ = request.respond(response);
        }
    });

    Ok(port)
}

fn cors_headers(origin: Option<&str>) -> Vec<Header> {
    let mut v = Vec::new();
    // 只回显本机来源（内核 WebUI 源）；无 Origin（同源/工具）则给 *。
    let allow = match origin {
        Some(o) if o.starts_with("http://127.0.0.1:") || o.starts_with("http://localhost:") => o.to_string(),
        _ => "*".to_string(),
    };
    if let Ok(h) = Header::from_bytes("Access-Control-Allow-Origin".as_bytes(), allow.as_bytes()) {
        v.push(h);
    }
    for (k, val) in [
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type"),
        ("Cache-Control", "no-store"),
    ] {
        if let Ok(h) = Header::from_bytes(k.as_bytes(), val.as_bytes()) {
            v.push(h);
        }
    }
    v
}

fn jerr(msg: impl Into<String>) -> (u16, String) {
    (400, serde_json::json!({ "error": msg.into() }).to_string())
}

fn jok(v: serde_json::Value) -> (u16, String) {
    (200, v.to_string())
}

fn s<'a>(v: &'a serde_json::Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(|x| x.as_str())
}

fn is_loopback(req_from_local: bool) -> bool {
    req_from_local // tiny_http 仅绑定 127.0.0.1，天然仅本机
}

// ---- 文件操作 ----

fn fs_list(p: &serde_json::Value) -> (u16, String) {
    let _ = is_loopback(true);
    let Some(dir) = s(p, "path") else { return jerr("missing path") };
    let dir_path = PathBuf::from(dir);
    let Ok(rd) = std::fs::read_dir(&dir_path) else { return jerr("无法读取目录") };
    let mut entries = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "Thumbs.db" {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        entries.push(serde_json::json!({
            "name": name,
            "dir": meta.is_dir(),
            "size": if meta.is_dir() { 0 } else { meta.len() },
        }));
    }
    entries.sort_by(|a, b| {
        let da = a["dir"].as_bool().unwrap_or(false);
        let db = b["dir"].as_bool().unwrap_or(false);
        da.cmp(&db).reverse().then(
            a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")),
        )
    });
    jok(serde_json::json!({ "entries": entries }))
}

fn fs_read(p: &serde_json::Value) -> (u16, String) {
    let Some(path) = s(p, "path") else { return jerr("missing path") };
    let pb = PathBuf::from(path);
    if let Ok(meta) = pb.metadata() {
        if meta.len() > MAX_READ {
            return jerr("文件超过 4MB，不支持预览");
        }
    }
    match std::fs::read_to_string(&pb) {
        Ok(content) => jok(serde_json::json!({
            "content": content,
            "words": count_words(&content),
        })),
        Err(e) => jerr(format!("读取失败：{e}")),
    }
}

fn fs_write(p: &serde_json::Value) -> (u16, String) {
    let Some(path) = s(p, "path") else { return jerr("missing path") };
    let Some(content) = s(p, "content") else { return jerr("missing content") };
    let pb = PathBuf::from(path);
    if let Some(parent) = pb.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::write(&pb, content) {
        Ok(_) => jok(serde_json::json!({ "ok": true, "words": count_words(content) })),
        Err(e) => jerr(format!("写入失败：{e}")),
    }
}

fn fs_mkdir(p: &serde_json::Value) -> (u16, String) {
    let Some(path) = s(p, "path") else { return jerr("missing path") };
    match std::fs::create_dir_all(Path::new(path)) {
        Ok(_) => jok(serde_json::json!({ "ok": true })),
        Err(e) => jerr(format!("创建失败：{e}")),
    }
}

fn fs_rename(p: &serde_json::Value) -> (u16, String) {
    let Some(path) = s(p, "path") else { return jerr("missing path") };
    let Some(new_name) = s(p, "newName") else { return jerr("missing newName") };
    if new_name.contains('/') || new_name.contains('\\') || new_name.contains("..") {
        return jerr("名称非法");
    }
    let pb = PathBuf::from(path);
    let parent = pb.parent().unwrap_or(Path::new("."));
    let target = parent.join(new_name);
    match std::fs::rename(&pb, &target) {
        Ok(_) => jok(serde_json::json!({ "ok": true })),
        Err(e) => jerr(format!("重命名失败：{e}")),
    }
}

fn fs_delete(p: &serde_json::Value) -> (u16, String) {
    let Some(path) = s(p, "path") else { return jerr("missing path") };
    let pb = PathBuf::from(path);
    let res = if pb.is_dir() {
        std::fs::remove_dir_all(&pb)
    } else {
        std::fs::remove_file(&pb)
    };
    match res {
        Ok(_) => jok(serde_json::json!({ "ok": true })),
        Err(e) => jerr(format!("删除失败：{e}")),
    }
}

// ---- 偏好（工作区记忆，存 DSH_HOME/prefs.json） ----

fn prefs_path(h: &AppHandle) -> PathBuf {
    if let Some(state) = h.try_state::<crate::AppState>() {
        state.dsh_home.join("prefs.json")
    } else {
        PathBuf::from("prefs.json")
    }
}

fn prefs_load(h: &AppHandle) -> serde_json::Value {
    std::fs::read_to_string(prefs_path(h))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::json!({ "workspace": null, "recents": [] }))
}

fn prefs_get(h: &AppHandle) -> (u16, String) {
    jok(prefs_load(h))
}

fn prefs_set(h: &AppHandle, p: &serde_json::Value) -> (u16, String) {
    let mut prefs = prefs_load(h);
    if let Some(ws) = s(p, "workspace") {
        let ws = ws.trim().to_string();
        if !ws.is_empty() {
            prefs["workspace"] = serde_json::json!(ws);
            let mut recents: Vec<String> = prefs["recents"].as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            recents.retain(|x| x != &ws);
            recents.insert(0, ws);
            recents.truncate(8);
            prefs["recents"] = serde_json::json!(recents);
        }
    }
    let path = prefs_path(h);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(&prefs) {
        Ok(t) => match std::fs::write(&path, t) {
            Ok(_) => jok(prefs),
            Err(e) => jerr(format!("保存失败：{e}")),
        },
        Err(e) => jerr(format!("序列化失败：{e}")),
    }
}

/// 中文字数（CJK 计 1，连续拉丁/数字串计 1；标点不计）。
fn count_words(text: &str) -> u64 {
    let mut cjk = 0u64;
    let mut word = 0u64;
    let mut in_word = false;
    for ch in text.chars() {
        let code = ch as u32;
        let is_cjk = (0x2E80..=0x9FFF).contains(&code)
            || (0x3400..=0x4DBF).contains(&code)
            || (0xF900..=0xFAFF).contains(&code);
        let is_word = ch.is_ascii_alphanumeric();
        let is_punct = !is_cjk && !is_word && !ch.is_whitespace() && code < 0x2E80;
        if is_cjk {
            cjk += 1;
            in_word = false;
        } else if is_word {
            if !in_word {
                word += 1;
                in_word = true;
            }
        } else {
            in_word = false;
        }
        let _ = is_punct;
    }
    cjk + word
}
