# 墨卷 Tauri 版 · Rust 命令层使用说明（给前端 W3/W4）

> 事实依据：`docs/api-contract.md`（契约）+ 本目录 `src/commands/`。
> 契约没写细的地方这里补齐；两者冲突时以契约为准，并请回主线改契约。

## 一、调用方式

全部命令都在 `src-tauri/src/lib.rs` 的 `invoke_handler` 里注册，前端直接：

```ts
import { invoke } from "@tauri-apps/api/core";
const doc = await invoke<DocContent>("read_doc", { path: "E:/笔记/a.md" });
```

- 全部命令返回 `Result<T, String>`；出错时 JS 侧 `catch` 到的是**中文人话字符串**。
- 参数名统一 **snake_case**（Rust 侧用 `#[command(rename_all = "snake_case")]`），
  所以是 `{ md_path, out_path }` 而不是 `{ mdPath, outPath }`。
- 异步命令（读写、搜索、导出、检查更新）都在后台线程池跑，不会卡 UI。

## 二、命令清单与返回结构

### 文档与文件

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `open_workspace` | `{ path }` | `WorkspaceTree` |
| `list_dir` | `{ path }` | `FileEntry[]` |
| `read_doc` | `{ path }` | `DocContent` |
| `read_doc_blocks` | `{ path, from, max? }` | `DocBlocks` |
| `doc_outline` | `{ path }` | `OutlineItem[]` |
| `save_doc` | `{ path, content, encoding }` | `null` |
| `create_file` | `{ path, content }` | `null` |
| `rename_entry` | `{ from, to }` | `null` |
| `delete_entry` | `{ path }` | `null` |
| `watch_doc` | `{ path }` | `null` |

```ts
interface WorkspaceTree { root: string; name: string; children: FileEntry[] }
interface FileEntry {
  name: string;
  path: string;          // 绝对路径，Windows 反斜杠正斜杠都有可能出现，直接透传
  is_dir: boolean;
  children?: FileEntry[]; // 懒加载：open_workspace 只给一层，展开时调 list_dir 再填
  expanded: boolean;      // 折叠态，根节点默认 true 由前端自己定
}

interface DocContent {
  raw: string;      // 换行已统一为 \n；文件 ≤ 40MB
  encoding: "utf-8" | "gbk";  // UTF-16 文件也会报 utf-8（读进来后按 UTF-8 保存）
  is_plain: boolean;          // 扩展名 .txt，走纯文本渲染，不要走 Markdown 管线
  mtime: number;              // Unix 毫秒
}

interface DocBlock {
  index: number;    // 全文块下标
  kind: "heading"|"para"|"code"|"quote"|"list"|"table"|"rule"|"image"|"math"|"mermaid"|"frontmatter"|"html";
  level: number;    // 标题级别 / 列表缩进，其余 0
  text: string;     // 该块的 Markdown 原文切片
  line: number;     // 起始行号（1 基）
  end_line: number; // 结束行号（1 基，含）
  height: number;   // 后端估算高度（16px/720px 基准），前端实测后请覆盖
}
interface DocBlocks { blocks: DocBlock[]; total: number; done: boolean }

interface OutlineItem { level: number; text: string; line: number; block_index: number }
```

**大文档用法**（契约约定）：

1. 先 `read_doc`。`raw.length` 不大（比如 < 1MB）就直接交给渲染管线。
2. 超过阈值就改走 `read_doc_blocks`：
   ```ts
   // 打开时先取第一批，顺便拿 total
   const first = await invoke<DocBlocks>("read_doc_blocks", { path, from: 0, max: 40 });
   // 滚动到第 n 块附近时
   const more = await invoke<DocBlocks>("read_doc_blocks", { path, from: n, max: 40 });
   ```
   `max` 默认 40，上限 500。`from` 超过 `total` 返回空数组且 `done: true`。
3. `doc_outline` 的 `block_index` 与 `read_doc_blocks` 的 `index` 同源，可以直接
   `scrollToIndex(item.block_index)`。

**保存**：`encoding` 传 `read_doc` 返回的那个值即可（`"utf-8"` / `"gbk"`）。
Rust 侧会沿用原文件的换行风格（CRLF/LF）和 UTF-8 BOM；GBK 遇到表示不了的字符
（emoji、生僻字）会报「字符「🙂」无法用 GBK 表示，请改用 UTF-8 保存」。

### 搜索

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `search_workspace` | `{ root, query, limit? }` | `SearchHit[]` |
| `search_filenames` | `{ root, query, limit? }` | `SearchHit[]` |

```ts
interface SearchHit {
  path: string; // 绝对路径
  line: number; // 1 基；0 表示这是文件名命中，不是正文命中
  text: string; // 正文命中 = 该行片段（约 90 字，两端可能有 …）；文件名命中 = 相对路径
  score: number; // 已按降序排好，越大越靠前
}
```

- `search_workspace`：文件名 + 全文一起搜，`limit` 默认 200、上限 1000。
- `search_filenames`：只按路径模糊匹配，不读文件内容，给命令面板（Ctrl+P）用。
- 结果已排序，前端直接渲染即可。

### 设置与状态

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `load_state` | 无 | `AppState` |
| `save_state` | `{ state }` | `null` |

```ts
interface AppState {
  theme: "dark" | "light" | "auto";
  mode: "read" | "split" | "edit";
  font_size: number;      // 12~32
  measure: number;        // 正文栏宽 420~1600
  line_spacing: number;   // 1.2~2.6
  sidebar_open: boolean;
  sidebar_width: number;  // 180~520
  split_ratio: number;    // 0.25~0.75
  autosave: boolean;
  editor_wrap: boolean;
  show_status: boolean;
  minimal_open: boolean;
  check_updates: boolean;
  update_repo: string;    // owner/repo，空 = 用内置默认 118coder/mojuan
  favorites: string[];    // 文档绝对路径
  recent: { path: string; ts: number }[]; // ts = Unix 秒，新的在前
  scroll_top: Record<string, number>;     // path → 阅读区 scrollTop（px）
  doc_theme: Record<string, "dark" | "light">; // path → 该文档单独配色
  last_file: string | null;
  last_workspace: string | null;
  window: [number, number, number, number] | null; // [x, y, w, h]
}
```

- 落盘位置：`%APPDATA%\com.mojuan.app\state.json`（Windows）。写入是
  「.tmp → 旧文件改 .bak → 顶上」，断电不会坏；解析失败会自动备份 `state.json.bak`。
- `save_state` 会把越界数值夹回合法范围（例如 `font_size: 999` 存成 32），
  并把 `scroll_top` / `doc_theme` 各限制在 500 条以内。
- 前端照契约做 500ms 节流即可；每次 `save_state` 都是整份覆盖。

### 更新与系统

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `check_update` | `{ repo? }` | `UpdateInfo \| null` |
| `reveal_in_explorer` | `{ path }` | `null` |
| `open_url` | `{ url }` | `null` |
| `export_docx` | `{ md_path, out_path }` | `null` |
| `app_info` | 无 | `AppInfo` |

```ts
interface UpdateInfo { version: string; url: string; note: string }
interface AppInfo { version: string; data_dir: string; platform: string }
```

- `check_update`：有新版返回对象，已是最新返回 `null`，网络问题抛中文错误串。
  `repo` 省略时按「参数 → 环境变量 MOJUAN_REPO → 内置默认」取源。
- v0.3 只做「发现 + 跳浏览器」：拿到 `url` 后调 `open_url` 或
  `@tauri-apps/plugin-opener` 的 `openUrl`，不做下载替换。
- `export_docx`：`out_path` 的父目录不存在会自动创建；导出目标不能是文件夹。
  标题取 `md_path` 的文件名（不含扩展名），图片相对路径以 md 所在目录为基准。

## 三、事件（Rust → 前端）

| 事件 | 载荷 | 触发 |
| --- | --- | --- |
| `doc-changed` | `{ path: string }` | `watch_doc` 监听的文档被外部修改/删除（1 秒轮询 mtime+大小） |
| `update-available` | `UpdateInfo` | 启动后台检查发现新版本（设置里 `check_updates=false` 时不检查） |

```ts
import { listen } from "@tauri-apps/api/event";
const un = await listen<{ path: string }>("doc-changed", (e) => {
  // 只关心当前打开的文档；别把用户正在编辑的内容直接冲掉
  if (e.payload.path === currentPath) reload();
});
```

- 切换文档时**重新调一次** `watch_doc`：Rust 侧只保留最新的一个监听。
- 本应用自己 `save_doc` 后的 1.5 秒内不会发 `doc-changed`（避免自触发重载）。
- 文件被删除也会发一次（`path` 不变），前端可提示「文件已不存在」。

## 四、本地图片（asset 协议）

`tauri.conf.json` 已开：

```json
"security": {
  "csp": null,
  "assetProtocol": { "enable": true, "scope": ["**"] }
}
```

`Cargo.toml` 的 tauri 已带 `protocol-asset` feature（缺了它配置不生效）。

前端用法：

```ts
import { convertFileSrc } from "@tauri-apps/api/core";

// 图片块：后端 doc 解析给出的 src 是 Markdown 里的原样地址，
// 前端需要自己按"文档所在目录 + 相对路径"拼绝对路径，
// 再交给 convertFileSrc 换成 asset:// 地址
function imgUrl(absPath: string) {
  return convertFileSrc(absPath); // 例如 http://asset.localhost/E%3A%5C...%5Ca.png
}
```

注意：

- `convertFileSrc` 只接受**绝对路径**；相对路径请先 `mdDir + "/" + src`。
- 远程图片（`http://` / `https://` / `data:`）不要走 `convertFileSrc`，直接给 `img.src`。
- `scope: ["**"]` 表示整机可读（这是任务要求「覆盖常见盘符根」的最宽形式）。
  风险：WebView 里的任何脚本都能通过 asset:// 读本机文件。若后续要收紧，
  可以在 `open_workspace` 时用 `app.asset_protocol_scope().allow_directory(dir, true)`
  动态放行，然后把配置改成空数组——这一步需要主线决定，本次未做。
- CSP 目前是 `null`（不限制），所以图片/内联样式都不需要额外放行。

## 五、已知边界

1. `read_doc` 只读 ≤ 40MB 的文件；更大的请用 `read_doc_blocks`（它按块读，同样受 40MB 限制）。
2. `delete_entry` 走回收站（core 的 `trash`），不直接抹文件。
3. `rename_entry` 目标已存在会报错，不会静默覆盖；跨盘移动自动退化为「复制 + 删除」。
4. 大纲的 `text` 是纯文本（已剥掉 `**`、`` ` ``、链接地址），直接显示即可，不要再當 Markdown 解析。
5. Rust 侧不做任何 Markdown 渲染（契约明令），只做解析成块与导出。
