/**
 * 统一后端访问层（W4b）
 * ---------------------------------------------------------------------------
 * - Tauri 环境：转发到 src-tauri 命令（见 src-tauri/FRONTEND_API.md，19 个命令）。
 * - 浏览器预览（npx vite / 无头测试）：内置内存 mock 后端，行为与 Rust 命令
 *   对齐（含 read_doc_blocks 分块、doc_outline、工作区搜索），让界面、标签、
 *   快捷键、设置都能在纯浏览器里完整自测（W4b 的 .w4b.mjs 依赖它）。
 * - 参数名统一 snake_case（与 Rust 侧 rename_all 对齐）。
 * - 所有错误都抛中文人话字符串（与 Rust Result<T,String> 一致）。
 */

/* -------------------------------------------------------------------------- */
/* 类型（与 docs/api-contract.md、FRONTEND_API.md 对齐）                        */
/* -------------------------------------------------------------------------- */

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileEntry[];
  expanded: boolean;
}

export interface WorkspaceTree {
  root: string;
  name: string;
  children: FileEntry[];
}

export interface DocContent {
  raw: string;
  encoding: "utf-8" | "gbk";
  is_plain: boolean;
  mtime: number;
}

export interface DocBlock {
  index: number;
  kind: "heading" | "para" | "code" | "quote" | "list" | "table" | "rule" | "image" | "math" | "mermaid" | "frontmatter" | "html";
  level: number;
  text: string;
  line: number;
  end_line: number;
  height: number;
}

export interface DocBlocks {
  blocks: DocBlock[];
  total: number;
  done: boolean;
}

export interface OutlineItem {
  level: number;
  text: string;
  line: number;
  block_index: number;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
  score: number;
}

export interface AppState {
  theme: "dark" | "light" | "auto";
  mode: "read" | "split" | "edit";
  font_size: number;
  measure: number;
  line_spacing: number;
  sidebar_open: boolean;
  sidebar_width: number;
  split_ratio: number;
  autosave: boolean;
  editor_wrap: boolean;
  show_status: boolean;
  minimal_open: boolean;
  check_updates: boolean;
  update_repo: string;
  favorites: string[];
  recent: { path: string; ts: number }[];
  scroll_top: Record<string, number>;
  doc_theme: Record<string, "dark" | "light">;
  last_file: string | null;
  last_workspace: string | null;
  window: [number, number, number, number] | null;
}

export interface AppInfo {
  version: string;
  data_dir: string;
  platform: string;
}

/** 默认设置（Rust 侧 state.json 缺省值的镜像） */
export function defaultAppState(): AppState {
  return {
    theme: "auto",
    mode: "read",
    font_size: 17,
    measure: 884, // 52em @ 17px
    line_spacing: 1.75,
    sidebar_open: true,
    sidebar_width: 210,
    split_ratio: 0.5,
    autosave: true,
    editor_wrap: true,
    show_status: true,
    minimal_open: false,
    check_updates: false,
    update_repo: "",
    favorites: [],
    recent: [],
    scroll_top: {},
    doc_theme: {},
    last_file: null,
    last_workspace: null,
    window: null,
  };
}

/* -------------------------------------------------------------------------- */
/* 环境探测                                                                    */
/* -------------------------------------------------------------------------- */

/** 是否运行在 Tauri 窗口里（纯浏览器预览为 false，走 mock 后端） */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/* -------------------------------------------------------------------------- */
/* mock 文件系统（仅浏览器预览）                                                */
/* -------------------------------------------------------------------------- */

interface MockNode {
  content: string;
  mtime: number;
}

const MOCK_ROOT = "D:/笔记";

/** 千万字级演示件（>1MB，验证 read_doc_blocks 分块通道） */
function generateLongDoc(): string {
  const corpus = [
    "山河远阔，人间烟火。清晨的薄雾自江面升起，橹声欸乃，惊起一行白鹭，远处渔火三两点，与星光连成一片，分不清天上人间。",
    "他翻开那本旧书，纸页间夹着风干的花瓣，字迹已经洇开，却仍能辨认出当年心血；所谓岁月，不过是把滚烫的东西一点点焐凉，再一点点焐热。",
    "千帆过尽，江水依旧东流。所谓江山，不过是一代代人脚下的路、碗里的饭、灯下的书；所谓历史，不过是有人在渡口回了一次头。",
    "The mountains rise in silence, and rivers run without asking why — such is the way of all things, and of all men who write about them.",
    "技术笔记：虚拟滚动的关键是高度模型。Fenwick 树可以在 O(log n) 内完成前缀和更新与查询，配合锚点补偿可消除测量抖动；块级懒挂载保证 DOM 规模与视口相关而与文档长度无关。",
    "雨落进江里，声音比落进海里轻。渡船的人不说话，橹声替他说了；岸上的人也不说话，灯火替他说了。",
  ];
  const parts: string[] = ["# 千里江山传\n\n> 一部用于压测分块读取通道的长篇演示文档。\n"];
  for (let i = 1; i <= 1500; i++) {
    parts.push(`## 第${i}章 江山万里\n`);
    for (let j = 0; j < 12; j++) {
      parts.push(corpus[(i + j) % corpus.length] + "\n");
    }
    if (i % 40 === 0) {
      parts.push("\n```rust\nfn main() {\n    println!(\"第{}章完\", " + i + ");\n}\n```\n");
    }
  }
  return parts.join("\n");
}

function createMockFs(): Map<string, MockNode> {
  const now = Date.now();
  const fs = new Map<string, MockNode>();
  const put = (p: string, content: string) => fs.set(p, { content, mtime: now });

  put(
    `${MOCK_ROOT}/欢迎使用墨卷.md`,
    [
      "# 欢迎使用墨卷",
      "",
      "墨卷是一款本地 Markdown 阅读器。这份文档用于浏览器预览模式的演示。",
      "",
      "## 快捷键",
      "",
      "- `Ctrl+O` 打开文件，`Ctrl+P` 快速切换",
      "- `Ctrl+E` 阅读与编辑模式切换，`F8` 极简模式",
      "- `Ctrl+滚轮` 缩放字号，`Ctrl+0` 复位",
      "",
      "## 功能",
      "",
      "1. 大纲跳转与进度记忆",
      "2. 全文查找（阅读区 Ctrl+F）",
      "3. 暗色与亮色主题",
      "",
      "```js",
      "console.log(\"hello mojuan\");",
      "```",
      "",
      "| 项目 | 状态 |",
      "| --- | --- |",
      "| 渲染管线 | 完成 |",
      "| 界面整合 | 本任务 |",
    ].join("\n"),
  );
  put(
    `${MOCK_ROOT}/随想录.md`,
    [
      "# 随想录",
      "",
      "把零散的念头记在这里。",
      "",
      "## 二〇二四年",
      "",
      "- 读书如渡江，渡过一程便少一程的迷雾。",
      "- 写作是最诚实的思考。",
      "",
      "## 二〇二五年",
      "",
      "- 工具应当安静，内容才是主角。",
    ].join("\n"),
  );
  put(`${MOCK_ROOT}/长篇/千里江山传.md`, generateLongDoc());
  put(
    `${MOCK_ROOT}/长篇/第二卷草稿.md`,
    ["# 第二卷（草稿）", "", "提纲：", "", "1. 江北的雪", "2. 渡口的选择", "3. 故人重逢"].join("\n"),
  );
  put(
    `${MOCK_ROOT}/项目/README.md`,
    ["# 项目说明", "", "这是一个用于演示文件树与工作区搜索的示例目录。", "", "## 构建", "", "```bash", "npm run build", "```"].join("\n"),
  );
  put(
    `${MOCK_ROOT}/项目/会议纪要.md`,
    ["# 会议纪要", "", "时间：周一上午", "", "- 确认界面整合方案", "- 里程碑：W4 界面交互层"].join("\n"),
  );
  return fs;
}

/** mock 状态落盘（localStorage），Tauri 真环境走 state.json */
const MOCK_STATE_KEY = "mojuan.mock.state.v1";

function loadMockState(): AppState {
  try {
    const raw = localStorage.getItem(MOCK_STATE_KEY);
    if (raw) return { ...defaultAppState(), ...JSON.parse(raw) };
  } catch {
    /* 忽略损坏数据 */
  }
  const base = defaultAppState();
  base.last_workspace = MOCK_ROOT;
  base.recent = [
    { path: `${MOCK_ROOT}/欢迎使用墨卷.md`, ts: Math.floor(Date.now() / 1000) - 3600 },
    { path: `${MOCK_ROOT}/随想录.md`, ts: Math.floor(Date.now() / 1000) - 7200 },
  ];
  return base;
}

/* --------------------------- mock 分块/大纲（与 VIndex 行为对齐） ----------- */

interface MockSlice {
  text: string;
  line: number;
  endLine: number;
  kind: DocBlock["kind"];
  level: number;
}

/** 按空行切块；围栏代码块内部不切（对齐后端 VIndex 的块边界语义） */
function sliceMockBlocks(text: string): MockSlice[] {
  const lines = text.split("\n");
  const slices: MockSlice[] = [];
  let cur: string[] = [];
  let curStart = 1;
  let inFence = false;
  let fenceChar = "";
  const flush = (endLine: number) => {
    if (cur.length === 0) return;
    const t = cur.join("\n");
    const first = t.trimStart();
    let kind: DocBlock["kind"] = "para";
    let level = 0;
    if (/^#{1,6}\s/.test(first)) {
      kind = "heading";
      level = (first.match(/^#+/) ?? ["#"])[0]!.length;
    } else if (first.startsWith("```")) kind = "code";
    else if (first.startsWith(">")) kind = "quote";
    else if (/^([-*+]|\d+\.)\s/.test(first)) kind = "list";
    else if (first.startsWith("|")) kind = "table";
    else if (/^(---|\*\*\*|___)\s*$/.test(first)) kind = "rule";
    slices.push({ text: t, line: curStart, endLine: endLine, kind, level });
    cur = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const ln = i + 1;
    if (inFence) {
      cur.push(line);
      if (line.trimStart().startsWith(fenceChar)) inFence = false;
      continue;
    }
    const t = line.trimStart();
    if (t.startsWith("```")) {
      if (cur.length === 0) curStart = ln;
      inFence = true;
      fenceChar = t[0]!;
      cur.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush(ln - 1);
      continue;
    }
    if (cur.length === 0) curStart = ln;
    cur.push(line);
  }
  flush(lines.length);
  return slices;
}

function mockDocBlocks(text: string, from: number, max: number): DocBlocks {
  const slices = sliceMockBlocks(text);
  const total = slices.length;
  const out: DocBlock[] = [];
  for (let i = Math.max(0, Math.min(from, total)); i < Math.min(total, from + max); i++) {
    const s = slices[i]!;
    out.push({
      index: i,
      kind: s.kind,
      level: s.level,
      text: s.text,
      line: s.line,
      end_line: s.endLine,
      height: Math.max(24, s.text.split("\n").length * 24),
    });
  }
  return { blocks: out, total, done: from + out.length >= total };
}

function mockOutline(text: string): OutlineItem[] {
  const slices = sliceMockBlocks(text);
  const items: OutlineItem[] = [];
  for (const s of slices) {
    if (s.kind !== "heading") continue;
    items.push({
      level: s.level,
      text: s.text.replace(/^#{1,6}\s+/, "").replace(/[*`]/g, "").trim(),
      line: s.line,
      block_index: slices.indexOf(s),
    });
  }
  return items;
}

/* --------------------------- mock 树/目录 ---------------------------------- */

function isDirPath(p: string): boolean {
  return !/\.(md|markdown|txt)$/i.test(p);
}

function mockChildren(fs: Map<string, MockNode>, dir: string): FileEntry[] {
  const prefix = dir.endsWith("/") ? dir : dir + "/";
  const seen = new Set<string>();
  const dirs: FileEntry[] = [];
  const files: FileEntry[] = [];
  for (const p of fs.keys()) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (rest.includes("/")) {
      const name = rest.split("/")[0]!;
      if (seen.has(name)) continue;
      seen.add(name);
      dirs.push({ name, path: prefix + name, is_dir: true, expanded: false });
    } else {
      seen.add(rest);
      files.push({ name: rest, path: p, is_dir: false, expanded: false });
    }
  }
  const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name, "zh");
  return [...dirs.sort(byName), ...files.sort(byName)];
}

function buildMockTree(fs: Map<string, MockNode>, root: string): WorkspaceTree {
  return {
    root,
    name: root.split("/").pop() ?? root,
    children: mockChildren(fs, root),
  };
}

/* --------------------------- mock 搜索 ------------------------------------- */

function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0.1;
  if (t.includes(q)) return 100 - t.indexOf(q) * 0.1;
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return 0;
    streak = idx === ti ? streak + 1 : 0;
    score += 1 + streak * 0.5;
    ti = idx + 1;
  }
  return score;
}

/* -------------------------------------------------------------------------- */
/* 对外 API                                                                    */
/* -------------------------------------------------------------------------- */

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/**
 * 后端门面。浏览器预览时所有方法都走 mock；Tauri 时走真实命令。
 * 通过 `api.kind` 可区分环境（App 里打开对话框等场景需要分支）。
 */
export const api = {
  kind: (isTauri ? "tauri" : "mock") as "tauri" | "mock",

  loadState(): Promise<AppState> {
    if (isTauri) return tauriInvoke<AppState>("load_state");
    return Promise.resolve(loadMockState());
  },

  saveState(state: AppState): Promise<void> {
    if (isTauri) return tauriInvoke("save_state", { state });
    try {
      localStorage.setItem(MOCK_STATE_KEY, JSON.stringify(state));
    } catch {
      /* 忽略配额错误 */
    }
    return Promise.resolve();
  },

  openWorkspace(path: string): Promise<WorkspaceTree> {
    if (isTauri) return tauriInvoke("open_workspace", { path });
    const fs = mockFs();
    if (isDirPath(path) && [...fs.keys()].some((p) => p === path || p.startsWith(path + "/"))) {
      return Promise.resolve(buildMockTree(fs, path));
    }
    return Promise.reject(`文件夹不存在或无法访问：${path}`);
  },

  listDir(path: string): Promise<FileEntry[]> {
    if (isTauri) return tauriInvoke("list_dir", { path });
    return Promise.resolve(mockChildren(mockFs(), path));
  },

  async readDoc(path: string): Promise<DocContent> {
    if (isTauri) return tauriInvoke<DocContent>("read_doc", { path });
    const node = mockFs().get(path);
    if (!node) return Promise.reject(`文件不存在：${path}`);
    if (node.content.length > 40 * 1024 * 1024) return Promise.reject("文件超过 40 MB，无法打开");
    return {
      raw: node.content,
      encoding: "utf-8",
      is_plain: path.toLowerCase().endsWith(".txt"),
      mtime: node.mtime,
    };
  },

  readDocBlocks(path: string, from: number, max = 40): Promise<DocBlocks> {
    if (isTauri) return tauriInvoke("read_doc_blocks", { path, from, max: Math.min(500, max) });
    const node = mockFs().get(path);
    if (!node) return Promise.reject(`文件不存在：${path}`);
    return Promise.resolve(mockDocBlocks(node.content, from, max));
  },

  docOutline(path: string): Promise<OutlineItem[]> {
    if (isTauri) return tauriInvoke("doc_outline", { path });
    const node = mockFs().get(path);
    if (!node) return Promise.reject(`文件不存在：${path}`);
    return Promise.resolve(mockOutline(node.content));
  },

  saveDoc(path: string, content: string, encoding: string): Promise<void> {
    if (isTauri) return tauriInvoke("save_doc", { path, content, encoding });
    const fs = mockFs();
    if (!fs.has(path)) return Promise.reject(`文件不存在：${path}`);
    fs.set(path, { content, mtime: Date.now() });
    return Promise.resolve();
  },

  createFile(path: string, content: string): Promise<void> {
    if (isTauri) return tauriInvoke("create_file", { path, content });
    const fs = mockFs();
    if (fs.has(path)) return Promise.reject(`文件已存在：${path}`);
    fs.set(path, { content, mtime: Date.now() });
    return Promise.resolve();
  },

  renameEntry(from: string, to: string): Promise<void> {
    if (isTauri) return tauriInvoke("rename_entry", { from, to });
    const fs = mockFs();
    if (!fs.has(from)) return Promise.reject(`源不存在：${from}`);
    if (fs.has(to)) return Promise.reject(`目标已存在：${to}`);
    const moved: [string, MockNode][] = [];
    for (const [p, node] of fs) {
      if (p === from || p.startsWith(from + "/")) {
        moved.push([to + p.slice(from.length), node]);
        fs.delete(p);
      }
    }
    for (const [p, node] of moved) fs.set(p, node);
    return Promise.resolve();
  },

  deleteEntry(path: string): Promise<void> {
    if (isTauri) return tauriInvoke("delete_entry", { path });
    const fs = mockFs();
    let removed = false;
    for (const p of [...fs.keys()]) {
      if (p === path || p.startsWith(path + "/")) {
        fs.delete(p);
        removed = true;
      }
    }
    if (!removed) return Promise.reject(`文件或文件夹不存在：${path}`);
    return Promise.resolve();
  },

  watchDoc(path: string): Promise<void> {
    if (isTauri) return tauriInvoke("watch_doc", { path });
    return Promise.resolve();
  },

  searchWorkspace(root: string, query: string, limit = 200): Promise<SearchHit[]> {
    if (isTauri) return tauriInvoke("search_workspace", { root, query, limit });
    const hits: SearchHit[] = [];
    const fs = mockFs();
    for (const [p, node] of fs) {
      if (!p.startsWith(root) && root !== "/") continue;
      const rel = p.slice(root.length + 1);
      const nameScore = fuzzyScore(query, rel);
      if (nameScore > 0) hits.push({ path: p, line: 0, text: rel, score: nameScore + 50 });
      if (hits.length >= limit) break;
      const lines = node.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const idx = lines[i]!.toLowerCase().indexOf(query.toLowerCase());
        if (query && idx >= 0) {
          const start = Math.max(0, idx - 30);
          hits.push({
            path: p,
            line: i + 1,
            text: (start > 0 ? "…" : "") + lines[i]!.slice(start, idx + query.length + 50) + "…",
            score: 10,
          });
          if (hits.length >= limit) break;
        }
      }
      if (hits.length >= limit) break;
    }
    return Promise.resolve(hits.sort((a, b) => b.score - a.score));
  },

  searchFilenames(root: string, query: string, limit = 100): Promise<SearchHit[]> {
    if (isTauri) return tauriInvoke("search_filenames", { root, query, limit });
    const hits: SearchHit[] = [];
    for (const p of mockFs().keys()) {
      if (!p.startsWith(root) && root !== "/") continue;
      const rel = p.slice(root.length + 1);
      const score = fuzzyScore(query, rel);
      if (score > 0) hits.push({ path: p, line: 0, text: rel, score });
    }
    return Promise.resolve(hits.sort((a, b) => b.score - a.score).slice(0, limit));
  },

  async appInfo(): Promise<AppInfo | null> {
    if (isTauri) {
      try {
        return await tauriInvoke<AppInfo>("app_info");
      } catch {
        return null;
      }
    }
    return { version: "browser-preview", data_dir: "(浏览器内存)", platform: "web" };
  },

  async revealInExplorer(path: string): Promise<void> {
    if (isTauri) {
      try {
        await tauriInvoke("reveal_in_explorer", { path });
      } catch (e) {
        void e;
      }
    }
  },

  async openUrl(url: string): Promise<void> {
    if (isTauri) {
      try {
        await tauriInvoke("open_url", { url });
      } catch (e) {
        void e;
      }
    } else {
      window.open(url, "_blank");
    }
  },

  /** 系统打开文件对话框（Tauri plugin-dialog）；mock 环境返回 null 由上层自行兜底 */
  async openFileDialog(): Promise<string | null> {
    if (!isTauri) return null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Markdown / 文本", extensions: ["md", "markdown", "txt"] }],
      });
      return typeof picked === "string" ? picked : null;
    } catch (e) {
      // 插件未就绪等情况：让上层走手动输入兜底
      console.warn("openFileDialog 失败", e);
      return null;
    }
  },

  /** 系统打开文件夹对话框 */
  async openDirDialog(): Promise<string | null> {
    if (!isTauri) return null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ multiple: false, directory: true });
      return typeof picked === "string" ? picked : null;
    } catch (e) {
      console.warn("openDirDialog 失败", e);
      return null;
    }
  },

  /** 系统保存对话框（新建文件用）；mock 环境返回 null */
  async saveFileDialog(defaultName: string): Promise<string | null> {
    if (!isTauri) return null;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const picked = await save({
        defaultPath: defaultName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      return typeof picked === "string" ? picked : null;
    } catch (e) {
      console.warn("saveFileDialog 失败", e);
      return null;
    }
  },
};

/** mock FS 单例（浏览器预览用；Tauri 下不会被触达） */
let mockFsInstance: Map<string, MockNode> | null = null;
function mockFs(): Map<string, MockNode> {
  if (!mockFsInstance) mockFsInstance = createMockFs();
  return mockFsInstance;
}

/** 供欢迎页/测试读取 mock 文件列表（Tauri 下返回空） */
export function mockListPaths(): string[] {
  return isTauri ? [] : [...mockFs().keys()];
}

/** 把任意路径规范成统一形态（用于 recents/scroll_top 键） */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}
