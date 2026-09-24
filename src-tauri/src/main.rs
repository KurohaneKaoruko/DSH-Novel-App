#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod kernel;
mod side_channel;

use std::sync::Mutex;
use tauri::{Manager, RunEvent};

use kernel::{BoxResult, KernelState};

/// 全局状态。
pub struct AppState {
    pub kernel: Mutex<KernelState>,
    pub side_port: u16,
    pub dsh_home: std::path::PathBuf,
}

fn main() {
    let ctx = tauri::generate_context!();

    let builder = tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            boot_app(&handle)?;
            Ok(())
        })
        .on_page_load(|webview, payload| {
            // 页面加载完成后注入文件面板（面板脚本自行判断是否在内核页面上激活）。
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                if let Some(state) = webview.app_handle().try_state::<AppState>() {
                    let js = kernel::panel_js(state.side_port);
                    let _ = webview.eval(&js);
                }
            }
        });

    let app = builder.build(ctx).expect("构建 Tauri 应用失败");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(state) = app_handle.try_state::<AppState>() {
                if let Ok(mut k) = state.kernel.lock() {
                    k.kill();
                }
            }
        }
    });
}

fn boot_app(handle: &tauri::AppHandle) -> BoxResult<()> {
    // 1. 路径（打包/开发）+ 边车（面板文件 API）
    let paths = kernel::resolve_paths(handle)?;
    let side_port = side_channel::start(handle.clone(), paths.clone())?;
    handle.manage(AppState {
        kernel: Mutex::new(KernelState::new()),
        side_port,
        dsh_home: paths.dsh_home.clone(),
    });

    // 2. 后台拉起内核（provision → dsh web → token URL → 主窗口跳转）
    let h = handle.clone();
    std::thread::spawn(move || {
        let result = kernel::boot(h.clone());
        if let Err(e) = result {
            let msg = e.to_string();
            eprintln!("[dsh-novel] 内核启动失败：{msg}");
            // 错误浮层显示在加载页（双击启动时无终端可看）
            let h2 = h.clone();
            let _ = h.run_on_main_thread(move || {
                if let Some(w) = h2.get_webview_window("main") {
                    let json = serde_json::json!(msg).to_string();
                    let _ = w.eval(&format!(
                        "var d=document.getElementById('boot-msg');if(d){{d.textContent='启动失败：'+{json};d.style.display='block';var s=document.querySelector('.bar');if(s)s.style.display='none';}}"
                    ));
                }
            });
        }
    });
    Ok(())
}
