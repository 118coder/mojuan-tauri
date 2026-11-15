# 墨卷 Tauri 版 · 前后端接口契约 v1

> R = Rust 命令（src-tauri/src/commands/），F = 前端调用（src/lib/）。
> 两边都以本文档为准，改动先改这里。所有命令返回 `Result<T, String>`（错误串含中文人话）。

## 文档与文件（复用 mojuan-core files/doc/large）

| 命令 | 签名 | 说明 |
| --- | --- | --- |
| open_workspace | R `open_workspace(path) -> WorkspaceTree` | 打开文件夹；树含折叠态。F 初始化时调 |
| list_dir | R `list_dir(path) -> Vec<FileEntry>` | 文件树展开；FileEntry{name,path,is_dir,children?} |
| read_doc | R `read_doc(path) -> DocContent` | 读文档；BOM 嗅探→UTF-8→GBK 兜底；返回 {raw, encoding, is_plain(txt), mtime} |
| read_doc_blocks | R `read_doc_blocks(path, from, max) -> {blocks, total, done}` | 千万字切片：VIndex 按块边界切，前端虚拟滚动按需取 |
| doc_outline | R `doc_outline(path) -> Vec<OutlineItem{level,text,line,block_index}>` | 标题大纲（目录侧栏） |
| save_doc | R `save_doc(path, content, encoding) -> ()` | 保存；encoding="utf-8"\|"gbk"；GBK 不可映射字符报中文错 |
| create_file | R `create_file(path, content) -> ()` | 新建文件（含父目录） |
| rename_entry | R `rename_entry(from, to) -> ()` | 重命名/移动 |
| delete_entry | R `delete_entry(path) -> ()` | 删除（前端确认后调） |
| watch_doc | R `watch_doc(path) -> ()` + 事件 `doc-changed{path}` | 外部修改自动重载（mtime 轮询或 notify） |

## 搜索

| 命令 | 签名 | 说明 |
| --- | --- | --- |
| search_workspace | R `search_workspace(root, query, limit) -> Vec<SearchHit{path,line,text,score}>` | 工作区全文搜索（mojuan-core search，模糊匹配） |

## 设置与状态（复用 mojuan-core store，存 app 数据目录 state.json）

| 命令 | 签名 | 说明 |
| --- | --- | --- |
| load_state | R `load_state() -> AppState` | 设置/收藏/最近。阅读进度为两张表：`scroll_top: {path: number}` + `doc_theme: {path: dark\|light}`（W2 实现拍板：读写更省事，主题可选） |
| save_state | R `save_state(state) -> ()` | 节流保存（前端 500ms 合并） |

## 更新与系统

| 命令 | 签名 | 说明 |
| --- | --- | --- |
| check_update | R `check_update() -> Option<UpdateInfo{version,url,note}>` | GitHub Release 检查（mojuan-core update；WinHTTP 直连） |
| reveal_in_explorer | R `reveal_in_explorer(path) -> ()` | 资源管理器定位 |
| export_docx | R `export_docx(md_path, out_path) -> ()` | docx 生成（从 egui 版 export.rs 的 OOXML+ZIP 生成器平移，放 src-tauri/src/docx/） |

## 事件（R → F）

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| doc-changed | {path} | 文档被外部修改 |
| update-available | UpdateInfo | 启动后台检查后推送 |

## 约定

- 大文档：前端先 `read_doc` 拿 raw（≤1MB）直接渲染管线；>1MB 走 `read_doc_blocks` 分块取（块大小由 VIndex 决定），虚拟滚动懒加载
- 图片：本地图片走 asset 协议（tauri.conf.json 开 assetProtocol，scope 限定用户工作区）；远程图片直接 URL
- 错误一律中文人话字符串
- 禁止在 Rust 侧做 markdown 解析渲染（渲染全在前端管线，见 W3 renderer.ts）
