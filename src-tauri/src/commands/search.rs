//! 搜索命令：工作区全文检索（复用 core 的 search + fuzzy 打分）。
//!
//! 契约只给了一个命令 `search_workspace(root, query, limit)`，但两件事要合成一个结果：
//! 文件名命中（快速打开用）与全文命中（正文里出现的位置）。这里统一成 SearchHit 列表，
//! 文件名命中 line=0，分数由 fuzzy_score 决定，前端按分数倒序渲染即可。

use std::path::{Path, PathBuf};

use mojuan_core::files as core_files;
use mojuan_core::search as core_search;

use crate::commands::files::run_blocking;
use crate::commands::model::SearchHit;

/// 一次最多返回多少条（默认 200，上限 1000）
const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 1000;

/// 工作区全文搜索。`limit` 省略时取 200。
#[tauri::command(rename_all = "snake_case")]
pub async fn search_workspace(
    root: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    run_blocking(move || search_sync(&root, &query, limit)).await
}

fn search_sync(root: &str, query: &str, limit: Option<usize>) -> Result<Vec<SearchHit>, String> {
    let dir = PathBuf::from(root);
    if !dir.is_dir() {
        return Err(format!("工作区不存在：{root}"));
    }
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let cap = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let result = core_search::search(&dir, q);

    let mut hits: Vec<SearchHit> = Vec::with_capacity(result.names.len() + result.contents.len());

    // 文件名命中：放在最前面，分数给足（用户找文件时名字比正文更相关）
    for n in &result.names {
        let score = core_search::fuzzy_score(q, &n.rel).unwrap_or(0) + 1000;
        hits.push(SearchHit {
            path: n.path.to_string_lossy().to_string(),
            line: 0,
            text: n.rel.clone(),
            score,
        });
    }

    // 正文命中：分数 = 文件名相关度 + 出现次数加权（同一文件多处命中不重复堆叠）
    for c in &result.contents {
        let name_score = core_search::fuzzy_score(q, &c.name).unwrap_or(0);
        // 命中行越靠前，稍微加分（用户更可能想看开头的内容）
        let line_bonus = (200i32 - (c.line_no.min(200) as i32)).max(0) / 20;
        hits.push(SearchHit {
            path: c.path.to_string_lossy().to_string(),
            line: c.line_no,
            text: c.line.clone(),
            score: name_score + line_bonus + 500,
        });
    }

    // 分数倒序；同分按路径排序，保证结果稳定
    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.path.cmp(&b.path))
            .then_with(|| a.line.cmp(&b.line))
    });
    hits.truncate(cap);
    Ok(hits)
}

/// 供命令面板用：只按文件名模糊匹配（不读文件内容，快）。
///
/// 契约外的补充命令，属于"只增不改"，见交付说明。
#[tauri::command(rename_all = "snake_case")]
pub async fn search_filenames(
    root: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    run_blocking(move || search_names_sync(&root, &query, limit)).await
}

fn search_names_sync(root: &str, query: &str, limit: Option<usize>) -> Result<Vec<SearchHit>, String> {
    let dir = Path::new(root);
    if !dir.is_dir() {
        return Err(format!("工作区不存在：{root}"));
    }
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let cap = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let mut hits: Vec<SearchHit> = core_files::walk_md(dir, 4000)
        .into_iter()
        .filter_map(|p| {
            let rel = core_files::rel_display(dir, &p);
            let score = core_search::fuzzy_score(q, &rel)?;
            Some(SearchHit {
                path: p.to_string_lossy().to_string(),
                line: 0,
                text: rel,
                score,
            })
        })
        .collect();
    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    hits.truncate(cap);
    Ok(hits)
}
