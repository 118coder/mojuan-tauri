//! 文档与文件命令：打开工作区、读写、切片、大纲、外部修改监听。
//!
//! 全部包在 core 的 files/doc/large/vindex 之上，本文件只负责三件事：
//! 1. 把 core 的返回值翻译成契约里的 JSON 结构；
//! 2. 处理编码（core 只返回文本，我们要告诉前端原文是 UTF-8 还是 GBK）；
//! 3. 大文档的切片缓存（读一次全文，反复取块，不重复读盘）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use tauri::{AppHandle, Emitter, Manager};

use mojuan_core::files as core_files;
use mojuan_core::vindex::{VIndex, VKind};

use crate::commands::model::*;
use crate::encoding;

/// 一次最多返回多少块（防止前端传个 100000 把内存拉爆）
const MAX_BLOCKS_PER_CALL: usize = 500;
/// 单文件读取上限，与 core 保持一致
const MAX_FILE_BYTES: u64 = 40 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 共享状态
// ---------------------------------------------------------------------------

/// 缓存的文档（只有一篇：读者同一时刻只可能在读一篇大文档）
struct CachedDoc {
    path: PathBuf,
    stamp: (i64, u64),
    text: String,
    index: VIndex,
    /// 每块起始行号（1 基），建索引时顺手算好，切片和大纲都直接查
    block_lines: Vec<usize>,
}

/// 文件域运行时状态：切片缓存 + 外部修改监听 + 自己保存的时间戳
#[derive(Default)]
pub struct FilesState {
    cache: Mutex<Option<CachedDoc>>,
    watcher: Mutex<Option<Watcher>>,
    /// 最近一次由本应用保存的时间，用于屏蔽自己触发的 doc-changed
    saved_at: Mutex<HashMap<PathBuf, Instant>>,
}

struct Watcher {
    stop: Arc<AtomicBool>,
}

impl FilesState {
    /// 取（可能来自缓存的）文档文本与索引，在锁内执行回调避免克隆全文。
    fn with_doc<R>(
        &self,
        path: &Path,
        f: impl FnOnce(&str, &VIndex, &[usize]) -> R,
    ) -> Result<R, String> {
        let meta = std::fs::metadata(path).map_err(|e| format!("读取失败：{e}"))?;
        if !meta.is_file() {
            return Err("这个路径不是文件".into());
        }
        if meta.len() > MAX_FILE_BYTES {
            return Err("文件过大（超过 40MB）".into());
        }
        let stamp = (mtime_millis(path), meta.len());
        // 锁中毒（某次调用 panic）不该让整个应用的文件功能永久失效，
        // 取回内部值继续用；缓存内容本身是纯数据，坏不了。
        let mut guard = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let need_reload = match guard.as_ref() {
            Some(c) => c.path != path || c.stamp != stamp,
            None => true,
        };
        if need_reload {
            let (text, _crlf) = core_files::read_doc(path)?;
            let index = VIndex::build(&text);
            let block_lines = block_start_lines(&text, &index);
            *guard = Some(CachedDoc {
                path: path.to_path_buf(),
                stamp,
                text,
                index,
                block_lines,
            });
        }
        let c = guard.as_ref().expect("刚刚写入过");
        Ok(f(&c.text, &c.index, &c.block_lines))
    }

    /// 记录"本应用刚刚保存过这个文件"，1.5 秒内的 mtime 变化不当作外部修改
    fn mark_saved(&self, path: &Path) {
        let mut map = self.saved_at.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(path.to_path_buf(), Instant::now());
        // 顺手清理老记录，避免长跑后无限增长
        map.retain(|_, t| t.elapsed() < Duration::from_secs(30));
    }

    fn was_just_saved(&self, path: &Path) -> bool {
        let map = self.saved_at.lock().unwrap_or_else(|e| e.into_inner());
        map.get(path)
            .map(|t| t.elapsed() < Duration::from_millis(1500))
            .unwrap_or(false)
    }
}

fn mtime_millis(path: &Path) -> i64 {
    core_files::mtime(path)
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 把 core 的目录项转成契约里的 FileEntry（子节点懒加载，children 为空）
fn entry_of(e: core_files::Entry) -> FileEntry {
    FileEntry {
        name: e.name,
        path: e.path.to_string_lossy().to_string(),
        is_dir: e.is_dir,
        children: None,
        expanded: false,
    }
}

// ---------------------------------------------------------------------------
// 工作区 / 文件树
// ---------------------------------------------------------------------------

/// 打开文件夹作为工作区；只返回第一层，深层由 list_dir 展开
#[tauri::command(rename_all = "snake_case")]
pub async fn open_workspace(path: String) -> Result<WorkspaceTree, String> {
    run_blocking(move || open_workspace_sync(&path)).await
}

fn open_workspace_sync(path: &str) -> Result<WorkspaceTree, String> {
    let root = PathBuf::from(path);
    if !root.exists() {
        return Err(format!("文件夹不存在：{path}"));
    }
    if !root.is_dir() {
        return Err("这个路径不是文件夹".into());
    }
    let children = core_files::list_dir(&root)
        .into_iter()
        .map(entry_of)
        .collect();
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    Ok(WorkspaceTree {
        root: path.to_string(),
        name,
        children,
    })
}

/// 列出一层目录（展开文件树时调）
#[tauri::command(rename_all = "snake_case")]
pub async fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    run_blocking(move || {
        let dir = PathBuf::from(&path);
        if !dir.is_dir() {
            return Err(format!("不是文件夹：{path}"));
        }
        Ok(core_files::list_dir(&dir)
            .into_iter()
            .map(entry_of)
            .collect())
    })
    .await
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

/// 读整篇文档；返回原文编码，前端保存时按原编码写回
#[tauri::command(rename_all = "snake_case")]
pub async fn read_doc(path: String) -> Result<DocContent, String> {
    run_blocking(move || read_doc_sync(&path)).await
}

fn read_doc_sync(path: &str) -> Result<DocContent, String> {
    let p = Path::new(path);
    let meta = std::fs::metadata(p).map_err(|e| format!("读取失败：{e}"))?;
    if !meta.is_file() {
        return Err("这个路径不是文件".into());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err("文件过大（超过 40MB）".into());
    }
    let bytes = std::fs::read(p).map_err(|e| format!("读取失败：{e}"))?;
    let decoded = encoding::decode(&bytes);
    // 换行统一成 \n，前端不用再处理 CRLF；保存时按原文件风格还原
    let raw = if decoded.text.contains("\r\n") {
        decoded.text.replace("\r\n", "\n")
    } else {
        decoded.text
    };
    Ok(DocContent {
        raw,
        encoding: decoded.encoding.to_string(),
        is_plain: core_files::ext_of(p) == "txt",
        mtime: mtime_millis(p),
    })
}

/// 千万字文档按块取：`from` 为起始块下标，`max` 为本次最多返回多少块（默认 40，上限 500）
#[tauri::command(rename_all = "snake_case")]
pub async fn read_doc_blocks(
    app: AppHandle,
    path: String,
    from: usize,
    max: Option<usize>,
) -> Result<DocBlocks, String> {
    run_blocking(move || {
        let st = app.state::<FilesState>();
        let take = max.unwrap_or(40).clamp(1, MAX_BLOCKS_PER_CALL);
        st.with_doc(Path::new(&path), |text, idx, lines| {
            build_blocks(text, idx, lines, from, take)
        })
    })
    .await
}

/// 从 VIndex 切出 [from, from+take) 的块，附带行号与高度估算
pub(crate) fn build_blocks(text: &str, idx: &VIndex, lines: &[usize], from: usize, take: usize) -> DocBlocks {
    let total = idx.blocks.len();
    let start = from.min(total);
    let end = (start + take).min(total);

    let mut blocks = Vec::with_capacity(end.saturating_sub(start));
    for i in start..end {
        let b = &idx.blocks[i];
        let slice = idx.slice(text, i);
        let line = lines.get(i).copied().unwrap_or(1);
        // 块尾行号：块内换行数（末尾换行不算多一行）
        let nl = slice.bytes().filter(|&c| c == b'\n').count();
        let end_line = line + nl.saturating_sub(usize::from(slice.ends_with('\n')));
        blocks.push(DocBlock {
            index: i,
            kind: kind_name(b.kind).to_string(),
            level: b.level,
            text: slice.to_string(),
            line,
            end_line: end_line.max(line),
            // 16px 字号、720px 正文宽的估算值，前端实测后会覆盖
            height: idx.estimate(i, 16.0, 720.0),
        });
    }

    DocBlocks {
        blocks,
        total,
        done: end >= total,
    }
}

/// 每个块起始行号（1 基）：一次线性扫描，`\n` 计数 +1
pub(crate) fn block_start_lines(text: &str, idx: &VIndex) -> Vec<usize> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(idx.blocks.len());
    let mut line = 1usize;
    let mut cursor = 0usize;
    for b in &idx.blocks {
        let start = b.start.min(bytes.len());
        // 补数到块起点为止的换行
        if start > cursor {
            line += bytes[cursor..start].iter().filter(|&&c| c == b'\n').count();
            cursor = start;
        }
        out.push(line);
    }
    out
}

fn kind_name(k: VKind) -> &'static str {
    match k {
        VKind::Heading(_) => "heading",
        VKind::Para => "para",
        VKind::Code => "code",
        VKind::Quote => "quote",
        VKind::List => "list",
        VKind::Table => "table",
        VKind::Rule => "rule",
        VKind::Image => "image",
        VKind::Math => "math",
        VKind::Mermaid => "mermaid",
        VKind::FrontMatter => "frontmatter",
        VKind::Html => "html",
    }
}

/// 标题大纲：level/text/line/block_index，block_index 与 read_doc_blocks 同源
#[tauri::command(rename_all = "snake_case")]
pub async fn doc_outline(app: AppHandle, path: String) -> Result<Vec<OutlineItem>, String> {
    run_blocking(move || {
        let st = app.state::<FilesState>();
        st.with_doc(Path::new(&path), build_outline)
    })
    .await
}

pub(crate) fn build_outline(text: &str, idx: &VIndex, lines: &[usize]) -> Vec<OutlineItem> {
    let mut out = Vec::new();
    for (i, b) in idx.blocks.iter().enumerate() {
        if !matches!(b.kind, VKind::Heading(n) if (1..=6).contains(&n)) {
            continue;
        }
        let slice = idx.slice(text, i);
        // 只解析这一行标题：拿到的 plain 已经把 **加粗**、`代码`、[链接](url) 剥干净，
        // 与侧栏显示、doc::parse 的 id 生成保持同一套规则。不做任何渲染。
        let title = mojuan_core::doc::parse(slice, None)
            .blocks
            .into_iter()
            .find_map(|x| match x {
                mojuan_core::doc::Block::Heading { plain, .. } => Some(plain),
                _ => None,
            })
            .unwrap_or_default();
        if title.trim().is_empty() {
            continue;
        }
        out.push(OutlineItem {
            level: b.level,
            text: title,
            line: lines.get(i).copied().unwrap_or(1),
            block_index: i,
        });
    }
    out
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

/// 保存文档。encoding 只认 utf-8 / gbk；换行风格与 BOM 沿用原文件。
#[tauri::command(rename_all = "snake_case")]
pub async fn save_doc(
    app: AppHandle,
    path: String,
    content: String,
    encoding: String,
) -> Result<(), String> {
    run_blocking(move || {
        let enc = encoding::normalize(&encoding)?;
        let p = PathBuf::from(&path);
        let existing = std::fs::read(&p).ok();
        // 原文件是 CRLF 就继续写 CRLF，别把 git 里满屏的改动吵醒
        let crlf = existing
            .as_ref()
            .map(|b| b.windows(2).any(|w| w == b"\r\n"))
            .unwrap_or(false);
        // 原文件带 UTF-8 BOM 就保留（Windows 记事本用户很在意这个）
        let bom = matches!(enc, encoding::ENC_UTF8)
            && existing
                .as_ref()
                .map(|b| b.starts_with(&[0xEF, 0xBB, 0xBF]))
                .unwrap_or(false);

        let text = if crlf {
            content.replace("\r\n", "\n").replace('\n', "\r\n")
        } else {
            content.replace("\r\n", "\n")
        };

        let mut bytes = Vec::with_capacity(text.len() + 3);
        match enc {
            encoding::ENC_GBK => bytes.extend_from_slice(&encoding::encode_gbk(&text)?),
            _ => {
                if bom {
                    bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
                }
                bytes.extend_from_slice(text.as_bytes());
            }
        }

        if let Some(parent) = p.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
            }
        }
        std::fs::write(&p, bytes).map_err(|e| format!("保存失败：{e}"))?;
        app.state::<FilesState>().mark_saved(&p);
        Ok(())
    })
    .await
}

/// 新建文件（父目录不存在会自动建）。目标已存在时报错，不覆盖。
#[tauri::command(rename_all = "snake_case")]
pub async fn create_file(app: AppHandle, path: String, content: String) -> Result<(), String> {
    run_blocking(move || {
        let p = PathBuf::from(&path);
        if p.exists() {
            return Err(format!("文件已存在：{}", p.to_string_lossy()));
        }
        if let Some(parent) = p.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
            }
        }
        std::fs::write(&p, content.as_bytes()).map_err(|e| format!("新建文件失败：{e}"))?;
        app.state::<FilesState>().mark_saved(&p);
        Ok(())
    })
    .await
}

/// 重命名 / 移动。目标已存在时报错，不静默覆盖。
#[tauri::command(rename_all = "snake_case")]
pub async fn rename_entry(app: AppHandle, from: String, to: String) -> Result<(), String> {
    run_blocking(move || {
        let src = PathBuf::from(&from);
        let dst = PathBuf::from(&to);
        if !src.exists() {
            return Err(format!("源路径不存在：{from}"));
        }
        if src == dst {
            return Ok(());
        }
        if dst.exists() {
            return Err(format!("目标已存在：{to}"));
        }
        if let Some(parent) = dst.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
            }
        }
        // fs::rename 在同一分区内是原子的；跨分区会失败，这时退化为"复制 + 删除"
        match std::fs::rename(&src, &dst) {
            Ok(()) => {}
            Err(_) if src.is_file() => {
                std::fs::copy(&src, &dst).map_err(|e| format!("移动失败：{e}"))?;
                std::fs::remove_file(&src).map_err(|e| format!("移动后清理源文件失败：{e}"))?;
            }
            Err(e) => return Err(format!("移动失败：{e}")),
        }
        app.state::<FilesState>().mark_saved(&dst);
        Ok(())
    })
    .await
}

/// 删除（进回收站，core 里用的 trash）
#[tauri::command(rename_all = "snake_case")]
pub async fn delete_entry(path: String) -> Result<(), String> {
    run_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.exists() {
            return Err(format!("路径不存在：{path}"));
        }
        core_files::delete(&p)
    })
    .await
}

// ---------------------------------------------------------------------------
// 外部修改监听
// ---------------------------------------------------------------------------

/// 监听文档的外部修改（mtime + 大小，1 秒轮询），变化时发 `doc-changed {path}`。
/// 重复调用会停掉上一个监听，只保留最新的一个。
#[tauri::command(rename_all = "snake_case")]
pub fn watch_doc(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("文件不存在：{path}"));
    }
    let st = app.state::<FilesState>();

    // 先停掉旧监听
    if let Ok(mut guard) = st.watcher.lock() {
        if let Some(old) = guard.take() {
            old.stop.store(true, Ordering::Relaxed);
        }
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    let watch_path = p.clone();
    let app_thread = app.clone();
    let display = p.to_string_lossy().to_string();

    std::thread::Builder::new()
        .name("mojuan-watch-doc".into())
        .spawn(move || {
            let mut last = stamp_of(&watch_path);
            loop {
                // 100ms 一跳，方便退出时及时收手
                for _ in 0..10 {
                    if stop_thread.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                let now = stamp_of(&watch_path);
                if now == last {
                    continue;
                }
                last = now;
                // 自己刚保存引起的 mtime 变化不推给前端，避免"自动重载"打断编辑
                if app_thread.state::<FilesState>().was_just_saved(&watch_path) {
                    continue;
                }
                // 文件被删了也通知一声：前端可以提示"文件已不存在"
                let _ = app_thread.emit(
                    "doc-changed",
                    DocChanged {
                        path: display.clone(),
                    },
                );
            }
        })
        .map_err(|e| format!("启动监听失败：{e}"))?;

    if let Ok(mut guard) = st.watcher.lock() {
        *guard = Some(Watcher { stop });
    }
    Ok(())
}

/// 文件的 (mtime 毫秒, 大小)；不存在时用 (-1, 0) 表示，删除与恢复都能被察觉
fn stamp_of(path: &Path) -> (i64, u64) {
    match std::fs::metadata(path) {
        Ok(m) => (
            m.modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
            m.len(),
        ),
        Err(_) => (-1, 0),
    }
}

// ---------------------------------------------------------------------------
// 后台执行
// ---------------------------------------------------------------------------

/// 把阻塞的文件操作丢到线程池，别卡住 WebView 所在的主线程。
pub(crate) async fn run_blocking<R, F>(f: F) -> Result<R, String>
where
    R: Send + 'static,
    F: FnOnce() -> Result<R, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("后台任务出错：{e}"))?
}
