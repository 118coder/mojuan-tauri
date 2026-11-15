/**
 * 侧栏（W4b 任务书第 3 条 / 调研 P0 第 5 条）
 * ---------------------------------------------------------------------------
 * 三段折叠：
 *  1. 目录大纲：点击跳块 + 跟随滚动高亮当前章节（万级条目做 400 条窗口化，
 *     沿用 W3 压测验证过的方案）；
 *  2. 工作区文件树：open_workspace 一层 + list_dir 懒加载展开；双击打开文件；
 *     新建/重命名/删除（确认对话框由 App 层处理）；
 *  3. 工作区搜索：search_workspace 结果列表，点击打开并定位行。
 * 宽度拖拽可调（--sidebar-w 210~420）。
 */

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { FileEntry, WorkspaceTree } from "../lib/backend";

export interface OutlineRow {
  index: number;
  level: number;
  text: string;
}

export interface SidebarProps {
  width: number;
  onWidthChange(w: number): void;

  outline: OutlineRow[];
  currentBlockIndex: number;
  onOutlineJump(index: number): void;

  tree: WorkspaceTree | null;
  treeError: string | null;
  expanded: Set<string>;
  activeFilePath: string | null;
  onToggleDir(entry: FileEntry): void;
  onOpenFile(path: string): void;
  onEntryContextMenu(e: MouseEvent, entry: FileEntry): void;
  onNewFile(): void;
  onOpenWorkspace(): void;

  workspaceRoot: string | null;
  onSearchOpen(path: string, line: number): void;
}

const OUTLINE_WINDOW = 400;

/* ------------------------------ 大纲段 ------------------------------ */

function OutlineSection(props: {
  outline: OutlineRow[];
  currentBlockIndex: number;
  onJump(index: number): void;
}) {
  const { outline, currentBlockIndex, onJump } = props;
  const [start, setStart] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 用户手动滚动大纲后暂停 1.5s 自动跟随，避免打断浏览 */
  const manualUntil = useRef(0);

  // 大纲窗口：跟随当前块平移（二分找当前章节）
  useEffect(() => {
    if (outline.length <= OUTLINE_WINDOW) return;
    let lo = 0;
    let hi = outline.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (outline[mid]!.index < currentBlockIndex) lo = mid + 1;
      else hi = mid;
    }
    const anchor = lo;
    const now = Date.now();
    if (now < manualUntil.current) return;
    setStart((prev) => {
      if (anchor >= prev && anchor < prev + OUTLINE_WINDOW) return prev;
      return Math.max(0, Math.min(anchor - 40, Math.max(0, outline.length - OUTLINE_WINDOW)));
    });
  }, [currentBlockIndex, outline]);

  // 跟随高亮：当前章节 = 最后一个 index <= 当前块的标题
  const activeOutlineIdx = useMemo(() => {
    let lo = 0;
    let hi = outline.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (outline[mid]!.index <= currentBlockIndex) lo = mid + 1;
      else hi = mid - 1;
    }
    return hi; // 最后一个 <= 当前块的标题
  }, [outline, currentBlockIndex]);

  const slice = outline.slice(start, start + OUTLINE_WINDOW);

  return (
    <div class="side-section outline-section">
      <div class="side-head">
        <span>大纲（{outline.length.toLocaleString()}）</span>
        {outline.length > OUTLINE_WINDOW && (
          <span class="side-head-hint">
            {start + 1}-{Math.min(start + OUTLINE_WINDOW, outline.length)}
          </span>
        )}
      </div>
      {outline.length === 0 ? (
        <div class="side-empty">本文档没有标题大纲</div>
      ) : (
        <div
          class="side-list outline-list"
          ref={listRef}
          onScroll={(e: Event) => {
            // 滚到大纲窗口边缘时平移窗口（万级标题不一次渲染）
            const el = e.currentTarget as HTMLDivElement;
            manualUntil.current = Date.now() + 1500;
            const max = outline.length - OUTLINE_WINDOW;
            if (max <= 0) return;
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) {
              setStart((p) => Math.min(max, p + 200));
            } else if (el.scrollTop <= 2 && start > 0) {
              setStart((p) => Math.max(0, p - 200));
            }
          }}
        >
          {slice.map((row, i) => {
            const realIdx = start + i;
            const active = realIdx === activeOutlineIdx;
            return (
              <button
                key={row.index}
                class={"outline-item" + (active ? " active" : "")}
                style={{ paddingLeft: `${10 + (row.level - 1) * 12}px` }}
                title={`跳转到第 ${row.index + 1} 块`}
                data-block-index={row.index}
                onClick={() => onJump(row.index)}
              >
                {row.text || "(无标题)"}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ 文件树段 ------------------------------ */

function TreeRows(props: {
  nodes: FileEntry[];
  depth: number;
  expanded: Set<string>;
  activeFilePath: string | null;
  onToggleDir(entry: FileEntry): void;
  onOpenFile(path: string): void;
  onEntryContextMenu(e: MouseEvent, entry: FileEntry): void;
}) {
  const { nodes, depth, expanded, activeFilePath, onToggleDir, onOpenFile, onEntryContextMenu } = props;
  return (
    <>
      {nodes.map((n) => {
        const open = expanded.has(n.path);
        return (
          <div key={n.path}>
            <div
              class={"tree-row" + (n.is_dir ? " dir" : "") + (n.path === activeFilePath ? " active" : "")}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              title={n.path}
              onClick={() => {
                if (n.is_dir) void onToggleDir(n);
                // 单击文件仅选中高亮；双击打开
              }}
              onDblClick={() => {
                if (!n.is_dir) onOpenFile(n.path);
              }}
              onContextMenu={(e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                onEntryContextMenu(e, n);
              }}
            >
              <span class={"tree-arrow" + (open ? " open" : "") + (n.is_dir ? "" : " hidden")}>
                <svg viewBox="0 0 8 8" width="8" height="8">
                  <path d="M2 1l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.2" />
                </svg>
              </span>
              <span class="tree-name">{n.name}</span>
            </div>
            {n.is_dir && open && n.children && (
              <TreeRows
                nodes={n.children}
                depth={depth + 1}
                expanded={expanded}
                activeFilePath={activeFilePath}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
                onEntryContextMenu={onEntryContextMenu}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function FilesSection(props: {
  tree: WorkspaceTree | null;
  treeError: string | null;
  expanded: Set<string>;
  activeFilePath: string | null;
  onToggleDir(entry: FileEntry): void;
  onOpenFile(path: string): void;
  onEntryContextMenu(e: MouseEvent, entry: FileEntry): void;
  onNewFile(): void;
  onOpenWorkspace(): void;
}) {
  const { tree, treeError } = props;
  return (
    <div class="side-section files-section">
      <div class="side-head">
        <span class="side-head-title" title={tree?.root ?? ""}>
          {tree ? tree.name : "工作区"}
        </span>
        <span class="side-head-btns">
          <button class="side-btn" title="新建文件" onClick={props.onNewFile}>
            ＋
          </button>
          <button class="side-btn" title="打开文件夹" onClick={props.onOpenWorkspace}>
            📂
          </button>
        </span>
      </div>
      {treeError && <div class="side-empty side-error">{treeError}</div>}
      {!tree && !treeError && <div class="side-empty">尚未打开文件夹</div>}
      {tree && (
        <div class="side-list tree-list">
          <TreeRows
            nodes={tree.children}
            depth={0}
            expanded={props.expanded}
            activeFilePath={props.activeFilePath}
            onToggleDir={props.onToggleDir}
            onOpenFile={props.onOpenFile}
            onEntryContextMenu={props.onEntryContextMenu}
          />
        </div>
      )}
    </div>
  );
}

/* ------------------------------ 搜索段 ------------------------------ */

function SearchSection(props: { root: string | null; onOpen(path: string, line: number): void }) {
  const { root, onOpen } = props;
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ path: string; line: number; text: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    if (!root || !query.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const { api } = await import("../lib/backend");
      const result = await api.searchWorkspace(root, query.trim(), 200);
      setHits(result.map((h) => ({ path: h.path, line: h.line, text: h.text })));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="side-section search-section">
      <div class="side-head">
        <span>搜索</span>
      </div>
      <div class="search-box">
        <input
          type="text"
          placeholder={root ? "搜索工作区…" : "先打开文件夹"}
          value={query}
          disabled={!root}
          onKeyDown={(e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.key === "Enter") void run();
          }}
          onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
        />
        <button class="side-btn" title="搜索 (Enter)" onClick={() => void run()}>
          {busy ? "…" : "搜"}
        </button>
      </div>
      {err && <div class="side-empty side-error">{err}</div>}
      {hits && (
        <div class="side-list search-list">
          {hits.length === 0 ? (
            <div class="side-empty">没有匹配结果</div>
          ) : (
            hits.map((h, i) => (
              <button
                key={`${h.path}:${h.line}:${i}`}
                class="search-hit"
                title={h.path + (h.line ? ` 第 ${h.line} 行` : "")}
                onClick={() => onOpen(h.path, h.line)}
              >
                <span class="hit-file">
                  {h.path.split("/").pop()}
                  {h.line > 0 ? ` :${h.line}` : ""}
                </span>
                <span class="hit-text">{h.text}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ 侧栏主体 ------------------------------ */

export function Sidebar(props: SidebarProps) {
  const {
    width,
    onWidthChange,
    outline,
    currentBlockIndex,
    onOutlineJump,
    tree,
    treeError,
    expanded,
    activeFilePath,
    onToggleDir,
    onOpenFile,
    onEntryContextMenu,
    onNewFile,
    onOpenWorkspace,
    workspaceRoot,
    onSearchOpen,
  } = props;

  const dragState = useRef<{ startX: number; startW: number } | null>(null);

  /** 宽度拖拽：指针捕获 + move 计算，210~420px 夹紧 */
  const onResizeDown = (e: PointerEvent) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startW: width };
    const move = (ev: PointerEvent) => {
      const st = dragState.current;
      if (!st) return;
      const w = Math.max(210, Math.min(420, st.startW + (ev.clientX - st.startX)));
      onWidthChange(w);
    };
    const up = () => {
      dragState.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside class="sidebar" style={{ width: `${width}px` }} data-testid="sidebar">
      <OutlineSection outline={outline} currentBlockIndex={currentBlockIndex} onJump={onOutlineJump} />
      <FilesSection
        tree={tree}
        treeError={treeError}
        expanded={expanded}
        activeFilePath={activeFilePath}
        onToggleDir={onToggleDir}
        onOpenFile={onOpenFile}
        onEntryContextMenu={onEntryContextMenu}
        onNewFile={onNewFile}
        onOpenWorkspace={onOpenWorkspace}
      />
      <SearchSection root={workspaceRoot} onOpen={onSearchOpen} />
      <div class="sidebar-resizer" onPointerDown={onResizeDown} title="拖拽调整宽度" />
    </aside>
  );
}
