//! 前后端数据契约（与 docs/api-contract.md 一一对应）。
//!
//! 字段名一律 snake_case：契约里的 `is_plain`、`split_ratio`、`block_index`、`md_path`
//! 都是这个写法，前端照着 invoke 返回值取字段即可，不做任何大小写转换。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 文件树
// ---------------------------------------------------------------------------

/// 文件树节点。`children` 为 None 表示"还没展开过"，前端拿到 list_dir 结果后自行填充。
#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// 已展开过的子节点（open_workspace 只给一层，深层由 list_dir 懒加载）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileEntry>>,
    /// 折叠态：根节点默认展开，其余默认折叠
    pub expanded: bool,
}

/// 打开工作区的结果
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceTree {
    pub root: String,
    pub name: String,
    /// 第一层节点；与 FileEntry.children 同名，前端可以写同一套递归渲染
    pub children: Vec<FileEntry>,
}

// ---------------------------------------------------------------------------
// 文档读取
// ---------------------------------------------------------------------------

/// read_doc 的返回
#[derive(Debug, Clone, Serialize)]
pub struct DocContent {
    /// 归一化换行（CRLF → LF）后的全文
    pub raw: String,
    /// "utf-8" / "gbk" / "utf-16le" / "utf-16be"
    pub encoding: String,
    /// 是否纯文本（.txt）：前端不做 Markdown 解析
    pub is_plain: bool,
    /// 文件修改时间，Unix 毫秒
    pub mtime: i64,
}

/// 大文档里的一个逻辑块（前端虚拟滚动的最小单位）
#[derive(Debug, Clone, Serialize)]
pub struct DocBlock {
    /// 块在全文中的下标，doc_outline 的 block_index 就是它
    pub index: usize,
    /// heading / para / code / quote / list / table / rule / image / math / mermaid / frontmatter / html
    pub kind: String,
    /// 标题级别（heading）或列表缩进层级，其余为 0
    pub level: u8,
    /// 该块的 Markdown 原文切片（不含前后空行，末尾保留换行）
    pub text: String,
    /// 起始行号（1 基）
    pub line: usize,
    /// 结束行号（1 基，含）
    pub end_line: usize,
    /// 后端按 16px 字号 / 720px 正文宽估算的高度，前端可自行实测覆盖
    pub height: f32,
}

/// read_doc_blocks 的返回
#[derive(Debug, Clone, Serialize)]
pub struct DocBlocks {
    pub blocks: Vec<DocBlock>,
    /// 全文总块数（VIndex.blocks.len()）
    pub total: usize,
    /// 是否已经取到末尾（from + blocks.len() >= total）
    pub done: bool,
}

/// 目录侧栏的大纲项
#[derive(Debug, Clone, Serialize)]
pub struct OutlineItem {
    pub level: u8,
    pub text: String,
    /// 标题所在行号（1 基）
    pub line: usize,
    /// 对应的块下标，前端可直接喂给虚拟滚动定位
    pub block_index: usize,
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

/// 工作区搜索命中
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    /// 绝对路径
    pub path: String,
    /// 命中行号（1 基）；文件名命中为 0
    pub line: usize,
    /// 命中行片段（已裁剪到 ~90 字，两端可能带 …）
    pub text: String,
    /// 越大越靠前
    pub score: i32,
}

// ---------------------------------------------------------------------------
// 设置与状态
// ---------------------------------------------------------------------------

/// 最近打开的文件
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RecentEntry {
    pub path: String,
    /// Unix 秒
    pub ts: i64,
}

/// 落盘的应用状态（state.json）。字段都有默认值，旧文件缺字段也能读。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppState {
    /// "dark" / "light" / "auto"
    pub theme: String,
    /// "read" / "split" / "edit"
    pub mode: String,
    /// 正文字号
    pub font_size: f32,
    /// 正文栏宽
    pub measure: f32,
    /// 行距倍数
    pub line_spacing: f32,
    /// 侧栏是否展开
    pub sidebar_open: bool,
    /// 侧栏宽度
    pub sidebar_width: f32,
    /// 分屏时编辑区占比 0.25~0.75
    pub split_ratio: f32,
    /// 失焦自动保存
    pub autosave: bool,
    /// 编辑器自动换行（关闭 = 横向滚动）
    pub editor_wrap: bool,
    /// 显示状态栏
    pub show_status: bool,
    /// 极简模式（打开即见内容，隐藏侧栏与多余按钮）
    pub minimal_open: bool,
    /// 启动时检查更新
    pub check_updates: bool,
    /// 更新源 owner/repo，留空用内置默认
    pub update_repo: String,
    /// 收藏的文档绝对路径
    pub favorites: Vec<String>,
    /// 最近打开（新的在前）
    pub recent: Vec<RecentEntry>,
    /// 按文档 path 记录阅读进度：path → 滚动位置（px）
    pub scroll_top: BTreeMap<String, f32>,
    /// 按文档 path 记录单独配色：path → "dark" / "light"（没有就跟随全局 theme）
    pub doc_theme: BTreeMap<String, String>,
    /// 上次打开的文件
    pub last_file: Option<String>,
    /// 上次工作区
    pub last_workspace: Option<String>,
    /// 窗口位置与尺寸 [x, y, w, h]
    pub window: Option<[f32; 4]>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            mode: "split".into(),
            font_size: 16.0,
            measure: 720.0,
            line_spacing: 1.75,
            sidebar_open: true,
            sidebar_width: 268.0,
            split_ratio: 0.5,
            autosave: false,
            editor_wrap: true,
            show_status: true,
            minimal_open: false,
            check_updates: true,
            update_repo: String::new(),
            favorites: Vec::new(),
            recent: Vec::new(),
            scroll_top: BTreeMap::new(),
            doc_theme: BTreeMap::new(),
            last_file: None,
            last_workspace: None,
            window: None,
        }
    }
}

impl AppState {
    /// 读盘前先兜底一次，防止前端存了越界值把界面搞坏
    pub fn sanitized(mut self) -> Self {
        if !matches!(self.theme.as_str(), "dark" | "light" | "auto") {
            self.theme = "dark".into();
        }
        if !matches!(self.mode.as_str(), "read" | "split" | "edit") {
            self.mode = "split".into();
        }
        self.font_size = self.font_size.clamp(12.0, 32.0);
        self.measure = self.measure.clamp(420.0, 1600.0);
        self.line_spacing = self.line_spacing.clamp(1.2, 2.6);
        self.sidebar_width = self.sidebar_width.clamp(180.0, 520.0);
        self.split_ratio = self.split_ratio.clamp(0.25, 0.75);
        // 进度表最多留 500 篇，防止长年使用后无限膨胀（BTreeMap 按 path 有序，掐掉尾部）
        while self.scroll_top.len() > 500 {
            let last = self.scroll_top.keys().next_back().cloned();
            match last {
                Some(k) => {
                    self.scroll_top.remove(&k);
                }
                None => break,
            }
        }
        while self.doc_theme.len() > 500 {
            let last = self.doc_theme.keys().next_back().cloned();
            match last {
                Some(k) => {
                    self.doc_theme.remove(&k);
                }
                None => break,
            }
        }
        self.doc_theme
            .retain(|_, v| matches!(v.as_str(), "dark" | "light"));
        self.recent.truncate(40);
        self
    }
}

// ---------------------------------------------------------------------------
// 更新
// ---------------------------------------------------------------------------

/// 有新版本时给前端的信息
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    /// 浏览器下载页（v0.3 不做自替换，直接跳转）
    pub url: String,
    /// 更新说明（截断）
    pub note: String,
}

/// doc-changed 事件载荷
#[derive(Debug, Clone, Serialize)]
pub struct DocChanged {
    pub path: String,
}
