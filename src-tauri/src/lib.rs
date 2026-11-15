//! 墨卷 Tauri 版后端入口。
//!
//! 职责只有三件：注册插件、注册命令、在启动时初始化状态。
//! 具体的文件/搜索/设置/更新逻辑都在 `commands/` 与 `docx/` 里，
//! 底层能力复用 mojuan-core（与 egui 版共享同一套 Rust 代码）。

mod commands;
#[cfg(test)]
mod tests;
mod docx;
mod encoding;

use commands::FilesState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(FilesState::default())
        .setup(|app| {
            // 启动后台检查更新：延迟 3 秒，避免和首屏渲染抢资源。
            // 设置里关掉了 check_updates 就完全安静（不联网、不发事件）。
            let state = commands::state::load_state_quiet(app.handle());
            if state.check_updates {
                let repo = if state.update_repo.trim().is_empty() {
                    commands::system::DEFAULT_REPO.to_string()
                } else {
                    state.update_repo.clone()
                };
                commands::system::spawn_background_check(app.handle().clone(), repo, 3);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // -- 文档与文件 --
            commands::files::open_workspace,
            commands::files::list_dir,
            commands::files::read_doc,
            commands::files::read_doc_blocks,
            commands::files::doc_outline,
            commands::files::save_doc,
            commands::files::create_file,
            commands::files::rename_entry,
            commands::files::delete_entry,
            commands::files::watch_doc,
            // -- 搜索 --
            commands::search::search_workspace,
            commands::search::search_filenames,
            // -- 设置与状态 --
            commands::state::load_state,
            commands::state::save_state,
            // -- 更新与系统 --
            commands::system::check_update,
            commands::system::reveal_in_explorer,
            commands::system::open_url,
            commands::system::export_docx,
            commands::system::app_info,
        ])
        .run(tauri::generate_context!())
        .expect("启动墨卷失败");
}
