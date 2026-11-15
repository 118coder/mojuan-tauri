/**
 * 工作区状态管理 hooks（W4b）
 * ---------------------------------------------------------------------------
 * - useAppStore：AppState（设置/最近文件/进度表）加载、合并修改、节流落盘。
 *     * patch：一般设置变更，800ms 防抖保存（契约约定 500ms 量级）；
 *     * noteScroll：阅读进度写入，3s 节流保存（任务书要求）；
 *     * flush：切标签/关标签/关窗前立即保存。
 * - useWorkspace：多标签页（打开/切换/关闭/保存/脏标记），>1MB 文档走
 *   read_doc_blocks 分块重组（契约约定），渲染块在打开时一次性产出。
 * - useFileTree：文件树懒加载（open_workspace 一层 + list_dir 展开）。
 * - useNavHistory：Alt+←/→ 导航历史栈。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, defaultAppState, normalizePath } from "./backend";
import type { AppState, FileEntry, WorkspaceTree } from "./backend";
import { renderBlocks } from "./renderer";
import type { Block, ReaderTheme } from "./renderer";

/* -------------------------------------------------------------------------- */
/* 标签类型                                                                    */
/* -------------------------------------------------------------------------- */

export interface Tab {
  /** 唯一键：文件绝对路径；演示文档等虚拟内容用 demo:// 前缀 */
  path: string;
  name: string;
  content: string;
  encoding: "utf-8" | "gbk";
  isPlain: boolean;
  mtime: number;
  /** >1MB：走了 read_doc_blocks 分块通道 */
  big: boolean;
  /** 虚拟文档（演示件）：不可保存、不进最近列表 */
  virtual: boolean;
  dirty: boolean;
  loading: boolean;
  error: string | null;
  /** 渲染块（阅读用）；.txt 走纯文本块 */
  blocks: Block[] | null;
  /** 行数（跳转到行的比例换算用） */
  lineCount: number;
  /** 外部修改等提示 */
  notice: string | null;
}

const RECENT_CAP = 20;
const BIG_FILE_THRESHOLD = 1024 * 1024; // 1MB，契约约定

/* -------------------------------------------------------------------------- */
/* AppState 存储                                                               */
/* -------------------------------------------------------------------------- */

export interface AppStore {
  state: AppState;
  ready: boolean;
  stateRef: { current: AppState };
  /** 合并修改 + 800ms 防抖保存 */
  patch(p: Partial<AppState>): void;
  /** 合并修改 + 立即保存 */
  patchNow(p: Partial<AppState>): void;
  /** 阅读进度写入（内存即时 + 3s 节流保存） */
  noteScroll(path: string, top: number): void;
  /** 立即保存（切标签/关标签/关窗前调用） */
  flush(): void;
}

export function useAppStore(): AppStore {
  const [state, setState] = useState<AppState>(defaultAppState);
  const [ready, setReady] = useState(false);
  const stateRef = useRef<AppState>(state);
  stateRef.current = state;

  const saveTimer = useRef<number | null>(null);
  const scrollTimer = useRef<number | null>(null);

  const doSave = useCallback(() => {
    if (saveTimer.current != null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    void api.saveState({ ...stateRef.current });
  }, []);

  const merge = useCallback((p: Partial<AppState>): AppState => {
    const next = { ...stateRef.current, ...p };
    stateRef.current = next;
    setState(next);
    return next;
  }, []);

  const patch = useCallback(
    (p: Partial<AppState>) => {
      merge(p);
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(doSave, 800);
    },
    [merge, doSave],
  );

  const patchNow = useCallback(
    (p: Partial<AppState>) => {
      merge(p);
      doSave();
    },
    [merge, doSave],
  );

  const noteScroll = useCallback(
    (path: string, top: number) => {
      const cur = stateRef.current;
      const prev = cur.scroll_top[path];
      if (prev !== undefined && Math.abs(prev - top) < 1) return;
      stateRef.current = { ...cur, scroll_top: { ...cur.scroll_top, [path]: top } };
      // 3s 节流落盘；尾部定时器保证最后一次也写入
      if (scrollTimer.current == null) {
        scrollTimer.current = window.setTimeout(() => {
          scrollTimer.current = null;
          if (saveTimer.current == null) doSave();
        }, 3000);
      }
    },
    [doSave],
  );

  const flush = useCallback(() => {
    doSave();
  }, [doSave]);

  // 启动加载（合并默认值，容忍旧版本字段缺失）
  useEffect(() => {
    let cancelled = false;
    void api
      .loadState()
      .then((s) => {
        if (cancelled) return;
        const merged = { ...defaultAppState(), ...s };
        stateRef.current = merged;
        setState(merged);
        setReady(true);
      })
      .catch(() => setReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  // 卸载前尽力保存一次
  useEffect(() => {
    const onHide = () => doSave();
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      doSave();
    };
  }, [doSave]);

  return { state, ready, stateRef, patch, patchNow, noteScroll, flush };
}

/** 最近文件维护：打开成功时 unshift 去重，上限 20 条 */
export function touchRecent(state: AppState, path: string): { path: string; ts: number }[] {
  const now = Math.floor(Date.now() / 1000);
  const rest = state.recent.filter((r) => normalizePath(r.path) !== normalizePath(path));
  return [{ path, ts: now }, ...rest].slice(0, RECENT_CAP);
}

/* -------------------------------------------------------------------------- */
/* 纯文本块（.txt：不走 Markdown 管线，契约约定）                                */
/* -------------------------------------------------------------------------- */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildPlainBlocks(text: string): Block[] {
  const paras = text.split(/\n{2,}/);
  const blocks: Block[] = [];
  for (const p of paras) {
    if (p.trim() === "" && blocks.length > 0) continue;
    const lines = p.split("\n").length;
    blocks.push({
      id: `b${blocks.length}`,
      index: blocks.length,
      html: `<div class="mj-plain">${escapeHtml(p) || "<br>"}</div>`,
      kind: "other",
      estHeight: Math.max(24, lines * 26 + 12),
      textLength: p.length,
      revision: 0,
    });
  }
  return blocks;
}

/* -------------------------------------------------------------------------- */
/* 大文档：read_doc_blocks 分块重组为全文（>1MB，契约约定）                       */
/* -------------------------------------------------------------------------- */

/** 块文本拼接时保证块间有空行分隔（Markdown 块级语义不受影响） */
function joinBlockText(parts: string[]): string {
  let out = "";
  for (const t of parts) {
    if (!t) continue;
    if (out) {
      // 上一段结尾补足空行
      if (out.endsWith("\n\n") || out.endsWith("\r\n\r\n")) {
        /* 已有空行 */
      } else if (out.endsWith("\n")) out += "\n";
      else out += "\n\n";
    }
    out += t;
    if (!out.endsWith("\n")) out += "\n";
  }
  return out;
}

async function loadBigSource(path: string): Promise<{ source: string; total: number }> {
  const parts: string[] = [];
  let from = 0;
  let total = 0;
  for (let guard = 0; guard < 4000; guard++) {
    const page = await api.readDocBlocks(path, from, 500);
    total = page.total;
    for (const b of page.blocks) parts.push(b.text);
    if (page.done || page.blocks.length === 0) break;
    from = page.blocks[page.blocks.length - 1]!.index + 1;
    if (from >= total) break;
  }
  return { source: joinBlockText(parts), total };
}

/* -------------------------------------------------------------------------- */
/* 工作区（标签页）                                                            */
/* -------------------------------------------------------------------------- */

export interface Workspace {
  tabs: Tab[];
  activePath: string | null;
  activeTab: Tab | null;
  openFile(path: string): Promise<void>;
  openVirtual(name: string, content: string): void;
  activate(path: string): void;
  closeTab(path: string): void;
  closeOthers(path: string): void;
  closeRight(path: string): void;
  setTabContent(path: string, v: string): void;
  saveTab(path: string): Promise<boolean>;
  reloadTab(path: string): Promise<void>;
  setTabNotice(path: string, msg: string | null): void;
  /** 内容变更后重新解析渲染块（分屏模式防抖由上层控制调用时机） */
  rerenderTab(path: string): void;
}

export function useWorkspace(store: AppStore, themeGetter: () => ReaderTheme): Workspace {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  const updateTab = useCallback((path: string, p: Partial<Tab>) => {
    setTabs((list) => list.map((t) => (t.path === path ? { ...t, ...p } : t)));
  }, []);

  /** 打开文档主体：read_doc →（>1MB 走分块）→ 渲染块 → 恢复进度 */
  const loadIntoTab = useCallback(
    async (tabPath: string) => {
      try {
        const doc = await api.readDoc(tabPath);
        let source = doc.raw;
        let big = false;
        let lineCount = source.split("\n").length;
        if (source.length > BIG_FILE_THRESHOLD) {
          // 契约约定：>1MB 改走分块通道（避免单笔大 payload）
          const loaded = await loadBigSource(tabPath);
          source = loaded.source;
          big = true;
          lineCount = source.split("\n").length;
        }
        // 让 loading 状态先画一帧，再进入同步解析（大文档约 1~2s）
        await new Promise((r) => setTimeout(r, 20));
        const blocks = doc.is_plain ? buildPlainBlocks(source) : renderBlocks(source, { theme: themeGetter() });
        updateTab(tabPath, {
          content: source,
          encoding: doc.encoding,
          isPlain: doc.is_plain,
          mtime: doc.mtime,
          big,
          blocks,
          lineCount,
          loading: false,
          error: null,
          dirty: false,
        });
        void api.watchDoc(tabPath).catch(() => void 0);
      } catch (e) {
        updateTab(tabPath, { loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    [themeGetter, updateTab],
  );

  const openFile = useCallback(
    async (path: string) => {
      const p = normalizePath(path);
      const existed = tabsRef.current.some((t) => t.path === p);
      if (!existed) {
        const name = p.split("/").pop() ?? p;
        const tab: Tab = {
          path: p,
          name,
          content: "",
          encoding: "utf-8",
          isPlain: false,
          mtime: 0,
          big: false,
          virtual: false,
          dirty: false,
          loading: true,
          error: null,
          blocks: null,
          lineCount: 0,
          notice: null,
        };
        setTabs((list) => [...list, tab]);
      }
      setActivePath(p);
      // 最近文件 + last_file 落库（虚拟文档不进）
      store.patch({
        recent: touchRecent(store.stateRef.current, p),
        last_file: p,
      });
      if (existed) return;
      await loadIntoTab(p);
    },
    [loadIntoTab, store],
  );

  const openVirtual = useCallback(
    (name: string, content: string) => {
      const p = `demo://${name}`;
      if (tabsRef.current.some((t) => t.path === p)) {
        setActivePath(p);
        return;
      }
      const blocks = renderBlocks(content, { theme: themeGetter() });
      const tab: Tab = {
        path: p,
        name,
        content,
        encoding: "utf-8",
        isPlain: false,
        mtime: 0,
        big: false,
        virtual: true,
        dirty: false,
        loading: false,
        error: null,
        blocks,
        lineCount: content.split("\n").length,
        notice: null,
      };
      setTabs((list) => [...list, tab]);
      setActivePath(p);
    },
    [themeGetter],
  );

  /** 激活切换：先把当前阅读进度立即落库 */
  const activate = useCallback(
    (path: string) => {
      if (path === activePathRef.current) return;
      setActivePath(path);
      store.patch({ last_file: path });
    },
    [store],
  );

  const closeTab = useCallback(
    (path: string) => {
      setTabs((list) => {
        const idx = list.findIndex((t) => t.path === path);
        if (idx < 0) return list;
        const next = list.filter((t) => t.path !== path);
        if (activePathRef.current === path) {
          const neighbor = next[Math.min(idx, next.length - 1)];
          const nextPath = neighbor?.path ?? null;
          activePathRef.current = nextPath;
          setActivePath(nextPath);
          if (nextPath) store.patch({ last_file: nextPath });
        }
        return next;
      });
    },
    [store],
  );

  const closeOthers = useCallback(
    (path: string) => {
      setTabs((list) => {
        const keep = list.filter((t) => t.path === path);
        if (activePathRef.current !== path && keep.length > 0) {
          activePathRef.current = path;
          setActivePath(path);
        }
        return keep;
      });
    },
    [],
  );

  const closeRight = useCallback(
    (path: string) => {
      setTabs((list) => {
        const idx = list.findIndex((t) => t.path === path);
        if (idx < 0) return list;
        const next = list.slice(0, idx + 1);
        if (!next.some((t) => t.path === activePathRef.current)) {
          activePathRef.current = path;
          setActivePath(path);
        }
        return next;
      });
    },
    [],
  );

  const setTabContent = useCallback(
    (path: string, v: string) => {
      setTabs((list) =>
        list.map((t) =>
          t.path === path && t.content !== v ? { ...t, content: v, dirty: !t.virtual, lineCount: v.split("\n").length } : t,
        ),
      );
    },
    [],
  );

  const saveTab = useCallback(
    async (path: string): Promise<boolean> => {
      const tab = tabsRef.current.find((t) => t.path === path);
      if (!tab || tab.virtual) return false;
      try {
        await api.saveDoc(path, tab.content, tab.encoding);
        updateTab(path, { dirty: false, mtime: Date.now() });
        return true;
      } catch (e) {
        updateTab(path, { notice: "保存失败：" + (e instanceof Error ? e.message : String(e)) });
        return false;
      }
    },
    [updateTab],
  );

  const reloadTab = useCallback(
    async (path: string) => {
      updateTab(path, { loading: true, error: null });
      await loadIntoTab(path);
    },
    [loadIntoTab, updateTab],
  );

  const setTabNotice = useCallback(
    (path: string, msg: string | null) => {
      updateTab(path, { notice: msg });
    },
    [updateTab],
  );

  const rerenderTab = useCallback(
    (path: string) => {
      const tab = tabsRef.current.find((t) => t.path === path);
      if (!tab) return;
      const blocks = tab.isPlain ? buildPlainBlocks(tab.content) : renderBlocks(tab.content, { theme: themeGetter() });
      updateTab(path, { blocks });
    },
    [themeGetter, updateTab],
  );

  const activeTab = useMemo(() => tabs.find((t) => t.path === activePath) ?? null, [tabs, activePath]);

  return {
    tabs,
    activePath,
    activeTab,
    openFile,
    openVirtual,
    activate,
    closeTab,
    closeOthers,
    closeRight,
    setTabContent,
    saveTab,
    reloadTab,
    setTabNotice,
    rerenderTab,
  };
}

/* -------------------------------------------------------------------------- */
/* 文件树                                                                      */
/* -------------------------------------------------------------------------- */

export interface FileTreeApi {
  tree: WorkspaceTree | null;
  treeError: string | null;
  /** 展开的目录集合 */
  expanded: Set<string>;
  openRoot(path: string): Promise<void>;
  toggleDir(entry: FileEntry): Promise<void>;
  refresh(): Promise<void>;
}

export function useFileTree(): FileTreeApi & { currentRoot: string | null } {
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const openRoot = useCallback(async (path: string) => {
    setTreeError(null);
    try {
      const t = await api.openWorkspace(path);
      setTree(t);
      const rootSet = new Set<string>([t.root]);
      setExpanded(rootSet);
    } catch (e) {
      setTreeError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const toggleDir = useCallback(async (entry: FileEntry) => {
    const willOpen = !treeRef.current ? true : !entry.expanded;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(entry.path);
      else next.delete(entry.path);
      return next;
    });
    // 懒加载：children 缺失时调 list_dir 再填
    if (willOpen && treeRef.current) {
      const t = treeRef.current;
      if (!hasChildren(t, entry.path)) {
        try {
          const children = await api.listDir(entry.path);
          const next = cloneTreeWithChildren(t, entry.path, children);
          setTree(next);
        } catch (e) {
          setTreeError(e instanceof Error ? e.message : String(e));
        }
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    const t = treeRef.current;
    if (!t) return;
    try {
      const fresh = await api.openWorkspace(t.root);
      // 把已展开目录的 children 重新拉一遍
      const expandList = [...expandedRef.current];
      let merged = fresh;
      for (const dir of expandList) {
        if (dir === fresh.root) continue;
        if (!hasChildren(merged, dir)) continue;
        try {
          const children = await api.listDir(dir);
          merged = cloneTreeWithChildren(merged, dir, children);
        } catch {
          /* 目录可能已被删除 */
        }
      }
      setTree(merged);
      setTreeError(null);
    } catch (e) {
      setTreeError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return { tree, treeError, expanded, openRoot, toggleDir, refresh, currentRoot: tree?.root ?? null };
}

function hasChildren(tree: WorkspaceTree, dirPath: string): boolean {
  const find = (nodes: FileEntry[]): boolean => {
    for (const n of nodes) {
      if (n.path === dirPath) return n.children != null;
      if (n.children && find(n.children)) return true;
    }
    return false;
  };
  return find(tree.children);
}

function cloneTreeWithChildren(tree: WorkspaceTree, dirPath: string, children: FileEntry[]): WorkspaceTree {
  const clone = (nodes: FileEntry[]): FileEntry[] =>
    nodes.map((n) => {
      if (n.path === dirPath) return { ...n, children, expanded: true };
      if (n.children) return { ...n, children: clone(n.children) };
      return n;
    });
  return { ...tree, children: clone(tree.children) };
}

/* -------------------------------------------------------------------------- */
/* 导航历史（Alt+←/→）                                                          */
/* -------------------------------------------------------------------------- */

export interface NavEntry {
  path: string;
  scrollTop: number;
}

export interface NavHistory {
  /** 新导航点（打开文档/大纲跳转/百分比跳转时调用） */
  push(entry: NavEntry): void;
  /** 同步当前导航点的阅读位置（滚动 progress 回调里调用，纯 ref 写入） */
  setCurTop(top: number): void;
  /** 返回：返回目标，无历史返回 null（调用方先把当前进度记进 cur） */
  back(current: NavEntry): NavEntry | null;
  forward(current: NavEntry): NavEntry | null;
}

export function useNavHistory(): NavHistory {
  const backStack = useRef<NavEntry[]>([]);
  const fwdStack = useRef<NavEntry[]>([]);
  const cur = useRef<NavEntry | null>(null);

  const push = useCallback((entry: NavEntry) => {
    if (cur.current && cur.current.path === entry.path && Math.abs(cur.current.scrollTop - entry.scrollTop) < 8) {
      cur.current = entry;
      return;
    }
    if (cur.current) backStack.current.push(cur.current);
    if (backStack.current.length > 200) backStack.current.shift();
    cur.current = entry;
    fwdStack.current = [];
  }, []);

  const setCurTop = useCallback((top: number) => {
    if (cur.current) cur.current = { ...cur.current, scrollTop: top };
  }, []);

  const back = useCallback((current: NavEntry): NavEntry | null => {
    const prev = backStack.current.pop();
    if (!prev) return null;
    if (cur.current) fwdStack.current.push(current);
    cur.current = prev;
    return prev;
  }, []);

  const forward = useCallback((current: NavEntry): NavEntry | null => {
    const next = fwdStack.current.pop();
    if (!next) return null;
    if (cur.current) backStack.current.push(current);
    cur.current = next;
    return next;
  }, []);

  return { push, setCurTop, back, forward };
}
