//! 系统命令：检查更新、资源管理器定位、导出 Word、打开外部链接。
//!
//! v0.3 的更新只做"发现 + 跳浏览器"，不下载、不替换 exe（自替换在 Tauri 里
//! 应该交给 tauri-plugin-updater，这里的 WinHTTP 通道留着做轻量提示）。

use std::path::Path;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use mojuan_core::update as core_update;

use crate::commands::files::run_blocking;
use crate::commands::model::UpdateInfo;

/// 默认更新源（与 egui 版一致，可在设置里改）
pub const DEFAULT_REPO: &str = "118coder/mojuan";

/// 更新说明截断长度（GitHub Release 正文可能很长，全塞给前端页面会卡）
const NOTE_MAX_CHARS: usize = 1200;

/// 当前版本号（取 Cargo.toml 的 version）
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// 检查更新：有新版本返回 Some(UpdateInfo)，已是最新返回 None。
///
/// `repo` 可省略。取源顺序：命令参数 → state.json 里保存的 update_repo →
/// 环境变量 MOJUAN_REPO → 内置默认。网络不通等错误返回中文错误串，
/// 由前端决定要不要弹提示（启动后的静默检查不会打扰用户）。
#[tauri::command(rename_all = "snake_case")]
pub async fn check_update(
    app: AppHandle,
    repo: Option<String>,
) -> Result<Option<UpdateInfo>, String> {
    let explicit = repo.unwrap_or_default();
    let repo = if explicit.trim().is_empty() {
        let saved = crate::commands::state::load_state_quiet(&app).update_repo;
        pick_repo(&saved)
    } else {
        pick_repo(&explicit)
    };
    run_blocking(move || check_sync(&repo)).await
}

/// 更新源优先级：命令参数 → 环境变量 MOJUAN_REPO → 内置默认
fn pick_repo(configured: &str) -> String {
    let trimmed = configured.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    let from_env = std::env::var("MOJUAN_REPO").unwrap_or_default();
    if !from_env.trim().is_empty() {
        return from_env.trim().to_string();
    }
    DEFAULT_REPO.to_string()
}

fn check_sync(repo: &str) -> Result<Option<UpdateInfo>, String> {
    let release = core_update::fetch_latest(repo)?;
    let remote = release.version();
    if !core_update::is_newer(&remote, current_version()) {
        return Ok(None);
    }
    Ok(Some(UpdateInfo {
        version: remote,
        url: release_page(&release.html_url, repo),
        note: truncate_note(&release.body),
    }))
}

/// Release 页地址：优先用 API 返回的 html_url，缺了按 tag 拼一个
fn release_page(html_url: &str, repo: &str) -> String {
    if !html_url.trim().is_empty() {
        return html_url.trim().to_string();
    }
    format!("https://github.com/{repo}/releases")
}

fn truncate_note(body: &str) -> String {
    let note = body.trim();
    if note.chars().count() <= NOTE_MAX_CHARS {
        return note.to_string();
    }
    let cut: String = note.chars().take(NOTE_MAX_CHARS).collect();
    format!("{cut}…")
}

/// 启动后台检查更新（setup 里延迟调用），发现新版本就发 `update-available` 事件。
/// 失败静默——用户没主动问，不该被网络错误打扰。
pub fn spawn_background_check(app: AppHandle, repo: String, delay_secs: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(delay_secs));
        match check_sync(&repo) {
            Ok(Some(info)) => {
                let _ = app.emit("update-available", info);
            }
            Ok(None) => {}
            Err(e) => eprintln!("[墨卷] 后台检查更新失败：{e}"),
        }
    });
}

/// 在资源管理器中定位文件/文件夹
#[tauri::command(rename_all = "snake_case")]
pub async fn reveal_in_explorer(app: AppHandle, path: String) -> Result<(), String> {
    // 探索器启动可能要一两秒，放后台线程，别让 UI 等
    crate::commands::files::run_blocking(move || {
        let p = Path::new(&path);
        if !p.exists() {
            return Err(format!("路径不存在：{path}"));
        }
        app.opener()
            .reveal_item_in_dir(p)
            .map_err(|e| format!("打开资源管理器失败：{e}"))
    })
    .await
}

/// 用默认浏览器打开链接（更新提示里的"去下载"用它）
#[tauri::command(rename_all = "snake_case")]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let lower = url.trim().to_ascii_lowercase();
    if !(lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:"))
    {
        return Err("只能打开 http/https/mailto 链接".into());
    }
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| format!("打开链接失败：{e}"))
}

/// 导出 Word（docx）。md_path 源文件，out_path 目标文件（目录会自动创建）。
#[tauri::command(rename_all = "snake_case")]
pub async fn export_docx(md_path: String, out_path: String) -> Result<(), String> {
    run_blocking(move || {
        let src = Path::new(&md_path);
        if !src.is_file() {
            return Err(format!("找不到要导出的文档：{md_path}"));
        }
        let out = Path::new(&out_path);
        if out.is_dir() {
            return Err("导出目标是文件夹，请指定 .docx 文件名".into());
        }
        crate::docx::export_md_to_docx(src, out)?;
        Ok(())
    })
    .await
}

/// 应用信息（版本号、数据目录），设置页"关于"用
#[derive(serde::Serialize)]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub platform: String,
}

#[tauri::command(rename_all = "snake_case")]
pub fn app_info(app: AppHandle) -> Result<AppInfo, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(AppInfo {
        version: current_version().to_string(),
        data_dir,
        platform: std::env::consts::OS.to_string(),
    })
}
