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
import { claimScroll, isGestureActive, lastUserScrollAt, programmaticScroll } from "../lib/interaction";

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

/**
 * 大纲滚动契约（W8）
 * ---------------------------------------------------------------------------
 * W7 的大纲是「400 条窗口 + 滚到边缘平移窗口」的伪无限列表：为了让视野
 * "原地不动"必须不断抢写 scrollTop，而预览滚动又会触发「跟随」再去抢写
 * scrollTop —— 两个控件争同一个方向盘的 scrollTop，这就是用户报告的
 * 「大纲和预览滚轮冲突」。200ms / 1500ms 时间窗只是把死循环压住，没拆掉环。
 *
 * 现在换成真虚拟列表：
 *   - spacer 把 scrollHeight 撑到 `条数 × 固定行高`，scrollTop 完全归浏览器；
 *   - 只渲染可视区 ± overscan 行，绝对定位；
 *   - onScroll 只做一件事：更新可视区间。**不平移窗口、不写 scrollTop、
 *     不设暂停标记**。预览滚动只改高亮 class，绝不碰大纲的滚动位置。
 *   - 唯一的程序化写入是「换文档回顶 / 用户点定位 / 用户开启跟随」，
 *     且一律走 programmaticScroll 申报 reason，由仲裁器精确认领。
 *
 * 跟随信息改为头部一条位置刻度（纯视觉，零滚动副作用）；需要自动跟随的用户
 * 可点「跟随」，但只有大纲静止超过 FOLLOW_QUIET_MS 时才允许动它的 scrollTop。
 */

/** 固定行高：真虚拟列表的前提，文案超长用省略号，不允许换行撑高 */
const OUTLINE_ROW_H = 26;
/** 视口上下各多渲染几行，快速滚动时不会露白 */
const OUTLINE_OVERSCAN = 8;
/** 允许「自动跟随」前，大纲必须静止这么久（手势会话静默判定） */
const FOLLOW_QUIET_MS = 600;

/* ------------------------------ 大纲段 ------------------------------ */

function OutlineSection(props: {
  outline: OutlineRow[];
  currentBlockIndex: number;
  onJump(index: number): void;
}) {
  const { outline, currentBlockIndex, onJump } = props;
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);
  /** 自动跟随默认关：两个滚动容器各自拥有自己的滚动条，谁也不动谁 */
  const [follow, setFollow] = useState(false);
  const rafRef = useRef<number | null>(null);
  const hasList = outline.length > 0;

  // 当前章节 = 最后一个 index <= 当前块的标题。纯计算，不产生任何滚动副作用。
  const activeOutlineIdx = useMemo(() => {
    let lo = 0;
    let hi = outline.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (outline[mid]!.index <= currentBlockIndex) lo = mid + 1;
      else hi = mid - 1;
    }
    return hi;
  }, [outline, currentBlockIndex]);

  // 换文档：回顶（唯一允许的程序化写入之一，申报 reset）
  useEffect(() => {
    const el = listRef.current;
    if (el) programmaticScroll(el, 0, "reset");
    setScrollTop(0);
  }, [outline]);

  // 视口高度只影响渲染区间，不影响滚动位置
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setViewH(el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasList]);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  /** 显式定位到当前章节（用户点刻度 / 点按钮，属于用户主动跳转） */
  const locateActive = () => {
    const el = listRef.current;
    if (!el) return;
    programmaticScroll(
      el,
      Math.max(0, activeOutlineIdx * OUTLINE_ROW_H - el.clientHeight / 2 + OUTLINE_ROW_H / 2),
      "jump",
    );
    setScrollTop(el.scrollTop);
  };

  /**
   * 自动跟随（仅用户开启时）。三条门槛缺一不可：
   *   1. 大纲上没有活跃手势；2. 大纲已静止 600ms；3. 高亮项确实不在视野内。
   * 程序化滚动不会更新 lastUserScrollAt，所以跟随不会把自己锁死。
   */
  useEffect(() => {
    if (!follow) return;
    const el = listRef.current;
    if (!el || outline.length === 0) return;
    if (isGestureActive(el) || Date.now() - lastUserScrollAt(el) < FOLLOW_QUIET_MS) return;
    const top = Math.max(0, activeOutlineIdx) * OUTLINE_ROW_H;
    if (top >= el.scrollTop && top + OUTLINE_ROW_H <= el.scrollTop + el.clientHeight) return;
    programmaticScroll(el, top - el.clientHeight / 2 + OUTLINE_ROW_H / 2, "follow");
    setScrollTop(el.scrollTop);
  }, [follow, activeOutlineIdx, outline]);

  /** 滚动只更新可视区间：绝不平移窗口、绝不写 scrollTop */
  const onListScroll = (e: Event) => {
    const el = e.currentTarget as HTMLDivElement;
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (el.isConnected) setScrollTop(el.scrollTop);
    });
  };

  const start = Math.max(0, Math.floor(scrollTop / OUTLINE_ROW_H) - OUTLINE_OVERSCAN);
  const end = Math.min(
    outline.length,
    Math.ceil((scrollTop + (viewH || 320)) / OUTLINE_ROW_H) + OUTLINE_OVERSCAN,
  );
  const rows = outline.slice(start, end);
  const trackPct = outline.length > 1
    ? (Math.max(0, activeOutlineIdx) / (outline.length - 1)) * 100
    : 0;

  return (
    <div class="side-section outline-section">
      <div class="side-head">
        <span>大纲（{outline.length.toLocaleString()}）</span>
        <span class="side-head-btns">
          <button
            class={"side-btn" + (follow ? " on" : "")}
            onClick={() => setFollow((v) => !v)}
            title={follow ? "关闭自动跟随（大纲滚动完全由你控制）" : "开启：大纲自动跟随当前章节"}
            data-testid="outline-follow"
            aria-pressed={follow}
          >
            跟随
          </button>
          <button class="side-btn" onClick={locateActive} title="把大纲滚动到当前章节" data-testid="outline-locate">
            定位
          </button>
        </span>
      </div>
      {outline.length > 1 && (
        <div
          class="outline-progress"
          onClick={locateActive}
          title="当前章节在大纲中的位置（点击定位）"
          data-testid="outline-track"
        >
          <span style={{ left: `${trackPct}%` }} />
        </div>
      )}
      {!hasList ? (
        <div class="side-empty">本文档没有标题大纲</div>
      ) : (
        <div
          class="side-list outline-list mj-scroll"
          ref={listRef}
          data-scroll-kind="outline"
          tabIndex={0}
          onScroll={onListScroll}
          data-testid="outline-list"
        >
          <div class="outline-canvas" style={{ height: `${outline.length * OUTLINE_ROW_H}px` }}>
            {rows.map((row, i) => {
              const realIdx = start + i;
              const active = realIdx === activeOutlineIdx;
              return (
                <button
                  key={row.index}
                  class={"outline-item" + (active ? " active" : "")}
                  style={{
                    top: `${realIdx * OUTLINE_ROW_H}px`,
                    paddingLeft: `${10 + (row.level - 1) * 12}px`,
                  }}
                  title={`跳转到第 ${row.index + 1} 块`}
                  data-block-index={row.index}
                  onClick={() => onJump(row.index)}
                >
                  {row.text || "(无标题)"}
                </button>
              );
            })}
          </div>
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
  selectedPath: string | null;
  onSelect(path: string): void;
  onToggleDir(entry: FileEntry): void;
  onOpenFile(path: string): void;
  onEntryContextMenu(e: MouseEvent, entry: FileEntry): void;
}) {
  const { nodes, depth, expanded, activeFilePath, selectedPath, onSelect, onToggleDir, onOpenFile, onEntryContextMenu } = props;
  return (
    <>
      {nodes.map((n) => {
        const open = expanded.has(n.path);
        return (
          <div key={n.path}>
            <div
              class={
                "tree-row" +
                (n.is_dir ? " dir" : "") +
                (n.path === activeFilePath ? " active" : "") +
                (n.path === selectedPath ? " selected" : "")
              }
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              title={n.path}
              data-path={n.path}
              onClick={() => {
                // 单击先选中（旧版单击文件毫无反馈，用户以为点坏了）
                onSelect(n.path);
                if (n.is_dir) void onToggleDir(n);
              }}
              onDblClick={() => {
                if (!n.is_dir) onOpenFile(n.path);
              }}
              onContextMenu={(e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                onSelect(n.path);
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
                selectedPath={selectedPath}
                onSelect={onSelect}
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

/** 把树按「当前展开状态」拍平成可见行序列（键盘导航用） */
function flattenTree(
  nodes: FileEntry[],
  expanded: Set<string>,
  out: FileEntry[] = [],
): FileEntry[] {
  for (const n of nodes) {
    out.push(n);
    if (n.is_dir && expanded.has(n.path) && n.children) flattenTree(n.children, expanded, out);
  }
  return out;
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
  const { tree, treeError, expanded, activeFilePath } = props;
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(() => (tree ? flattenTree(tree.children, expanded) : []), [tree, expanded]);

  /** 键盘导航：↑↓ 选、→← 展开/收起、Enter 打开 */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (rows.length === 0) return;
    const idx = rows.findIndex((n) => n.path === selectedPath);
    const cur = idx >= 0 ? rows[idx]! : null;
    const move = (next: number): void => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, next))]!;
      setSelectedPath(target.path);
      // 滚动到可视区（nearest：不把整棵树拽到顶部）。
      // scrollIntoView 的落点由浏览器算，事后用 claimScroll 补申报，
      // 否则这次滚动会被判成「用户滚动」→ 误触发联动、误关右键菜单。
      const listEl = listRef.current;
      const before = listEl?.scrollTop ?? 0;
      const rowEl = listEl?.querySelector<HTMLElement>(`.tree-row[data-path="${CSS.escape(target.path)}"]`);
      rowEl?.scrollIntoView({ block: "nearest" });
      if (listEl) claimScroll(listEl, before, "jump");
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(idx < 0 ? 0 : idx + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(idx < 0 ? 0 : idx - 1);
        break;
      case "Home":
        e.preventDefault();
        move(0);
        break;
      case "End":
        e.preventDefault();
        move(rows.length - 1);
        break;
      case "ArrowRight":
        if (cur?.is_dir && !expanded.has(cur.path)) {
          e.preventDefault();
          void props.onToggleDir(cur);
        }
        break;
      case "ArrowLeft":
        if (cur?.is_dir && expanded.has(cur.path)) {
          e.preventDefault();
          void props.onToggleDir(cur);
        }
        break;
      case "Enter":
        if (cur) {
          e.preventDefault();
          if (cur.is_dir) void props.onToggleDir(cur);
          else props.onOpenFile(cur.path);
        }
        break;
      default:
        break;
    }
  };

  return (
    <div class="side-section files-section">
      <div class="side-head">
        <span class="side-head-title" title={tree?.root ?? ""}>
          {tree ? tree.name : "工作区"}
        </span>
        <span class="side-head-btns">
          <button class="side-btn" title="新建文件" aria-label="新建文件" onClick={props.onNewFile}>
            ＋
          </button>
          <button class="side-btn" title="打开文件夹" aria-label="打开文件夹" onClick={props.onOpenWorkspace}>
            📂
          </button>
        </span>
      </div>
      {treeError && <div class="side-empty side-error">{treeError}</div>}
      {!tree && !treeError && <div class="side-empty">尚未打开文件夹</div>}
      {tree && (
        <div
          class="side-list tree-list mj-scroll"
          data-scroll-kind="tree"
          ref={listRef}
          tabIndex={0}
          role="tree"
          aria-label="工作区文件"
          onKeyDown={onKeyDown}
          onBlur={(e: FocusEvent) => {
            // 焦点离开列表（点到别处）时收起选中态
            const next = e.relatedTarget as Node | null;
            if (next && (e.currentTarget as HTMLElement).contains(next)) return;
            setSelectedPath(null);
          }}
        >
          <TreeRows
            nodes={tree.children}
            depth={0}
            expanded={props.expanded}
            activeFilePath={activeFilePath}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
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
            // Esc 清空搜索词与结果（否则得手动删字再等）
            else if (e.key === "Escape") {
              setQuery("");
              setHits(null);
              setErr(null);
            }
          }}
          onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
        />
        <button class="side-btn" title="搜索 (Enter)" onClick={() => void run()}>
          {busy ? "…" : "搜"}
        </button>
      </div>
      {err && <div class="side-empty side-error">{err}</div>}
      {hits && (
        <div class="side-list search-list mj-scroll" data-scroll-kind="search" tabIndex={0} aria-label="搜索结果">
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

  /** 宽度拖拽：指针捕获式 window 监听，210~420px 夹紧；拖拽期间锁全局光标与文本选区 */
  const onResizeDown = (e: PointerEvent) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startW: width };
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      const st = dragState.current;
      if (!st) return;
      const w = Math.max(210, Math.min(420, st.startW + (ev.clientX - st.startX)));
      onWidthChange(w);
    };
    const up = () => {
      dragState.current = null;
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
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
      <div
        class="sidebar-resizer"
        onPointerDown={onResizeDown}
        onDblClick={() => onWidthChange(260)}
        title="拖拽调整宽度（双击恢复 260px）"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
      />
    </aside>
  );
}
