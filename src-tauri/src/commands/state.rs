//! 设置与阅读状态：state.json 存在 tauri 的 app_data_dir 下。
//!
//! 与 egui 版 store.rs 的差别：
//! - egui 版优先存 exe 同目录（便携）；
//! - Tauri 版按任务要求统一走 `app_data_dir`（Windows 上是
//!   `%APPDATA%\com.mojuan.app\state.json`），装到 Program Files 也不会因为没写权限丢设置。
//!
//! 写入走「先写 .tmp → 旧文件改名 .bak → 新文件顶上」，任何一步失败都回滚，
//! 保证最坏情况下还留着上一份能用的设置。

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::commands::model::AppState;

/// 状态文件名
const STATE_FILE: &str = "state.json";

/// 取 app_data_dir（不存在就创建）
fn state_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("找不到应用数据目录：{e}"))?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败：{e}"))?;
    }
    Ok(dir)
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(state_dir(app)?.join(STATE_FILE))
}

/// 读状态；文件不存在或内容坏掉都返回默认值（不让用户卡在启动失败上）
#[tauri::command(rename_all = "snake_case")]
pub fn load_state(app: AppHandle) -> Result<AppState, String> {
    let path = state_path(&app)?;
    Ok(read_state_file(&path))
}

/// 非命令版本：给启动时后台任务用（读不到就是默认值，绝不阻挡启动）
pub fn load_state_quiet(app: &AppHandle) -> AppState {
    match state_path(app) {
        Ok(p) => read_state_file(&p),
        Err(_) => AppState::default(),
    }
}

fn read_state_file(path: &Path) -> AppState {
    // 主文件丢了但备份还在（上次保存正好断电）→ 用备份顶上
    let path = if path.exists() {
        path.to_path_buf()
    } else {
        let bak = path.with_extension("json.bak");
        if bak.exists() {
            log_warn("state.json 不见了，已从 state.json.bak 恢复");
            bak
        } else {
            return AppState::default();
        }
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            log_warn(&format!("读取设置失败，按默认设置启动：{e}"));
            return AppState::default();
        }
    };
    // 兼容老文件里的 BOM
    let text = text.trim_start_matches('\u{feff}');
    match serde_json::from_str::<AppState>(text) {
        Ok(s) => s.sanitized(),
        Err(e) => {
            // 坏文件不静默吞掉：备份一份，用户还能找回线索
            let _ = std::fs::copy(&path, path.with_extension("json.bad"));
            log_warn(&format!("设置文件解析失败（已备份为 state.json.bad）：{e}"));
            AppState::default()
        }
    }
}

/// 保存状态。前端已做 500ms 节流，这里直接落盘。
///
/// 异步执行：滚动时每 500ms 一次的写入不该占用主线程。
#[tauri::command(rename_all = "snake_case")]
pub async fn save_state(app: AppHandle, state: AppState) -> Result<(), String> {
    crate::commands::files::run_blocking(move || {
        let path = state_path(&app)?;
        write_state_file(&path, &state.sanitized())
    })
    .await
}

fn write_state_file(path: &Path, state: &AppState) -> Result<(), String> {
    let json = serde_json::to_string_pretty(state).map_err(|e| format!("序列化设置失败：{e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("写入临时文件失败：{e}"))?;

    let bak = path.with_extension("json.bak");
    let had_old = path.exists();
    if had_old {
        let _ = std::fs::remove_file(&bak);
        // 旧文件先改名让位；失败就放弃这次保存，原文件保持不动
        if let Err(e) = std::fs::rename(path, &bak) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("替换设置文件失败：{e}"));
        }
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        // 回滚：把备份改回原名
        if had_old {
            let _ = std::fs::rename(&bak, path);
        }
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("保存设置失败：{e}"));
    }
    Ok(())
}

fn log_warn(msg: &str) {
    eprintln!("[墨卷] {msg}");
}
