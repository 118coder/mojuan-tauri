/**
 * 墨卷 · 正式界面（W4b）
 * ---------------------------------------------------------------------------
 * 布局：TitleBar + TabStrip + 主体（Sidebar + 内容卡片）+ StatusBar
 *      + 全局右键菜单 + 命令面板 + 设置对话框 + 阅读区查找条 + 通用输入/确认对话框
 * 视图：阅读（VirtualReader）/ 分屏（EditorPane + VirtualReader）/ 编辑（EditorPane）
 *      Ctrl+E 循环切换；F8 极简（只留标签条 + 内容，Esc 退出）。
 *
 * 依赖的 W3 产物（只读）：renderer.ts / VirtualReader.tsx；
 * 依赖的 W2 产物（只读）：src-tauri 命令层（经 lib/backend.ts 门面）。
 * ContextMenu / FindBar 由 W4a 实现，二者均已正式合入（W8 已删除过时的
 * ContextMenuStub 占位文件）；受控模式的菜单项由本文件统一构建。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TitleBar } from "./components/TitleBar";
import { TabStrip } from "./components/TabStrip";
import { Sidebar } from "./components/Sidebar";
import type { OutlineRow } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { Palette } from "./components/Palette";
import type { PaletteCommand } from "./components/Palette";
import { SettingsDialog } from "./components/SettingsDialog";
// 右键菜单：ContextMenu 的受控模式（App 构建 items）+ 自主模式（链接/图片）双通道；
// FindBar 同为 W4a 正式组件（查找管线走渲染器 mark 注入）。
import { ContextMenu } from "./components/ContextMenu";
import type { CtxMenuItem, CtxMenuState } from "./components/ContextMenu";
import { FindBar } from "./components/FindBar";
import { VirtualReader } from "./components/VirtualReader";
import type { VirtualReaderHandle } from "./components/VirtualReader";
import { EditorPane } from "./components/EditorPane";
import { buildExportMenuItems, EXPORT_ITEMS, runExport } from "./components/ExportMenu";
import type { ExportMenuDeps } from "./components/ExportMenu";
import { useAppStore, useFileTree, useNavHistory, useWorkspace } from "./lib/workspace";
import type { NavEntry } from "./lib/workspace";
import { useGlobalShortcuts } from "./lib/shortcuts";
import { focusScroller, useWheelZoom } from "./lib/interaction";
import { Modal } from "./components/Modal";
import { api, isTauri, mockListPaths, normalizePath } from "./lib/backend";
import type { AppInfo, AppState, FileEntry } from "./lib/backend";
import { loadDemoDoc } from "./lib/demo-doc";
import type { ExportTabInfo } from "./lib/exporters";
import {
  applyCurrentHit,
  getBlockHitCounts,
  refreshMermaid,
  renderBlocks,
  setReaderFontSize,
  setRendererTheme,
} from "./lib/renderer";
import type { Block, ReaderTheme, ScrollProgress } from "./lib/renderer";
import "./styles/markdown.css";

/** 判断是否运行在 Tauri 窗口里（浏览器直接打开时为 false） */
const isTauriEnv = isTauri;

/* -------------------------------------------------------------------------- */
/* 模块级子组件：稳定引用，避免因 App 重渲染导致阅读器重建                        */
/* -------------------------------------------------------------------------- */

/** 按标签路径包一层的阅读器：滚动回调闭包捕获 path，切换标签时以 key 重建 */
function ReaderView(props: {
  path: string;
  blocks: Block[];
  jump: number | null;
  onProgress(path: string, p: ScrollProgress): void;
  apiRef: { current: VirtualReaderHandle | null };
  onLinkClick(href: string): void;
}) {
  const { path, blocks, jump, onProgress, apiRef, onLinkClick } = props;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cb = useMemo(() => (p: ScrollProgress) => onProgress(path, p), [path, onProgress]);
  return (
    <VirtualReader
      blocks={blocks}
      scrollTopByProp={jump}
      onScrollProgress={cb}
      apiRef={apiRef}
      emptyText="文档为空"
      onLinkClick={onLinkClick}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* 通用输入/确认对话框（原生 prompt 在 Tauri/无头浏览器里都不可靠，自绘）          */
/* -------------------------------------------------------------------------- */

interface PromptState {
  kind: "input" | "confirm";
  title: string;
  body?: string;
  placeholder?: string;
  initial?: string;
  okText?: string;
  onOk(value: string): void;
  /** W6a：显式取消路径（取消按钮/Esc/点遮罩）回调；「确定」不触发 */
  onCancel?: () => void;
}

function PromptDialog(props: { state: PromptState; onClose(): void }) {
  const { state, onClose } = props;
  const [value, setValue] = useState(state.initial ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (state.kind === "input") inputRef.current?.focus();
  }, []);

  const ok = () => {
    onClose();
    state.onOk(value.trim());
  };
  /** 取消/Esc/点遮罩：先通知取消方（导出确认 Promise 落 false），再关浮层 */
  const cancel = () => {
    state.onCancel?.();
    onClose();
  };

  return (
    <Modal
      open
      panelClass="prompt-dialog"
      maskClass="mask-center"
      label={state.title}
      initialFocus={state.kind === "input" ? ".prompt-input" : undefined}
      testId="prompt-dialog"
      onClose={cancel}
    >
      <div class="dlg-head">
        <span>{state.title}</span>
      </div>
      {state.body && <div class="prompt-body">{state.body}</div>}
      {state.kind === "input" && (
        <input
          ref={inputRef}
          class="prompt-input"
          type="text"
          placeholder={state.placeholder}
          value={value}
          onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.key === "Enter") ok();
          }}
        />
      )}
      <div class="dlg-actions right">
        <button class="ghost" onClick={cancel}>
          取消
        </button>
        <button class="ghost primary" onClick={ok}>
          {state.okText ?? "确定"}
        </button>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* App 主体                                                                    */
/* -------------------------------------------------------------------------- */

function App() {
  const store = useAppStore();
  const nav = useNavHistory();

  /* ------------------------------ 基础状态 ------------------------------ */

  const [sysDark, setSysDark] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)").matches : true,
  );
  const resolvedTheme: ReaderTheme = store.state.theme === "auto" ? (sysDark ? "dark" : "light") : store.state.theme;
  const themeRef = useRef<ReaderTheme>(resolvedTheme);
  themeRef.current = resolvedTheme;
  const themeGetter = useCallback(() => themeRef.current, []);

  const ws = useWorkspace(store, themeGetter);
  const fileTree = useFileTree();

  // ws/store/fileTree 每次渲染都是新对象，长生命周期的 effect 一律走 ref
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const storeRef = useRef(store);
  storeRef.current = store;
  const fileTreeRef = useRef(fileTree);
  fileTreeRef.current = fileTree;
  const navRef = useRef(nav);
  navRef.current = nav;

  const readerApiRef = useRef<VirtualReaderHandle | null>(null);
  /** 最近一次滚动进度（百分比跳转/导航用） */
  const progressRef = useRef<ScrollProgress | null>(null);
  /** 每个标签的最新 scrollTop（切标签恢复用） */
  const progressByPathRef = useRef<Map<string, number>>(new Map());
  /** 最近关闭的标签（Ctrl+Shift+T 重开） */
  const closedTabsRef = useRef<string[]>([]);
  /** 待恢复的滚动位置 {path, top}：首次 progress 上报时落地 */
  const pendingScrollRef = useRef<{ path: string; top: number } | null>(null);
  /**
   * 跳转命令计数：VirtualReader 的 scrollTopByProp 是值比较依赖，
   * 同一 px 不会重触发 effect；给命令加 <1px 的 epsilon 保证每次都生效。
   */
  const jumpNonceRef = useRef(0);
  const commandReaderJump = useCallback((top: number) => {
    jumpNonceRef.current += 1;
    setReaderJump(Math.max(0, top) + (jumpNonceRef.current % 5) * 0.001);
  }, []);
  /** 待定位的行（工作区搜索点击打开后） */
  const pendingLineRef = useRef<{ path: string; line: number } | null>(null);
  const editorRatioRef = useRef<number | undefined>(undefined);
  /** 编辑后的标签（分屏防抖重渲染用） */
  const editedPathRef = useRef<string | null>(null);
  const rerenderTimerRef = useRef<number | null>(null);

  const [percent, setPercent] = useState(0);
  const [currentBlockIndex, setCurrentBlockIndex] = useState(0);
  const [readerJump, setReaderJump] = useState<number | null>(null);
  const [editorRatio, setEditorRatio] = useState<number | undefined>(undefined);
  const [words, setWords] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findTick, setFindTick] = useState(0);
  /** 查找管线（W4a 契约）：带 <mark data-hit> 的块 / 每块命中数 / 总数 / 当前命中（0 基） */
  const [findBlocks, setFindBlocks] = useState<Block[] | null>(null);
  const [findCounts, setFindCounts] = useState<number[] | null>(null);
  const [findTotal, setFindTotal] = useState(0);
  const [findCurrent, setFindCurrent] = useState(0);
  const [findCase, setFindCase] = useState(false);
  /** 新渲染结果落地后待跳转的命中（effect 里消费） */
  const [findPendingHit, setFindPendingHit] = useState<number | null>(null);
  const findRerenderRef = useRef<number | null>(null);
  const findCountsRef = useRef<number[] | null>(null);
  findCountsRef.current = findCounts;
  const findTotalRef = useRef(0);
  findTotalRef.current = findTotal;
  const findCurrentRef = useRef(0);
  findCurrentRef.current = findCurrent;
  const findCaseRef = useRef(false);
  findCaseRef.current = findCase;
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /** 有文件被拖到窗口上方（显示投放提示，旧版拖拽全程零反馈） */
  const [dragOver, setDragOver] = useState(false);

  const mode = store.state.mode;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const minimal = store.state.minimal_open;
  /** 有浮层（面板/设置/对话框/菜单/查找条）打开时，全局 Esc 不做极简退出 */
  const modalOpenRef = useRef(false);
  modalOpenRef.current = settingsOpen || paletteOpen || !!prompt || !!ctxMenu || findOpen;
  /** closeFind 以后置定义（切换/关闭标签前清理查找状态用） */
  const closeFindRef = useRef<() => void>(() => {});
  const activeTab = ws.activeTab;
  const activePath = ws.activePath;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  /* ------------------------------ 小工具 ------------------------------ */

  const toast = useCallback((msg: string) => {
    setMessage(msg);
    window.setTimeout(() => {
      setMessage((cur) => (cur === msg ? null : cur));
    }, 2600);
  }, []);

  const copyText = useCallback(
    async (text: string) => {
      try {
        if (isTauriEnv) {
          // 主线已注册 clipboard-manager 插件；JS 包由 package.json 提供
          const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
          await writeText(text);
          toast("已复制");
          return;
        }
        await navigator.clipboard.writeText(text);
        toast("已复制");
      } catch {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand("copy");
          ta.remove();
          toast(ok ? "已复制" : "复制失败");
        } catch {
          toast("复制失败");
        }
      }
    },
    [toast],
  );

  /** 复制为 Markdown：选区覆盖的渲染块 → 按序拼接 Block.srcMd（W4a renderer 提供） */
  const copySelectionAsMarkdown = useCallback(() => {
    const sel = document.getSelection();
    const text = sel?.toString() ?? "";
    const scroller = readerApiRef.current?.getScroller();
    const blocks = wsRef.current.activeTab?.blocks;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !scroller || !blocks) {
      void copyText(text);
      return;
    }
    const idxOf = (node: Node | null): number | null => {
      if (!node) return null;
      const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      const b = el?.closest(".mj-block");
      if (!b || !scroller.contains(b)) return null;
      const raw = b.getAttribute("data-block-index");
      return raw == null ? null : Number(raw);
    };
    const a = idxOf(sel.anchorNode);
    const b = idxOf(sel.focusNode);
    if (a == null || b == null) {
      void copyText(text);
      return;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const parts: string[] = [];
    for (let i = lo; i <= hi; i++) {
      const s = blocks[i]?.srcMd;
      if (s) parts.push(s);
    }
    void copyText(parts.join("\n\n") || text);
  }, [copyText]);

  const parentOf = (p: string) => {
    const norm = normalizePath(p);
    const cut = norm.lastIndexOf("/");
    return cut > 0 ? norm.slice(0, cut) : norm;
  };

  /* ------------------------------ 主题应用 ------------------------------ */

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  // resolved 主题落地：html[data-theme] + localStorage 镜像（main.tsx 启动用）+ 渲染器主题
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    try {
      localStorage.setItem("mojuan-theme", resolvedTheme);
    } catch {
      /* 忽略 */
    }
    setRendererTheme(resolvedTheme);
    const scroller = readerApiRef.current?.getScroller();
    if (scroller) void refreshMermaid(scroller);
  }, [resolvedTheme]);

  // 排版变量：字号（W4a 的 setReaderFontSize 助手，12~32 钳取）/行距/页宽/侧栏宽
  useEffect(() => {
    const root = document.documentElement;
    const s = store.state;
    setReaderFontSize(s.font_size, root);
    root.style.setProperty("--reader-line-height", String(s.line_spacing));
    // measure 存 px（契约 420~1600）；CSS 里用 em（随字号缩放）
    const em = Math.min(80, Math.max(30, s.measure / Math.max(12, s.font_size)));
    root.style.setProperty("--reader-measure", `${em.toFixed(2)}em`);
    root.style.setProperty("--sidebar-w", `${s.sidebar_width}px`);
    // 编辑区字号跟随阅读字号（低 3px，等宽字体视觉上更大）：
    // Ctrl+滚轮/Ctrl+0 缩放对编辑区同样生效，不再是"编辑器里按了没反应"
    const editorSize = Math.max(11, Math.min(28, s.font_size - 3));
    root.style.setProperty("--editor-font-size", `${editorSize}px`);
  }, [store.state.font_size, store.state.line_spacing, store.state.measure, store.state.sidebar_width]);

  /** 改字号时保持页宽 px 不变（em 自动随动） */
  const setFontSize = useCallback(
    (next: number) => {
      const s = storeRef.current.stateRef.current;
      const f = Math.max(12, Math.min(32, Math.round(next)));
      if (f === s.font_size) return;
      storeRef.current.patch({ font_size: f });
    },
    [],
  );

  // Ctrl+滚轮缩放：全应用唯一的 wheel 入口（见 lib/interaction.ts）。
  // 旧实现在编辑器内直接 return，WebView 又不做整页缩放 → 编辑区按了没反应。
  useWheelZoom((delta) => setFontSize(storeRef.current.stateRef.current.font_size + delta));

  /* ------------------------------ 阅读进度 ------------------------------ */

  const onProgress = useCallback((path: string, p: ScrollProgress) => {
    progressRef.current = p;
    progressByPathRef.current.set(path, p.scrollTop);
    navRef.current.setCurTop(p.scrollTop);
    setCurrentBlockIndex((prev) => (prev === p.blockIndex ? prev : p.blockIndex));
    setPercent((prev) => (Math.abs(prev - p.percent) > 0.05 ? p.percent : prev));
    storeRef.current.noteScroll(path, p.scrollTop);

    // 待恢复的滚动位置：阅读器首次上报（scrollTop≈0）时落地
    const pend = pendingScrollRef.current;
    if (pend && pend.path === path) {
      const shouldApply = pend.top > 8 && p.scrollTop <= pend.top * 0.5;
      pendingScrollRef.current = null;
      if (shouldApply) commandReaderJump(pend.top);
    }

    // 分屏联动：只有「真实用户滚动阅读区」才回写编辑区比例。
    // 程序化滚动（大纲跳转 / 进度恢复 / 高度补偿 / 编辑区同步过来）一律不回写，
    // 用 origin 判因果，取代 W7 的 160ms 时间锁 —— 时间锁在连续滚轮下必漏。
    if (modeRef.current === "split" && p.origin === "user") {
      const r = p.percent / 100;
      editorRatioRef.current = r;
      setEditorRatio((prev) => (prev !== undefined && Math.abs(prev - r) < 0.0015 ? prev : r));
    }
  }, []);

  /** 百分比跳转（状态栏点击 / Ctrl+G / 搜索定位共用） */
  const jumpPercent = useCallback(
    (p: number) => {
      const prog = progressRef.current;
      if (!prog || prog.percent <= 0) {
        // 内容不满一屏或尚无进度；尝试按块数近似
        const blocks = wsRef.current.activeTab?.blocks;
        if (blocks && blocks.length > 1) {
          navRef.current.push({ path: wsRef.current.activePath ?? "", scrollTop: 0 });
          readerApiRef.current?.scrollToBlock(Math.floor((Math.max(0, Math.min(100, p)) / 100) * blocks.length), "start");
        }
        return;
      }
      const max = prog.scrollTop / (prog.percent / 100);
      navRef.current.push({ path: wsRef.current.activePath ?? "", scrollTop: prog.scrollTop });
      commandReaderJump((Math.max(0, Math.min(100, p)) / 100) * max);
    },
    [commandReaderJump],
  );

  /** 大纲跳块 */
  const jumpToBlock = useCallback(
    (index: number) => {
      const prog = progressRef.current;
      navRef.current.push({ path: wsRef.current.activePath ?? "", scrollTop: prog?.scrollTop ?? 0 });
      readerApiRef.current?.scrollToBlock(index, "start");
      // 跳完把焦点交回阅读区：随后 PageDown / 空格 / ↑↓ 立刻可用
      focusScroller(readerApiRef.current?.getScroller() ?? null);
    },
    [],
  );

  /**
   * 页内锚点跳转（正文里 `[文字](#章节标题)`）。
   *
   * 为什么不能靠浏览器原生行为：
   *   1) 渲染器不给标题生成 id，`getElementById` 永远拿不到；
   *   2) 阅读器是虚拟列表，未渲染的块根本不在 DOM 里。
   * 所以按 GitHub/Typora 的锚点规则把标题文本归一化后匹配 heading，
   * 拿到块号再 scrollToBlock —— 与大纲跳转走同一条路径。
   */
  const jumpAnchor = useCallback(
    (slug: string) => {
      const blocks = wsRef.current.activeTab?.blocks;
      if (!blocks || blocks.length === 0) return;
      const norm = (s: string): string =>
        s
          .trim()
          .toLowerCase()
          .replace(/[\s\u3000]+/g, "-")
          .replace(/[^\p{L}\p{N}\-_.]/gu, "");
      const want = norm(slug.replace(/^#/, ""));
      if (!want) return;
      const hit = blocks.find((b) => b.heading && norm(b.heading.text) === want);
      if (!hit) {
        toast(`找不到锚点「${slug}」`);
        return;
      }
      const prog = progressRef.current;
      navRef.current.push({ path: wsRef.current.activePath ?? "", scrollTop: prog?.scrollTop ?? 0 });
      readerApiRef.current?.scrollToBlock(hit.index, "start");
      focusScroller(readerApiRef.current?.getScroller() ?? null);
    },
    [toast],
  );

  /* ------------------------------ 打开文档 ------------------------------ */

  /**
   * 统一入口：打开并激活文档；负责进度恢复、导航栈、最近文件。
   * 注意：pendingScroll 必须在 openFile 之前设置——标签挂载时阅读器会先
   * 发一次 progress(0)，之后不会再有触发点；await 之后设置就永远赶不上。
   * （最近文件写入在 ws.openFile 内部完成；导航项由 setCurTop 持续同步。）
   */
  const openDocument = useCallback(
    (path: string, opts?: { line?: number }) => {
      const p = normalizePath(path);
      closeFindRef.current();
      const saved = storeRef.current.stateRef.current.scroll_top[p] ?? 0;
      const inMem = progressByPathRef.current.get(p);
      const restore = inMem !== undefined && inMem > 0 ? inMem : saved;
      pendingScrollRef.current = { path: p, top: restore };
      setReaderJump(null);
      navRef.current.push({ path: p, scrollTop: restore });
      void (async () => {
        await wsRef.current.openFile(p);
        if (opts?.line) pendingLineRef.current = { path: p, line: opts.line };
      })();
    },
    [],
  );

  /**
   * 正文链接点击总入口。
   * 放行默认行为 = WebView 整页导航，应用界面直接消失且没有后退键；
   * 所以一律拦截后分类处理：页内锚点 → block 定位，外链 → 系统浏览器，
   * 文档间相对链接 → 解析成绝对路径后直接打开。
   */
  const handleReaderLink = useCallback(
    (href: string) => {
      if (!href) return;
      if (href.startsWith("#")) {
        jumpAnchor(href.slice(1));
        return;
      }
      if (/^(https?:|mailto:)/i.test(href)) {
        void api.openUrl(href);
        return;
      }
      const cur = wsRef.current.activePath;
      if (cur && !cur.startsWith("demo://")) {
        const dir = cur.replace(/[\\/][^\\/]*$/, "").replace(/\\/g, "/");
        const parts = `${dir}/${href.replace(/\\/g, "/")}`.split("/");
        const stack: string[] = [];
        for (const seg of parts) {
          if (seg === "..") stack.pop();
          else if (seg !== "." && seg !== "") stack.push(seg);
        }
        openDocument((dir.startsWith("/") ? "/" : "") + stack.join("/"));
        return;
      }
      toast("无法打开这个链接");
    },
    [api, jumpAnchor, openDocument, toast],
  );

  /** 点标签切换（不进导航栈）；切换前把当前进度落库 */
  const activateTab = useCallback((path: string) => {
    if (path === wsRef.current.activePath) return;
    closeFindRef.current();
    const curPath = wsRef.current.activePath;
    if (curPath) {
      const top = progressByPathRef.current.get(curPath) ?? 0;
      storeRef.current.noteScroll(curPath, top);
      storeRef.current.flush();
    }
    wsRef.current.activate(path);
    const inMem = progressByPathRef.current.get(path);
    const restore = inMem !== undefined && inMem > 0 ? inMem : (storeRef.current.stateRef.current.scroll_top[path] ?? 0);
    pendingScrollRef.current = { path, top: restore };
    setReaderJump(null);
  }, []);

  const cycleTab = useCallback((dir: 1 | -1) => {
    const { tabs, activePath } = wsRef.current;
    if (tabs.length === 0) return;
    const idx = tabs.findIndex((t) => t.path === activePath);
    const next = tabs[(idx + dir + tabs.length) % tabs.length]!;
    activateTab(next.path);
  }, [activateTab]);

  const closeTabAndFlush = useCallback((path: string) => {
    storeRef.current.noteScroll(path, progressByPathRef.current.get(path) ?? 0);
    storeRef.current.flush();
    progressByPathRef.current.delete(path);
    closeFindRef.current();
    // 记住刚关的标签，给 Ctrl+Shift+T 用（最多 10 个）
    const tab = wsRef.current.tabs.find((t) => t.path === path);
    if (tab && !tab.virtual) {
      closedTabsRef.current.unshift(path);
      if (closedTabsRef.current.length > 10) closedTabsRef.current.length = 10;
    }
    wsRef.current.closeTab(path);
  }, []);

  /** Ctrl+Shift+T：重开最近关闭的标签（跳过已经不存在的文件由 openFile 自己报错） */
  const reopenClosedTab = useCallback(() => {
    const path = closedTabsRef.current.shift();
    if (!path) {
      toast("没有可重新打开的标签");
      return;
    }
    openDocument(path);
  }, [openDocument, toast]);

  /* ------------------------------ 命令（菜单/面板/快捷键共用） -------------- */

  const cmdSave = useCallback(async () => {
    const tab = wsRef.current.activeTab;
    if (!tab) return;
    if (tab.virtual) {
      toast("演示文档无需保存");
      return;
    }
    const ok = await wsRef.current.saveTab(tab.path);
    toast(ok ? "已保存" : "保存失败");
  }, [toast]);

  const cmdOpenFile = useCallback(() => {
    void (async () => {
      const picked = await api.openFileDialog();
      if (picked) {
        openDocument(picked);
        return;
      }
      if (api.kind === "tauri") return; // 用户取消
      // 浏览器预览：无系统对话框，输入路径兜底（mock 文件可开）
      const paths = mockListPaths();
      setPrompt({
        kind: "input",
        title: "打开文件（浏览器预览：输入路径）",
        placeholder: paths[0] ?? "D:/笔记/欢迎使用墨卷.md",
        initial: paths[0] ?? "",
        onOk: (v) => v.trim() && openDocument(v.trim()),
      });
    })();
  }, [openDocument]);

  const createAt = useCallback(
    (p: string) => {
      if (!p) return;
      void (async () => {
        try {
          await api.createFile(p, "");
          await fileTreeRef.current.refresh();
          openDocument(p);
          toast("已新建 " + p.split("/").pop());
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e));
        }
      })();
    },
    [openDocument, toast],
  );

  const cmdNewFile = useCallback(() => {
    void (async () => {
      const picked = await api.saveFileDialog("新建文件.md");
      if (picked) {
        createAt(picked);
        return;
      }
      if (api.kind === "tauri") return;
      const root = fileTreeRef.current.currentRoot ?? "D:/笔记";
      setPrompt({
        kind: "input",
        title: "新建文件（浏览器预览：输入路径）",
        initial: `${root}/新建文件.md`,
        onOk: createAt,
      });
    })();
  }, [createAt]);

  const applyWorkspace = useCallback(
    (p: string) => {
      void (async () => {
        await fileTreeRef.current.openRoot(p);
        storeRef.current.patch({ last_workspace: p });
        toast("已打开工作区：" + p);
      })();
    },
    [toast],
  );

  const cmdOpenWorkspace = useCallback(() => {
    void (async () => {
      const picked = await api.openDirDialog();
      if (picked) {
        applyWorkspace(picked);
        return;
      }
      if (api.kind === "tauri") return;
      setPrompt({
        kind: "input",
        title: "打开文件夹（浏览器预览：输入路径）",
        initial: "D:/笔记",
        onOk: (v) => v.trim() && applyWorkspace(v.trim()),
      });
    })();
  }, [applyWorkspace]);

  const cycleMode = useCallback(() => {
    const order: AppState["mode"][] = ["read", "split", "edit"];
    const cur = storeRef.current.stateRef.current.mode;
    const next = order[(order.indexOf(cur) + 1) % order.length]!;
    // 模式切换会让阅读器在树上的位置变化而重建；必须在状态更新「之前」
    // 记下当前阅读位置，否则阅读器挂载时的 progress(0) 会先把它清掉
    const p = wsRef.current.activePath;
    if (p) {
      const top = progressRef.current?.scrollTop ?? progressByPathRef.current.get(p) ?? 0;
      pendingScrollRef.current = { path: p, top };
      setReaderJump(null);
    }
    storeRef.current.patch({ mode: next });
    setFindOpen(false);
  }, []);

  const toggleMinimal = useCallback(() => {
    const next = !storeRef.current.stateRef.current.minimal_open;
    storeRef.current.patch({ minimal_open: next });
    if (next) storeRef.current.flush();
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!isTauriEnv) {
      toast("全屏需在 Tauri 窗口内使用（F11）");
      return;
    }
    void (async () => {
      try {
        const win = getCurrentWindow();
        const fs = await win.isFullscreen();
        await win.setFullscreen(!fs);
        setFullscreen(!fs);
      } catch {
        /* 忽略 */
      }
    })();
  }, [toast]);

  /* ------------------------------ 查找挂接（W4a FindBar + 渲染管线） ------------------------------ */

  /** 关闭查找：清高亮（回落到原始 blocks）并恢复查找前位置 */
  const closeFind = useCallback(() => {
    setFindOpen(false);
    const p = wsRef.current.activePath;
    if (p) {
      const top = progressRef.current?.scrollTop ?? 0;
      pendingScrollRef.current = { path: p, top };
      setReaderJump(null);
    }
    setFindBlocks(null);
    setFindCounts(null);
    setFindTotal(0);
    setFindCurrent(0);
    setFindPendingHit(null);
    if (findRerenderRef.current != null) {
      window.clearTimeout(findRerenderRef.current);
      findRerenderRef.current = null;
    }
    // 关闭查找后把焦点交回阅读区（否则键盘翻页要再点一下页面才生效）
    window.setTimeout(() => focusScroller(readerApiRef.current?.getScroller() ?? null), 0);
  }, []);

  // 挂到 ref：activateTab / closeTabAndFlush / openDocument 在更早的渲染段引用清理
  closeFindRef.current = closeFind;

  const openFind = useCallback((withSelection: boolean) => {
    if (modeRef.current !== "read") {
      // 编辑/分屏模式：CodeMirror 自带查找面板（Ctrl+F 已被其拦截）；阅读区才有 FindBar
      if (modeRef.current === "split") {
        toast("编辑区查找请 Ctrl+F 聚焦编辑器（CodeMirror 内置）");
      }
      return;
    }
    const sel = withSelection ? (document.getSelection()?.toString() ?? "").trim() : "";
    setFindQuery(sel.slice(0, 200));
    setFindBlocks(null);
    setFindCounts(null);
    setFindTotal(0);
    setFindCurrent(0);
    setFindPendingHit(null);
    setFindTick(0);
    setFindOpen(true);
  }, [toast]);

  /** 命中序号 → 块序号（counts 前缀和） */
  const blockOfHit = (counts: number[], hit: number): number => {
    let acc = 0;
    for (let i = 0; i < counts.length; i++) {
      acc += counts[i]!;
      if (hit < acc) return i;
    }
    return Math.max(0, counts.length - 1);
  };

  /** 滚动到命中所在块 + 切当前强色（挂载后补一次） */
  const revealHit = useCallback((hit: number, counts: number[]) => {
    const idx = blockOfHit(counts, hit);
    readerApiRef.current?.scrollToBlock(idx, "center");
    const scroller = readerApiRef.current?.getScroller();
    if (scroller) applyCurrentHit(scroller, hit);
    window.setTimeout(() => {
      const s = readerApiRef.current?.getScroller();
      if (s) applyCurrentHit(s, hit);
    }, 280);
  }, []);

  /** FindBar onQueryChange：防抖后用渲染管线注入 <mark data-hit> 高亮 */
  const onFindQueryChange = useCallback(
    (q: string) => {
      setFindQuery(q);
      if (findRerenderRef.current != null) window.clearTimeout(findRerenderRef.current);
      findRerenderRef.current = window.setTimeout(() => {
        findRerenderRef.current = null;
        const tab = wsRef.current.activeTab;
        if (!tab || !tab.blocks || tab.isPlain || !q.trim()) {
          // 纯文本/无词：不做渲染管线高亮（FindBar 走 DOM 兜底计数）
          setFindBlocks(null);
          setFindCounts(null);
          setFindTotal(0);
          return;
        }
        // blocks 引用变化会让阅读器回顶：先记位置，再跳首个命中
        const p = wsRef.current.activePath!;
        const top = progressRef.current?.scrollTop ?? 0;
        pendingScrollRef.current = { path: p, top };
        setReaderJump(null);
        const blocks = renderBlocks(tab.content, {
          theme: themeRef.current,
          query: q,
          caseSensitive: findCaseRef.current,
          currentHit: -1,
        });
        const counts = getBlockHitCounts(blocks);
        const total = counts.reduce((a, b) => a + b, 0);
        setFindBlocks(blocks);
        setFindCounts(counts);
        setFindTotal(total);
        setFindCurrent(0);
        if (total > 0) setFindPendingHit(0);
      }, 300);
    },
    [],
  );

  /** FindBar onJump（Enter/F3/Shift+F3）：翻当前命中，不重渲染（applyCurrentHit 廉价切换） */
  const onFindJump = useCallback(
    (dir: 1 | -1) => {
      const counts = findCountsRef.current;
      const total = findTotalRef.current;
      if (!counts || total <= 0) return;
      const next = (findCurrentRef.current + dir + total) % total;
      setFindCurrent(next);
      revealHit(next, counts);
    },
    [revealHit],
  );

  // 新的带高亮 blocks 落地后跳转到待命中的目标
  useEffect(() => {
    if (findBlocks == null || findPendingHit == null || !findCounts) return;
    const hit = findPendingHit;
    setFindPendingHit(null);
    revealHit(hit, findCounts);
  }, [findBlocks, findPendingHit, findCounts, revealHit]);

  /* ------------------------------ 编辑联动 ------------------------------ */

  const onEditorChange = useCallback((v: string) => {
    const path = wsRef.current.activePath;
    if (!path) return;
    wsRef.current.setTabContent(path, v);
    editedPathRef.current = path;
    if (rerenderTimerRef.current != null) window.clearTimeout(rerenderTimerRef.current);
    // 分屏：停手 600ms 后重解析阅读视图；超大文档不自动重解析（提示重新打开）
    rerenderTimerRef.current = window.setTimeout(() => {
      rerenderTimerRef.current = null;
      const cur = wsRef.current.activeTab;
      if (!cur || cur.path !== editedPathRef.current) return;
      if (cur.content.length > 4 * 1024 * 1024) {
        wsRef.current.setTabNotice(cur.path, "文档较大，编辑后阅读视图未自动刷新；重新打开文档即可刷新");
        return;
      }
      // 重解析会重建块模型（阅读器回顶），先记下当前位置以便恢复
      const top = progressByPathRef.current.get(cur.path) ?? 0;
      pendingScrollRef.current = { path: cur.path, top };
      setReaderJump(null);
      wsRef.current.rerenderTab(cur.path);
    }, 600);
  }, []);

  const onEditorScrollRatio = useCallback((r: number) => {
    // 编辑器 → 阅读区（按块号近似对齐）；刚由阅读区驱动的比例吞掉
    if (editorRatioRef.current !== undefined && Math.abs(r - editorRatioRef.current) < 0.004) return;
    const blocks = wsRef.current.activeTab?.blocks;
    if (!blocks || blocks.length === 0) return;
    const idx = Math.max(0, Math.min(blocks.length - 1, Math.floor(r * blocks.length)));
    // 不再设时间锁：scrollToBlock 走 programmaticScroll(..., "jump")，
    // 阅读器上报的 origin 就是 jump，onProgress 自然不会回写编辑器。
    readerApiRef.current?.scrollToBlock(idx, "start");
  }, []);

  /* ------------------------------ 全局 effects ------------------------------ */

  // 应用信息（设置对话框展示）
  useEffect(() => {
    void api.appInfo().then(setAppInfo);
  }, []);

  // 文件树：启动时恢复上次工作区
  useEffect(() => {
    if (!store.ready) return;
    const s = storeRef.current.stateRef.current;
    if (s.last_workspace && !fileTreeRef.current.tree) {
      void fileTreeRef.current.openRoot(s.last_workspace);
    }
    // 会话恢复：上次打开的文档
    if (s.last_file && !s.last_file.startsWith("demo://")) {
      openDocument(s.last_file);
    }
    // 仅启动时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.ready]);

  // 自动保存：3s 间隔检查脏标签
  useEffect(() => {
    const t = window.setInterval(() => {
      const s = storeRef.current.stateRef.current;
      if (!s.autosave) return;
      const tab = wsRef.current.activeTab;
      if (tab && tab.dirty && !tab.virtual) void wsRef.current.saveTab(tab.path);
    }, 3000);
    return () => window.clearInterval(t);
  }, []);

  // 工作区搜索点击 → 打开后定位行
  useEffect(() => {
    const tab = wsRef.current.activeTab;
    const pend = pendingLineRef.current;
    if (!tab || tab.loading || !pend || pend.path !== tab.path) return;
    pendingLineRef.current = null;
    const ratio = Math.max(0, Math.min(1, (pend.line - 1) / Math.max(1, tab.lineCount)));
    if (modeRef.current === "read") jumpPercent(ratio * 100);
    else {
      editorRatioRef.current = ratio;
      setEditorRatio(ratio);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.loading, activeTab?.path]);

  // 拖拽打开（Tauri onDragDrop）
  useEffect(() => {
    if (!isTauriEnv) return;
    let un: (() => void) | null = null;
    void (async () => {
      try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const u = await getCurrentWebview().onDragDropEvent((ev) => {
          const kind = ev.payload.type;
          if (kind === "enter" || kind === "over") {
            setDragOver(true);
            return;
          }
          if (kind === "leave") {
            setDragOver(false);
            return;
          }
          if (kind === "drop") {
            setDragOver(false);
            const all = ev.payload.paths;
            const paths = all.filter((p) => /\.(md|markdown|txt)$/i.test(p));
            if (paths.length === 0) {
              toast("只支持拖入 .md / .markdown / .txt 文件");
              return;
            }
            for (const p of paths) openDocument(p);
            toast(paths.length > 1 ? `已打开 ${paths.length} 个文件` : `已打开 ${paths[0]!.split(/[\\/]/).pop()}`);
          }
        });
        un = u;
      } catch {
        /* 忽略 */
      }
    })();
    return () => un?.();
  }, [openDocument, toast]);

  // 外部修改监听（Tauri）
  useEffect(() => {
    if (!isTauriEnv) return;
    let un: (() => void) | null = null;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const u = await listen<{ path: string }>("doc-changed", (e) => {
          const p = normalizePath(e.payload.path);
          const tab = wsRef.current.tabs.find((t) => t.path === p);
          if (!tab || tab.virtual) return;
          if (tab.dirty) {
            wsRef.current.setTabNotice(p, "文件已被外部修改；保存将覆盖外部更改");
          } else {
            void wsRef.current.reloadTab(p);
          }
        });
        un = u;
      } catch {
        /* 忽略 */
      }
    })();
    return () => un?.();
  }, []);

  // 全屏状态同步（窗口尺寸变化时校准）
  useEffect(() => {
    if (!isTauriEnv) return;
    const win = getCurrentWindow();
    const p = win.onResized(async () => {
      try {
        setFullscreen(await win.isFullscreen());
      } catch {
        /* 忽略 */
      }
    });
    return () => void p.then((f) => f());
  }, []);

  // 关窗前拦一道：有未保存修改就问（自动保存关掉时这是唯一防线）
  useEffect(() => {
    if (!isTauriEnv) return;
    let un: (() => void) | null = null;
    void (async () => {
      try {
        const win = getCurrentWindow();
        const u = await win.onCloseRequested((event) => {
          const dirty = wsRef.current.tabs.filter((t) => t.dirty && !t.virtual);
          if (dirty.length === 0) return; // 没有脏标签：放行，走正常关闭
          event.preventDefault();
          const names = dirty
            .slice(0, 3)
            .map((t) => t.name)
            .join("、");
          setPrompt({
            kind: "confirm",
            title: "有未保存的修改",
            body:
              dirty.length > 3
                ? `${names} 等 ${dirty.length} 个文件还没保存，退出前保存吗？`
                : `${names} 还没保存，退出前保存吗？`,
            okText: "保存并退出",
            onOk: () => {
              void (async () => {
                for (const t of dirty) {
                  try {
                    await wsRef.current.saveTab(t.path);
                  } catch {
                    /* 单个失败不阻断退出流程 */
                  }
                }
                try {
                  await win.destroy();
                } catch {
                  /* 忽略 */
                }
              })();
            },
          });
        });
        un = u;
      } catch {
        /* 浏览器预览/权限不足：忽略 */
      }
    })();
    return () => un?.();
  }, []);

  // WebView2 自带的右键菜单（刷新/检查/另存为…）会和自绘菜单打架：
  // 除输入类元素（需要系统的粘贴/拼写菜单）外一律屏蔽
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest("input, textarea, .cm-content")) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, []);

  // 字数统计（防抖）
  const content = activeTab?.content ?? "";
  useEffect(() => {
    const t = window.setTimeout(() => {
      const cjk = (content.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
      const latin = (content.match(/[A-Za-z0-9_'’-]+/g) ?? []).length;
      setWords(cjk + latin);
    }, 400);
    return () => window.clearTimeout(t);
  }, [content]);

  /* ------------------------------ 导航历史 ------------------------------ */

  const navGo = useCallback(
    (dir: -1 | 1) => {
      const cur: NavEntry = { path: wsRef.current.activePath ?? "", scrollTop: progressRef.current?.scrollTop ?? 0 };
      const target = dir < 0 ? navRef.current.back(cur) : navRef.current.forward(cur);
      if (!target || !target.path) return;
      const isCurrent = target.path === wsRef.current.activePath;
      if (!isCurrent) {
        if (!wsRef.current.tabs.some((t) => t.path === target.path)) {
          void wsRef.current.openFile(target.path);
        } else {
          wsRef.current.activate(target.path);
        }
        pendingScrollRef.current = { path: target.path, top: target.scrollTop };
        setReaderJump(null);
      } else {
        // 同文档内返回/前进：阅读器未重建，直接命令滚动
        commandReaderJump(target.scrollTop);
      }
    },
    [commandReaderJump],
  );

  /* ------------------------------ 文件操作（侧栏） ------------------------------ */

  const doNewFile = useCallback(() => cmdNewFile(), [cmdNewFile]);

  const doRename = useCallback(
    (entry: FileEntry) => {
      setPrompt({
        kind: "input",
        title: `重命名：${entry.name}`,
        initial: entry.name,
        onOk: (v) => {
          if (!v || v === entry.name) return;
          const to = parentOf(entry.path) + "/" + v;
          void (async () => {
            try {
              await api.renameEntry(entry.path, to);
              await fileTreeRef.current.refresh();
              const tab = wsRef.current.tabs.find((t) => t.path === entry.path);
              if (tab) {
                closeTabAndFlush(entry.path);
                openDocument(to);
              }
              toast("已重命名");
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e));
            }
          })();
        },
      });
    },
    [closeTabAndFlush, openDocument, toast],
  );

  const doDelete = useCallback(
    (entry: FileEntry) => {
      setPrompt({
        kind: "confirm",
        title: "删除确认",
        body: `确定要删除「${entry.name}」吗？${entry.is_dir ? "文件夹内的所有文件也会一并删除。" : ""}（进入回收站）`,
        okText: "删除",
        onOk: () => {
          void (async () => {
            try {
              await api.deleteEntry(entry.path);
              await fileTreeRef.current.refresh();
              for (const t of wsRef.current.tabs) {
                if (t.path === entry.path || t.path.startsWith(entry.path + "/")) closeTabAndFlush(t.path);
              }
              toast("已删除 " + entry.name);
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e));
            }
          })();
        },
      });
    },
    [closeTabAndFlush, toast],
  );

  /* ------------------------------ 导出（W6a） ------------------------------ */

  /** 当前标签 → 导出源信息（无可导出文档返回 null） */
  const getExportTab = useCallback((): ExportTabInfo | null => {
    const tab = wsRef.current.activeTab;
    if (!tab || tab.loading || tab.error) return null;
    return {
      // 虚拟文档（demo://）没有磁盘路径：HTML/PNG/PDF 可导，docx 由导出方报错提示
      path: tab.virtual ? null : tab.path,
      name: tab.name,
      title: tab.name.replace(/\.(md|markdown|txt)$/i, ""),
      content: tab.content,
      blocks: tab.blocks,
      isPlain: tab.isPlain,
      theme: themeRef.current,
    };
  }, []);

  /** 导出宿主能力：toast / 确认框（自绘对话框）/ 进度提示 / docx 前置保存 */
  const exportDeps = useMemo<ExportMenuDeps>(
    () => ({
      toast,
      confirm: (title: string, body: string) =>
        new Promise<boolean>((resolve) => {
          let settled = false;
          const settle = (v: boolean) => {
            if (settled) return;
            settled = true;
            resolve(v);
          };
          setPrompt({
            kind: "confirm",
            title,
            body,
            okText: "继续导出",
            onOk: () => settle(true),
            onCancel: () => settle(false),
          });
        }),
      progress: (msg) => {
        if (msg) toast(msg);
      },
      saveDoc: () => cmdSave(),
    }),
    [cmdSave, toast],
  );
  /* ------------------------------ 右键菜单 ------------------------------ */

  const readerMenu = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      const anchorEl = (e.target as Element | null)?.closest?.("a[href]") ?? null;
      const linkHref = anchorEl?.getAttribute("href") ?? "";
      const sel = document.getSelection();
      const text = sel?.toString() ?? "";
      const items: CtxMenuItem[] = [];
      // 链接上右键：先给「打开」（外链走系统浏览器、锚点走块定位）
      if (linkHref) {
        items.push({
          label: linkHref.startsWith("#") ? "跳转到该章节" : "打开链接",
          action: () => handleReaderLink(linkHref),
        });
        items.push({ label: "复制链接地址", action: () => void copyText(linkHref) });
        items.push({ separator: true });
      }
      if (text) {
        items.push({ label: "复制", shortcut: "Ctrl+C", action: () => void copyText(text) });
        // P0 #10：从渲染视图拿回 Markdown 源码（选区覆盖块 → Block.srcMd 拼接）
        items.push({ label: "复制为 Markdown", shortcut: "Ctrl+Shift+C", action: () => copySelectionAsMarkdown() });
        items.push({ separator: true });
        items.push({ label: "搜索所选文字", shortcut: "Ctrl+F", action: () => openFind(true) });
      } else {
        items.push({ label: "查找", shortcut: "Ctrl+F", action: () => openFind(false) });
      }
      items.push({
        label: "全选",
        shortcut: "Ctrl+A",
        action: () => {
          const scroller = readerApiRef.current?.getScroller();
          if (!scroller) return;
          const sel2 = document.getSelection();
          const range = document.createRange();
          range.selectNodeContents(scroller);
          sel2?.removeAllRanges();
          sel2?.addRange(range);
        },
      });
      if (isTauriEnv && activePathRef.current && !activePathRef.current.startsWith("demo://")) {
        items.push({ label: "打开所在文件夹", action: () => void api.revealInExplorer(activePathRef.current!) });
      }
      items.push({ separator: true });
      items.push({
        label: "重新加载文档",
        action: () => {
          const p = activePathRef.current;
          if (p && !p.startsWith("demo://")) void wsRef.current.reloadTab(p);
        },
      });
      // W6a：导出分组（HTML / Word / PDF / 长图 PNG）
      items.push({ separator: true });
      items.push(...buildExportMenuItems(getExportTab, exportDeps));
      setCtxMenu({ x: e.clientX, y: e.clientY, items });
    },
    [copyText, exportDeps, handleReaderLink, openFind],
  );

  const tabMenu = useCallback(
    (e: MouseEvent, path: string) => {
      const tabs = wsRef.current.tabs;
      const idx = tabs.findIndex((t) => t.path === path);
      const items: CtxMenuItem[] = [
        { label: "关闭", shortcut: "Ctrl+W", action: () => closeTabAndFlush(path) },
        {
          label: "关闭其他",
          disabled: tabs.length <= 1,
          action: () => wsRef.current.closeOthers(path),
        },
        {
          label: "关闭右侧",
          disabled: idx < 0 || idx >= tabs.length - 1,
          action: () => wsRef.current.closeRight(path),
        },
        { separator: true },
        { label: "复制文件路径", action: () => void copyText(path) },
      ];
      setCtxMenu({ x: e.clientX, y: e.clientY, items });
    },
    [closeTabAndFlush, copyText],
  );

  const treeEntryMenu = useCallback(
    (e: MouseEvent, entry: FileEntry) => {
      const items: CtxMenuItem[] = [
        { label: "打开", disabled: entry.is_dir, action: () => openDocument(entry.path) },
        { separator: true },
        { label: "新建文件", action: () => doNewFile() },
        { label: "重命名", shortcut: "F2", action: () => doRename(entry) },
        { label: "删除", shortcut: "Del", danger: true, action: () => doDelete(entry) },
        { separator: true },
        { label: "打开所在文件夹", action: () => void api.revealInExplorer(entry.path) },
      ];
      setCtxMenu({ x: e.clientX, y: e.clientY, items });
    },
    [doDelete, doNewFile, doRename, openDocument],
  );

  /* ------------------------------ 跳转到…（Ctrl+G） ------------------------------ */

  const openGoto = useCallback(() => {
    setPrompt({
      kind: "input",
      title: "跳转到…",
      placeholder: "35% 百分比 · #123 块号 · 120 行号",
      onOk: (v) => {
        const t = v.trim();
        if (!t) return;
        if (t.endsWith("%")) {
          jumpPercent(Number(t.slice(0, -1)));
        } else if (t.startsWith("#")) {
          jumpToBlock(Number(t.slice(1)) - 1);
        } else {
          const line = Number(t);
          if (!Number.isFinite(line)) return;
          const tab = wsRef.current.activeTab;
          if (!tab) return;
          const ratio = Math.max(0, Math.min(1, (line - 1) / Math.max(1, tab.lineCount)));
          if (modeRef.current === "read") jumpPercent(ratio * 100);
          else {
            editorRatioRef.current = ratio;
            setEditorRatio(ratio);
          }
        }
      },
    });
  }, [jumpPercent, jumpToBlock]);

  /* ------------------------------ 快捷键分发 ------------------------------ */

  useGlobalShortcuts({
    onOpenFile: cmdOpenFile,
    onNewFile: cmdNewFile,
    onSave: () => void cmdSave(),
    onCloseTab: () => {
      const p = wsRef.current.activePath;
      if (p) closeTabAndFlush(p);
    },
    onReopenTab: reopenClosedTab,
    onCycleTab: cycleTab,
    onCycleMode: cycleMode,
    onToggleMinimal: toggleMinimal,
    onToggleFullscreen: toggleFullscreen,
    onGoto: openGoto,
    onPalette: () => setPaletteOpen(true),
    onFind: () => openFind(true),
    onFindNav: (dir) => {
      if (findOpen) setFindTick((t) => (dir > 0 ? t + 1 : t - 1));
    },
    onZoom: (d) => setFontSize(storeRef.current.stateRef.current.font_size + d),
    onZoomReset: () => setFontSize(17),
    onNavBack: () => navGo(-1),
    onNavForward: () => navGo(1),
    onOpenSettings: () => setSettingsOpen(true),
    onToggleSidebar: () => storeRef.current.patch({ sidebar_open: !storeRef.current.stateRef.current.sidebar_open }),
    onEscape: () => {
      if (modalOpenRef.current) return;
      if (storeRef.current.stateRef.current.minimal_open) toggleMinimal();
    },
  });

  /* ------------------------------ 命令面板清单 ------------------------------ */

  const paletteCommands = useMemo<PaletteCommand[]>(
    () => [
      { id: "open", title: "打开文件…", shortcut: "Ctrl+O", run: cmdOpenFile },
      { id: "open-ws", title: "打开文件夹…", run: cmdOpenWorkspace },
      { id: "new", title: "新建文件…", shortcut: "Ctrl+N", run: cmdNewFile },
      { id: "save", title: "保存当前文档", shortcut: "Ctrl+S", run: () => void cmdSave() },
      // W6a：导出四件套（定义与右键菜单共用 EXPORT_ITEMS，改文案一处生效）
      { id: "export-html", title: EXPORT_ITEMS[0]!.paletteTitle, run: () => void runExport("html", getExportTab, exportDeps) },
      { id: "export-docx", title: EXPORT_ITEMS[1]!.paletteTitle, run: () => void runExport("docx", getExportTab, exportDeps) },
      { id: "export-pdf", title: EXPORT_ITEMS[2]!.paletteTitle, run: () => void runExport("pdf", getExportTab, exportDeps) },
      { id: "export-png", title: EXPORT_ITEMS[3]!.paletteTitle, run: () => void runExport("png", getExportTab, exportDeps) },
      { id: "mode", title: "切换 阅读/分屏/编辑 模式", shortcut: "Ctrl+E", run: cycleMode },
      { id: "minimal", title: "切换极简模式", shortcut: "F8", run: toggleMinimal },
      { id: "fullscreen", title: "切换全屏", shortcut: "F11", run: toggleFullscreen },
      { id: "sidebar", title: "显示/隐藏侧栏", shortcut: "Ctrl+\\", run: () =>
          storeRef.current.patch({ sidebar_open: !storeRef.current.stateRef.current.sidebar_open }) },
      { id: "settings", title: "打开设置", shortcut: "Ctrl+,", run: () => setSettingsOpen(true) },
      { id: "theme", title: "主题：亮色", run: () => storeRef.current.patch({ theme: "light" }) },
      { id: "theme-dark", title: "主题：暗色", run: () => storeRef.current.patch({ theme: "dark" }) },
      { id: "goto", title: "跳转到…", shortcut: "Ctrl+G", run: openGoto },
      { id: "find", title: "查找（阅读区）", shortcut: "Ctrl+F", run: () => openFind(false) },
      { id: "demo", title: "加载演示文档", run: () => {
          void (async () => {
            toast("正在生成演示文档…");
            const d = await loadDemoDoc();
            wsRef.current.openVirtual("演示文档", d.text);
            toast(`演示文档已加载：${d.chars.toLocaleString()} 字`);
          })();
        } },
      { id: "reload", title: "重新加载当前文档", run: () => {
          const p = wsRef.current.activePath;
          if (p && !p.startsWith("demo://")) void wsRef.current.reloadTab(p);
        } },
    ],
    [cmdNewFile, cmdOpenFile, cmdOpenWorkspace, cmdSave, cycleMode, exportDeps, getExportTab, openFind, openGoto, toggleFullscreen, toggleMinimal, toast],
  );

  /* ------------------------------ 渲染 ------------------------------ */

  const outline: OutlineRow[] = useMemo(() => {
    const blocks = activeTab?.blocks;
    if (!blocks) return [];
    const rows: OutlineRow[] = [];
    for (const b of blocks) {
      if (b.heading) rows.push({ index: b.index, level: b.heading.level, text: b.heading.text });
    }
    return rows;
  }, [activeTab?.blocks]);

  const recents = store.state.recent;

  const welcome = (
    <div class="welcome" data-testid="welcome">
      <div class="welcome-logo">墨卷</div>
      <div class="welcome-sub">本地 Markdown 阅读器 · 浏览器预览模式下使用内置演示文件</div>
      <div class="welcome-actions">
        <button class="welcome-btn" onClick={cmdOpenFile}>
          打开文件 <span class="kbd">Ctrl+O</span>
        </button>
        <button class="welcome-btn" onClick={cmdNewFile}>
          新建文件 <span class="kbd">Ctrl+N</span>
        </button>
        <button class="welcome-btn" onClick={() => setPaletteOpen(true)}>
          快速切换 <span class="kbd">Ctrl+P</span>
        </button>
        <button
          class="welcome-btn"
          onClick={() => {
            void (async () => {
              toast("正在生成演示文档…");
              const d = await loadDemoDoc();
              wsRef.current.openVirtual("演示文档", d.text);
              toast(`演示文档已加载：${d.chars.toLocaleString()} 字`);
            })();
          }}
        >
          加载演示文档
        </button>
      </div>
      {recents.length > 0 && (
        <div class="welcome-recent">
          <div class="welcome-recent-head">最近打开</div>
          {recents.slice(0, 8).map((r) => (
            <button key={r.path} class="recent-item" onClick={() => openDocument(r.path)} title={r.path}>
              <span class="recent-name">{r.path.split("/").pop()}</span>
              <span class="recent-path">{r.path}</span>
            </button>
          ))}
        </div>
      )}
      <div class="welcome-tips">
        Ctrl+E 切换阅读/分屏/编辑 · F8 极简模式 · Ctrl+滚轮 缩放 · F11 全屏 · Ctrl+G 跳转
      </div>
    </div>
  );

  const blocks = activeTab?.blocks ?? null;
  /** 阅读器实际显示的块：查找管线激活时用带 <mark data-hit> 的版本 */
  const readerBlocks = findBlocks ?? blocks;
  const loading = activeTab?.loading ?? false;
  const loadError = activeTab?.error ?? null;

  const reader =
    readerBlocks != null ? (
      <ReaderView
        key={activePath ?? "none"}
        path={activePath ?? ""}
        blocks={readerBlocks}
        jump={readerJump}
        onProgress={onProgress}
        apiRef={readerApiRef}
        onLinkClick={handleReaderLink}
      />
    ) : null;

  const editor = activeTab ? (
    <EditorPane
      key={activeTab.path}
      value={activeTab.content}
      onChange={onEditorChange}
      theme={resolvedTheme}
      onScrollRatio={onEditorScrollRatio}
      scrollToRatio={editorRatio}
      onSave={() => void cmdSave()}
    />
  ) : null;

  let contentArea: ComponentChildren;
  if (!activeTab || !activePath) {
    contentArea = welcome;
  } else if (loading) {
    contentArea = (
      <div class="reader-loading">
        <div class="spinner" />
        <div>正在加载文档…</div>
      </div>
    );
  } else if (loadError) {
    contentArea = <div class="reader-error">加载失败：{loadError}</div>;
  } else if (mode === "read") {
    contentArea = (
      <div class="reader-wrap" onContextMenu={readerMenu}>
        {reader}
      </div>
    );
  } else if (mode === "edit") {
    contentArea = editor;
  } else {
    contentArea = (
      <div class="split-view">
        <div class="split-editor" style={{ width: `${store.state.split_ratio * 100}%` }}>
          {editor}
        </div>
        <div class="split-reader reader-wrap" onContextMenu={readerMenu}>
          {reader}
        </div>
      </div>
    );
  }

  return (
    <div class={"app-frame" + (fullscreen ? " fullscreen" : "") + (minimal ? " minimal" : "")} data-mode={mode}>
      {!minimal && <TitleBar title={`${activeTab?.name ?? "欢迎使用"} — 墨卷`} />}

      <TabStrip
        tabs={ws.tabs}
        activePath={activePath}
        minimal={minimal}
        onActivate={activateTab}
        onClose={closeTabAndFlush}
        onTabContextMenu={tabMenu}
        onOpenSettings={() => setSettingsOpen(true)}
        onExitMinimal={toggleMinimal}
      />

      <div class="app-body">
        {store.state.sidebar_open && !minimal && (
          <Sidebar
            width={store.state.sidebar_width}
            onWidthChange={(w) => store.patch({ sidebar_width: w })}
            outline={outline}
            currentBlockIndex={currentBlockIndex}
            onOutlineJump={jumpToBlock}
            tree={fileTree.tree}
            treeError={fileTree.treeError}
            expanded={fileTree.expanded}
            activeFilePath={activePath}
            onToggleDir={(e) => void fileTree.toggleDir(e)}
            onOpenFile={openDocument}
            onEntryContextMenu={treeEntryMenu}
            onNewFile={doNewFile}
            onOpenWorkspace={cmdOpenWorkspace}
            workspaceRoot={fileTree.currentRoot}
            onSearchOpen={(path, line) => openDocument(path, { line })}
          />
        )}

        <main class="content-card">
          {contentArea}
          {activeTab?.notice && <div class="tab-notice">{activeTab.notice}</div>}
          {mode === "read" && activeTab && (
            <FindBar
              open={findOpen}
              initialQuery={findQuery}
              navTick={findTick}
              caseSensitive={findCase}
              blocks={findBlocks}
              hitTotal={findTotal}
              hitCurrent={findTotal > 0 ? findCurrent + 1 : undefined}
              onQueryChange={onFindQueryChange}
              onJump={onFindJump}
              onCaseSensitiveChange={setFindCase}
              onClose={closeFind}
              getScroller={() => readerApiRef.current?.getScroller() ?? null}
            />
          )}
        </main>
      </div>

      {store.state.show_status && !minimal && (
        <StatusBar
          words={words}
          chars={content.length}
          percent={percent}
          onPercentJump={jumpPercent}
          mode={mode}
          dirty={!!activeTab?.dirty}
          big={!!activeTab?.big}
          message={message}
        />
      )}
      {store.state.show_status && minimal && message && (
        <div class="toast-float">{message}</div>
      )}
      {!store.state.show_status && message && <div class="toast-float">{message}</div>}

      <Palette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        root={fileTree.currentRoot}
        commands={paletteCommands}
        onOpenFile={openDocument}
      />

      <SettingsDialog
        open={settingsOpen}
        settings={store.state}
        onPatch={(p) => store.patch(p)}
        onClose={() => {
          setSettingsOpen(false);
          store.flush();
        }}
        onLoadDemo={() => {
          void (async () => {
            setSettingsOpen(false);
            toast("正在生成演示文档…");
            const d = await loadDemoDoc();
            wsRef.current.openVirtual("演示文档", d.text);
            toast(`演示文档已加载：${d.chars.toLocaleString()} 字`);
          })();
        }}
        appInfo={appInfo}
        onOpenWorkspace={cmdOpenWorkspace}
      />

      {dragOver && (
        <div class="drop-hint" aria-hidden="true">
          <div class="drop-hint-box">松开以打开 Markdown / 文本文件</div>
        </div>
      )}

      {prompt && <PromptDialog state={prompt} onClose={() => setPrompt(null)} />}

      <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} onJumpAnchor={jumpAnchor} />
    </div>
  );
}

export default App;
