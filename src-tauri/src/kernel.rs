use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

pub type BoxResult<T> = Result<T, Box<dyn std::error::Error>>;

/// 资源路径集（打包与开发两形态同构）。
#[derive(Clone)]
pub struct Paths {
    pub node_bin: String,
    pub kernel_bin: PathBuf,
    pub provision_script: PathBuf,
    pub library: PathBuf,
    pub dsh_home: PathBuf,
    pub app_data: PathBuf,
    /// 资源基准目录（node/node_modules 所在的上级）
    pub base: PathBuf,
    /// 在线模式：内核缺失时允许首启下载
    pub online: bool,
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

    // 基准目录候选（全部绝对路径，与工作目录完全解耦——双击启动时 CWD 不可靠）：
    //   资源目录 / 资源目录下 resources|staging / exe 同级 / exe 同级 resources|../resources / 开发树
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Ok(r) = app.path().resource_dir() {
        bases.push(r.clone());
        bases.push(r.join("resources"));
        bases.push(r.join("staging"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(ed) = exe.parent() {
            bases.push(ed.to_path_buf());
            bases.push(ed.join("resources"));
            bases.push(ed.join("..").join("resources"));
        }
    }
    if let Some(b) = dev_base() {
        bases.push(b);
    }

    let rel_kernel = Path::new("kernel").join("node_modules").join("@deepseek-ai")
        .join("dsh").join("lib").join("bin.js");
    // 两轮：先找“内核已就绪”的基准；找不到再找“带在线清单”的基准（首启下载）。
    for need_bin in [true, false] {
        for base in &bases {
            let kernel_bin = base.join(&rel_kernel);
            let manifest = base.join("kernel-manifest.json");
            let bin_ok = kernel_bin.exists();
            let online_ok = manifest.exists() && manifest.is_file();
            if need_bin && !bin_ok {
                continue;
            }
            if !need_bin && (bin_ok || !online_ok) {
                continue;
            }
            let node_candidate = if cfg!(windows) {
                base.join("node").join("node.exe")
            } else {
                base.join("node").join("bin").join("node")
            };
            let node_bin = if node_candidate.exists() {
                node_candidate.to_string_lossy().into_owned()
            } else {
                "node".to_string()
            };
            return Ok(Paths {
                node_bin,
                kernel_bin,
                provision_script: base.join("scripts").join("provision-home.mjs"),
                library: base.join("agents"),
                dsh_home,
                app_data,
                base: base.clone(),
                online: !need_bin && !bin_ok,
            });
        }
    }

    // 开发形态兜底：app/{kernel,agents,scripts}，node 用系统 PATH。
    if let Some(base) = dev_base() {
        return Ok(Paths {
            node_bin: "node".into(),
            kernel_bin: base
                .join("kernel").join("node_modules").join("@deepseek-ai")
                .join("dsh").join("lib").join("bin.js"),
            provision_script: base.join("scripts").join("provision-home.mjs"),
            library: base.join("agents"),
            dsh_home,
            app_data,
            base: base.clone(),
            online: false,
        });
    }

    Err(format!(
        "找不到内核资源（kernel/node_modules/@deepseek-ai/dsh/lib/bin.js）。\
已探测基准目录：{}",
        bases.iter().map(|b| b.to_string_lossy().into_owned()).collect::<Vec<_>>().join("；")
    ).into())
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
    let status = Command::new(&paths.node_bin)
        .arg(&paths.provision_script)
        .arg("--home").arg(&paths.dsh_home)
        .arg("--library").arg(&paths.library)
        .env("DSH_HOME", &paths.dsh_home)
        .output()?;
    if !status.status.success() {
        let err = String::from_utf8_lossy(&status.stderr);
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
    let paths = resolve_paths(&handle)?;
    std::fs::create_dir_all(&paths.dsh_home)?;

    // 在线模式：内核缺失 → 首启下载（Node + 钉版 dsh），进度推到加载页。
    if paths.online && !paths.kernel_bin.exists() {
        let h = handle.clone();
        let set_status = move |m: String| {
            let hh = h.clone();
            let _ = hh.run_on_main_thread(move || {
                if let Some(w) = hh.get_webview_window("main") {
                    let json = serde_json::json!(m).to_string();
                    let _ = w.eval(&format!(
                        "var d=document.getElementById('boot-msg');if(d){{d.textContent={json};d.style.display='block';}}"
                    ));
                }
            });
        };
        set_status("首次启动：正在准备 DSH 运行环境…".into());
        ensure_kernel_online(&paths.base, &paths.dsh_home, NODE_PIN, DSH_PIN, &set_status)?;
    }

    provision(&paths)?;

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
        .spawn()?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let state = handle.state::<crate::AppState>();
        let mut k = state.kernel.lock().unwrap();
        k.kernel_port = port;
        k.child = Some(child);
    }

    let log_path = paths.dsh_home.join("logs").join("web.log");
    let _ = std::fs::create_dir_all(log_path.parent().unwrap_or(Path::new(".")));
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok();
    let log = std::sync::Arc::new(Mutex::new(log_file));

    if let Some(out) = stdout {
        let log = log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(|l| l.ok()) {
                println!("[kernel] {line}");
                if let Ok(mut guard) = log.lock() {
                    if let Some(f) = guard.as_mut() {
                        let _ = writeln!(f, "{line}");
                    }
                }
                record_line(&line, false);
            }
        });
    }
    if let Some(err) = stderr {
        let log = log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(|l| l.ok()) {
                eprintln!("[kernel] {line}");
                if let Ok(mut guard) = log.lock() {
                    if let Some(f) = guard.as_mut() {
                        let _ = writeln!(f, "[stderr] {line}");
                    }
                }
                record_line(&line, true);
            }
        });
    }

    // 轮询：先等 token URL；内核早退立即报错；HTTP 就绪后宽限 3 秒收 token。
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut http_ready_at: Option<Instant> = None;
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


// ---- 在线模式：首启拉取 + 应用内更新 ---------------------------------------

pub const DSH_PIN: &str = "0.1.2-rc.1";
pub const NODE_PIN: &str = "24.19.0";

fn plat_key() -> (&'static str, &'static str) {
    if cfg!(target_os = "windows") {
        ("win", if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" })
    } else if cfg!(target_os = "macos") {
        ("mac", if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" })
    } else {
        ("linux", if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" })
    }
}

/// 读当前已安装的 dsh 版本（kernel/package.json → node_modules/@deepseek-ai/dsh/package.json）。
pub fn current_dsh_version(base: &Path) -> Option<String> {
    let p = base.join("kernel").join("node_modules").join("@deepseek-ai")
        .join("dsh").join("package.json");
    let t = std::fs::read_to_string(p).ok()?;
    let v = t.split("\"version\"").nth(1)?;
    let v = v.split(':').nth(1)?;
    let v = v.trim().trim_matches(|c| c == '"' || c == ',' || c == ' ' || c == '\n' || c == '\r');
    Some(v.to_string())
}

/// 从 npm registry 查最新版本（npmmirror 优先，官方回退）。
pub fn fetch_latest_dsh() -> BoxResult<String> {
    let urls = [
        "https://registry.npmmirror.com/@deepseek-ai/dsh/latest",
        "https://registry.npmjs.org/@deepseek-ai/dsh/latest",
    ];
    for u in urls {
        let ok = std::net::TcpStream::connect(("registry.npmmirror.com", 443)).is_ok()
            || std::net::TcpStream::connect(("registry.npmjs.org", 443)).is_ok()
            || true;
        let _ = ok;
        let out = std::process::Command::new(node_for_fetch())
            .arg("-e")
            .arg(format!(
                "fetch('{u}').then(r=>r.json()).then(j=>console.log('VER:'+j.version)).catch(e=>{{console.error(e.message);process.exit(1)}})",
                u = u
            ))
            .output();
        if let Ok(o) = out {
            if o.status.success() {
                let t = String::from_utf8_lossy(&o.stdout);
                for line in t.lines() {
                    if let Some(v) = line.strip_prefix("VER:") {
                        return Ok(v.trim().to_string());
                    }
                }
            }
        }
    }
    Err("无法获取最新版本（npm 镜像均不可达）".into())
}

fn node_for_fetch() -> String {
    "node".to_string()
}

/// 首启在线引导：内核缺失时，下载 Node（若缺）→ npm 安装钉版 dsh。
/// 进度经 set_status 推到加载页。
pub fn ensure_kernel_online(
    base: &Path,
    dsh_home: &Path,
    node_pin: &str,
    dsh_pin: &str,
    set_status: &dyn Fn(String),
) -> BoxResult<()> {
    let plat = plat_key().0;
    let (_, arch) = plat_key();
    std::fs::create_dir_all(base)?;

    // 1) Node 运行时
    let node_candidate = if cfg!(windows) {
        base.join("node").join("node.exe")
    } else {
        base.join("node").join("bin").join("node")
    };
    if !node_candidate.exists() {
        set_status("正在下载 Node 运行时…".into());
        let (file_name, kind) = if cfg!(windows) {
            (format!("node-v{}-win-{}.zip", node_pin, arch), "zip")
        } else if cfg!(target_os = "macos") {
            (format!("node-v{}-darwin-{}.tar.gz", node_pin, arch), "targz")
        } else {
            (format!("node-v{}-linux-{}.tar.gz", node_pin, arch), "targz")
        };
        let urls = [
            format!("https://nodejs.org/dist/v{}/{}", node_pin, file_name),
            format!("https://npmmirror.com/mirrors/node/v{}/{}", node_pin, file_name),
        ];
        let tmp = base.join(format!(".dl-{}", file_name));
        let mut downloaded = false;
        for u in urls {
            set_status(format!("正在下载 Node：{}", u));
            let out = std::process::Command::new("curl")
                .args(["-fSL", "--retry", "2", "-o"])
                .arg(&tmp)
                .arg(&u)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if let Ok(s) = out {
                if s.success() && tmp.exists() {
                    downloaded = true;
                    break;
                }
            }
        }
        if !downloaded {
            return Err("Node 运行时下载失败（nodejs.org 与镜像均不可达）".into());
        }
        set_status("正在解压 Node 运行时…".into());
        let extract = base.join(".node-extract");
        let _ = std::fs::remove_dir_all(&extract);
        std::fs::create_dir_all(&extract)?;
        let st = if kind == "zip" {
            std::process::Command::new("tar").args(["-xf"]).arg(&tmp).arg("-C").arg(&extract).status()
        } else {
            std::process::Command::new("tar").args(["-xzf"]).arg(&tmp).arg("-C").arg(&extract).status()
        }?;
        let _ = std::fs::remove_file(&tmp);
        if !st.success() {
            return Err("Node 运行时解压失败".into());
        }
        let inner = std::fs::read_dir(&extract)?
            .filter_map(|e| e.ok())
            .find(|e| e.path().is_dir())
            .map(|e| e.path())
            .unwrap_or_else(|| extract.clone());
        if cfg!(windows) {
            for f in ["node.exe"] {
                std::fs::copy(inner.join(f), node_candidate.clone())?;
            }
            // node.exe 依赖的 dll（如有）
            for e in std::fs::read_dir(&inner)?.filter_map(|e| e.ok()) {
                let n = e.file_name().to_string_lossy().into_owned();
                if n.ends_with(".dll") {
                    let _ = std::fs::copy(e.path(), base.join("node").join(n));
                }
            }
        } else {
            std::fs::copy(inner.join("bin").join("node"), node_candidate.clone())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&node_candidate, std::fs::Permissions::from_mode(0o755));
            }
        }
        let _ = std::fs::remove_dir_all(&extract);
        set_status("Node 运行时就绪".into());
    }

    // 2) dsh 内核：写 package.json → npm 安装（钉版）
    set_status("正在安装 DSH 内核（钉版）…".into());
    let pkg_dir = base.join("kernel");
    std::fs::create_dir_all(&pkg_dir)?;
    let pkg_json = format!(
        "{{\n  \"name\": \"dsh-novel-kernel\",\n  \"private\": true,\n  \"dependencies\": {{\n    \"@deepseek-ai/dsh\": \"{}\"\n  }}\n}}\n",
        dsh_pin
    );
    std::fs::write(pkg_dir.join("package.json"), pkg_json)?;

    let npm_cli = if cfg!(windows) {
        base.join("node").join("node_modules").join("npm").join("bin").join("npm-cli.js")
    } else {
        base.join("node").join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js")
    };
    set_status("正在安装 DSH 内核依赖（首次较慢）…".into());
    let st = std::process::Command::new(node_candidate.clone())
        .arg(&npm_cli)
        .args(["install", "--omit=dev", "--no-audit", "--no-fund"])
        .current_dir(&pkg_dir)
        .env("DSH_HOME", dsh_home)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if !st.success() {
        // 镜像回退：npmmirror registry
        set_status("官方源失败，尝试镜像…".into());
        let st2 = std::process::Command::new(node_candidate.clone())
            .arg(&npm_cli)
            .args(["install", "--omit=dev", "--no-audit", "--no-fund",
                   "--registry", "https://registry.npmmirror.com"])
            .current_dir(&pkg_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if !st2.success() {
            return Err("内核依赖安装失败（官方与镜像源均失败）".into());
        }
    }

    let bin = pkg_dir.join("node_modules").join("@deepseek-ai").join("dsh").join("lib").join("bin.js");
    if !bin.exists() {
        return Err("内核安装后未找到 bin.js".into());
    }
    set_status("DSH 内核就绪".into());
    Ok(())
}

/// 升级：npm 安装指定版本到 kernel（覆盖），用于应用内"检查更新"。
pub fn upgrade_kernel(base: &Path, dsh_home: &Path, version: &str, set_status: &dyn Fn(String)) -> BoxResult<()> {
    set_status(format!("正在升级 DSH 内核到 {}…", version));
    let pkg_dir = base.join("kernel");
    std::fs::create_dir_all(&pkg_dir)?;
    // 更新 package.json 中的版本约束
    let pkg_json = format!(
        "{{\n  \"name\": \"dsh-novel-kernel\",\n  \"private\": true,\n  \"dependencies\": {{\n    \"@deepseek-ai/dsh\": \"{}\"\n  }}\n}}\n",
        version
    );
    std::fs::write(pkg_dir.join("package.json"), pkg_json)?;

    let node_bin = if cfg!(windows) { base.join("node").join("node.exe") } else { base.join("node").join("bin").join("node") };
    let npm_cli = if cfg!(windows) {
        base.join("node").join("node_modules").join("npm").join("bin").join("npm-cli.js")
    } else {
        base.join("node").join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js")
    };
    let st = std::process::Command::new(&node_bin)
        .arg(&npm_cli)
        .args(["install", "--omit=dev", "--no-audit", "--no-fund"])
        .current_dir(&pkg_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if !st.success() {
        return Err("升级失败（npm install）".into());
    }
    set_status(format!("已升级到 {}", version));
    Ok(())
}


// ---- 应用内 DSH 更新与内核重启 ---------------------------------------------

#[derive(serde::Serialize)]
pub struct VersionInfo {
    pub current: Option<String>,
    pub latest: String,
    pub has_update: bool,
}

pub fn check_update(base: &Path) -> BoxResult<VersionInfo> {
    let current = current_dsh_version(base);
    let latest = fetch_latest_dsh()?;
    let has_update = match &current {
        Some(c) => *c != latest,
        None => true,
    };
    Ok(VersionInfo { current, latest, has_update })
}

/// 杀掉当前内核并按现有资源重新拉起（升级后调用）。
pub fn restart_web(handle: AppHandle) -> BoxResult<()> {
    let paths = resolve_paths(&handle)?;
    {
        let state = handle.state::<crate::AppState>();
        let mut k = state.kernel.lock().unwrap();
        k.kill();
        k.kernel_port = 0;
    }
    let h = handle.clone();
    std::thread::spawn(move || {
        if let Err(e) = boot_existing(h.clone()) {
            eprintln!("[dsh-novel] 内核重启失败：{e}");
            surface_error(&h, &format!("内核重启失败：{e}"));
        }
    });
    Ok(())
}

/// 以既有资源直接拉起 web（不做下载与 provision）。
pub fn boot_existing(handle: AppHandle) -> BoxResult<()> {
    let paths = resolve_paths(&handle)?;
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

    let deadline = Instant::now() + Duration::from_secs(120);
    let mut http_ready_at: Option<Instant> = None;
    let url = loop {
        if let Ok(slot) = TOKEN_URL.lock() {
            if let Some(u) = slot.clone() {
                break u;
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
        if Instant::now() > deadline {
            let msg = "重启后 120 秒内未就绪".to_string();
            surface_error(&handle, &msg);
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

