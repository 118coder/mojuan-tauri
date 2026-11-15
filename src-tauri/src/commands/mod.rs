//! Tauri 命令层：按域分文件，每个文件对应 api-contract.md 的一节。
//!
//! - `files`：工作区、文件树、读写、切片、大纲、外部修改监听
//! - `search`：工作区搜索
//! - `state`：settings / 收藏 / 最近 / 阅读进度（state.json）
//! - `system`：检查更新、资源管理器定位、导出 docx、应用信息
//! - `model`：前后端 JSON 结构定义
//!
//! 所有命令返回 `Result<T, String>`，错误串是中文人话。

pub mod files;
pub mod model;
pub mod search;
pub mod state;
pub mod system;

pub use files::FilesState;
