use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

pub type BoxResult<T> = Result<T, Box<dyn std::error::Error>>;

/// 子进程不创建控制台窗口（Windows GUI 宿主启动 node 子进程时避免黑框闪现）。
trait SpawnPrivacy {
    fn no_window(&mut self);
}

#[cfg(windows)]
impl SpawnPrivacy for Command {
    fn no_window(&mut self) {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x0800_0000);
    }
}

#[cfg(not(windows))]
impl SpawnPrivacy for Command {
    fn no_window(&mut self) {}
}

/// 资源路径集（打包与开发两形态同构）。
#[derive(Clone)]
pub struct Paths {
    pub node_bin: String,
    pub kernel_bin: PathBuf,
    pub provision_script: PathBuf,
    pub library: PathBuf,
    pub dsh_home: PathBuf,
    pub app_data: PathBuf,
}

/// 内核进程状态（Drop 时杀进程）。
pub struct KernelState {
    pub child: Option<Child>,
    pub kernel_port: u16,
    pub last_error: Option<String>,
}

impl KernelState {
    pub fn new() -> Self {
        Self { child: None, kernel_port: 0, last_error: None }
    }

    pub fn kill(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Drop for KernelState {
    fn drop(&mut self) {
        self.kill();
    }
}

fn dev_base() -> Option<PathBuf> {
    option_env!("CARGO_MANIFEST_DIR")
        .and_then(|d| Path::new(d).parent().map(|p| p.to_path_buf()))
}

pub fn resolve_paths<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> BoxResult<Paths> {
    let home_override = std::env::var("DSH_NOVEL_HOME").ok().filter(|s| !s.trim().is_empty());
    let user_home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .unwrap_or_else(|_| ".".into());
    let dsh_home = match home_override {
        Some(h) => PathBuf::from(h),
        None => Path::new(&user_home).join(".dsh-novel"),
    };
    let app_data = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| dsh_home.clone());

    // 打包形态：resource_dir 下 {kernel, agents, scripts, node}
    if let Ok(r) = app.path().resource_dir() {
        // verbatim 绝对化：杜绝盘符相对路径（'D:xxx'）传入 node 导致 EISDIR
        let r = std::fs::canonicalize(&r).unwrap_or(r);
        let kernel_bin = r
            .join("kernel").join("node_modules").join("@deepseek-ai")
            .join("dsh").join("lib").join("bin.js");
        if kernel_bin.exists() {
            let node_candidate = if cfg!(windows) {
                r.join("node").join("node.exe")
            } else {
                r.join("node").join("bin").join("node")
            };
            let node_bin = if node_candidate.exists() {
                node_candidate.to_string_lossy().into_owned()
            } else {
                "node".to_string()
            };
            return Ok(Paths {
                node_bin,
                kernel_bin,
                provision_script: r.join("scripts").join("provision-home.mjs"),
                library: r.join("agents"),
                dsh_home,
                app_data,
            });
        }
    }

    // 开发形态：app/{kernel,agents,scripts}，node 用系统 PATH。
    let base = dev_base().unwrap_or_else(|| PathBuf::from("."));
    let base = std::fs::canonicalize(&base).unwrap_or(base);
    let kernel_bin = base
        .join("kernel").join("node_modules").join("@deepseek-ai")
        .join("dsh").join("lib").join("bin.js");
    if !kernel_bin.exists() {
        return Err("kernel bin.js not found（安装资源缺失或损坏）".into());
    }
    Ok(Paths {
        node_bin: "node".into(),
        kernel_bin: base
            .join("kernel").join("node_modules").join("@deepseek-ai")
            .join("dsh").join("lib").join("bin.js"),
        provision_script: base.join("scripts").join("provision-home.mjs"),
        library: base.join("agents"),
        dsh_home,
        app_data,
    })
}

/// 挑一个可用端口（绑定即释放，存在极小竞态——可接受）。
pub fn pick_port(base: u16) -> u16 {
    for p in base..base + 40 {
        if TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return p;
        }
    }
    base
}

fn provision(paths: &Paths) -> BoxResult<()> {
    let mut child = Command::new(&paths.node_bin)
        .arg(&paths.provision_script)
        .arg("--home").arg(&paths.dsh_home)
        .arg("--library").arg(&paths.library)
        .env("DSH_HOME", &paths.dsh_home)
        // 关键：显式设置绝对工作目录。双击启动时 Windows 可能给出盘符相对
        // CWD（如 "D:"），node 模块解析对其 realpath 会 EISDIR 直接炸掉。
        .current_dir(&paths.dsh_home)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window()
        .spawn()?;
    let start = Instant::now();
    let status = loop {
        match child.try_wait()? {
            Some(st) => break st,
            None => {
                if start.elapsed() > Duration::from_secs(90) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("provision 超时（90 秒未完成，已终止）".into());
                }
                std::thread::sleep(Duration::from_millis(300));
            }
        }
    };
    if !status.success() {
        let out = child.wait_with_output()?;
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("provision 失败：{}", err.trim()).into());
    }
    Ok(())
}
// ---- token URL 捕获（stdout/stderr 读线程 → 全局缓冲） ----

static TOKEN_URL: Mutex<Option<String>> = Mutex::new(None);
static ERR_TAIL: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn record_line(line: &str, is_err: bool) {
    if is_err {
        if let Ok(mut v) = ERR_TAIL.lock() {
            v.push(line.to_string());
            let n = v.len();
            if n > 40 {
                v.drain(0..n - 40);
            }
        }
    }
    if let Some(u) = extract_token_url(line) {
        if let Ok(mut slot) = TOKEN_URL.lock() {
            if slot.is_none() {
                *slot = Some(u);
            }
        }
    }
}

fn err_tail() -> String {
    match ERR_TAIL.lock() {
        Ok(v) => v.join("\n"),
        Err(_) => String::new(),
    }
}

/// 启动失败浮层：写进加载页的 #boot-msg（已跳转到 WebUI 时静默无效）。
pub fn surface_error(handle: &AppHandle, msg: &str) {
    let json = serde_json::json!(msg).to_string();
    let h = handle.clone();
    let _ = handle.run_on_main_thread(move || {
        if let Some(w) = h.get_webview_window("main") {
            let _ = w.eval(&format!(
                "var d=document.getElementById('boot-msg');if(d){{d.textContent='启动失败：'+{json};d.style.display='block';var s=document.querySelector('.bar');if(s)s.style.display='none';}}"
            ));
        }
    });
}

/// 加载页状态行更新（#boot-status）。
pub fn set_status(handle: &AppHandle, msg: &str) {
    boot_log(msg);
    let json = serde_json::json!(msg).to_string();
    let h = handle.clone();
    let _ = handle.run_on_main_thread(move || {
        if let Some(w) = h.get_webview_window("main") {
            let _ = w.eval(&format!(
                "var d=document.getElementById('boot-status');if(d)d.textContent={json};"
            ));
        }
    });
}

/// boot 过程日志（<dsh_home>/logs/boot.log）。
pub fn boot_log(msg: &str) {
    let home = std::env::var("DSH_NOVEL_HOME").ok().unwrap_or_else(|| {
        std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(|h| Path::new(&h).join(".dsh-novel").to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    if home.is_empty() { return; }
    let dir = Path::new(&home).join("logs");
    if std::fs::create_dir_all(&dir).is_err() { return; }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    let line = format!("[{stamp}] {msg}\n");
    let _ = std::fs::OpenOptions::new().create(true).append(true)
        .open(dir.join("boot.log")).and_then(|mut f| f.write_all(line.as_bytes()));
}
/// 轻量匹配 http(s)://127.0.0.1:PORT/?token=XXXX（不用正则依赖）。
fn extract_token_url(line: &str) -> Option<String> {
    let bt = char::from(96);
    let mut best: Option<String> = None;
    let mut search_from = 0usize;
    while let Some(rel) = line[search_from..].find("://127.0.0.1:") {
        let start = match line[..search_from + rel].rfind("http") {
            Some(p) => p,
            None => {
                search_from += rel + 14;
                if search_from >= line.len() {
                    break;
                }
                continue;
            }
        };
        let rest = &line[start..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ')' || c == '<' || c == bt)
            .unwrap_or(rest.len());
        let cand = &rest[..end];
        if cand.contains("/?token=") {
            best = Some(cand.to_string());
        }
        search_from = start + end.max(1);
        if search_from >= line.len() {
            break;
        }
    }
    best
}

/// 启动内核并等待 token URL（回退：HTTP 就绪后用普通 URL）。
pub fn boot(handle: AppHandle) -> BoxResult<()> {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    boot_log(&format!("launch exe={exe} cwd={cwd}"));
    set_status(&handle, "正在定位运行资源…");
    let paths = resolve_paths(&handle)?;
    boot_log(&format!(
        "resolved node={} kernel={} provision={} library={} home={}",
        paths.node_bin, paths.kernel_bin.display(), paths.provision_script.display(),
        paths.library.display(), paths.dsh_home.display()
    ));
    std::fs::create_dir_all(&paths.dsh_home)?;
    set_status(&handle, "正在初始化智能体预设（provision）…");
    provision(&paths)?;
    set_status(&handle, "正在启动 DSH 内核…");

    let port = pick_port(51820);
    let mut child = Command::new(&paths.node_bin)
        .arg(&paths.kernel_bin)
        .arg("web")
        .arg("--host").arg("127.0.0.1")
        .arg("--port").arg(port.to_string())
        .arg("--no-open")
        .current_dir(&paths.dsh_home)
        .env("DSH_HOME", &paths.dsh_home)
        .env("DSH_TELEMETRY_DISABLED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window()
        .spawn()?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let state = handle.state::<crate::AppState>();
        let mut k = state.kernel.lock().unwrap();
        k.kernel_port = port;
        k.child = Some(child);
    }

    if let Some(out) = stdout {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(|l| l.ok()) {
                println!("[kernel] {line}");
                record_line(&line, false);
            }
        });
    }
    if let Some(err) = stderr {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(|l| l.ok()) {
                eprintln!("[kernel] {line}");
                record_line(&line, true);
            }
        });
    }

    // 轮询：先等 token URL；内核早退立即报错；HTTP 就绪后宽限 3 秒收 token。
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut http_ready_at: Option<Instant> = None;
    let mut last_status = Instant::now();
    let url = loop {
        if let Ok(slot) = TOKEN_URL.lock() {
            if let Some(u) = slot.clone() {
                break u;
            }
        }
        // 内核早退 → 立即失败并带 stderr 尾部
        {
            let state = handle.state::<crate::AppState>();
            let exited = state
                .kernel
                .lock()
                .unwrap()
                .child
                .as_mut()
                .and_then(|c| c.try_wait().ok())
                .flatten();
            if let Some(status) = exited {
                let msg = format!(
                    "内核进程已退出（{status}）。\n{}",
                    if err_tail().is_empty() { "（无错误输出）".to_string() } else { err_tail() }
                );
                surface_error(&handle, &msg);
                return Err(msg.into());
            }
        }
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            if http_ready_at.is_none() {
                http_ready_at = Some(Instant::now());
            }
            if http_ready_at.unwrap().elapsed() > Duration::from_secs(3) {
                break format!("http://127.0.0.1:{port}/");
            }
        }
        if last_status.elapsed() > Duration::from_secs(5) {
            last_status = Instant::now();
            let secs = deadline.saturating_duration_since(Instant::now()).as_secs();
            set_status(&handle, &format!("正在等待内核 Web 端口就绪（{port}，剩余 {secs} 秒）…"));
        }
        if Instant::now() > deadline {
            let msg = format!(
                "120 秒内内核 Web 服务未就绪。\n{}",
                if err_tail().is_empty() { "（无错误输出）".to_string() } else { err_tail() }
            );
            surface_error(&handle, &msg);
            if let Some(state) = handle.try_state::<crate::AppState>() {
                state.kernel.lock().unwrap().last_error = Some(msg.clone());
            }
            return Err(msg.into());
        }
        std::thread::sleep(Duration::from_millis(400));
    };

    let h = handle.clone();
    let _ = handle.run_on_main_thread(move || {
        if let Some(w) = h.get_webview_window("main") {
            let _ = w.eval(&format!("location.replace({:?})", url));
        }
    });
    Ok(())
}

/// 注入的文件面板脚本（端口占位替换）。
pub fn panel_js(side_port: u16) -> String {
    let raw = include_str!("inject/panel.js");
    raw.replace("__SIDE_PORT__", &side_port.to_string())
}
