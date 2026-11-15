/**
 * 墨卷 W3 演示页：顶栏（44px）+ 侧栏（210px）+ 内容区
 * ---------------------------------------------------------------------------
 * 本页只验证渲染管线与虚拟滚动，W4 会整体替换为正式界面
 * （TabStrip / Sidebar / FindBar / StatusBar / 右键菜单等）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { TitleBar } from "./components/TitleBar";
import { VirtualReader } from "./components/VirtualReader";
import type { VirtualReaderHandle } from "./components/VirtualReader";
import {
  clearRenderCaches,
  highlightedBlockCount,
  refreshMermaid,
  renderBlocks,
  setRendererTheme,
} from "./lib/renderer";
import type { Block, ReaderTheme, ScrollProgress } from "./lib/renderer";
import { loadDemoDoc } from "./lib/demo-doc";
import type { DemoDoc } from "./lib/demo-doc";
import "./App.css";
import "./styles/markdown.css";

/** 首屏指标：解析/渲染耗时与块数 */
interface PerfStats {
  parseMs: number;
  firstPaintMs?: number;
  blockCount: number;
  chars: number;
  loadMs: number;
  source: string;
}

/** 判断是否运行在 Tauri 窗口里（浏览器直接打开时为 false） */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function App() {
  const [doc, setDoc] = useState<DemoDoc | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [stats, setStats] = useState<PerfStats | null>(null);
  const [progress, setProgress] = useState<ScrollProgress | null>(null);
  const [theme, setTheme] = useState<ReaderTheme>(
    () => (document.documentElement.dataset.theme as ReaderTheme) ?? "dark",
  );
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const readerRef = useRef<VirtualReaderHandle | null>(null);
  const [jumpValue, setJumpValue] = useState("");

  /* ------------------------------ 加载演示文档 ------------------------------ */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await loadDemoDoc();
        if (cancelled) return;
        setDoc(d);

        const t0 = performance.now();
        clearRenderCaches();
        const bs = renderBlocks(d.text, { theme });
        const parseMs = performance.now() - t0;

        if (cancelled) return;
        setBlocks(bs);
        setStats({
          parseMs,
          blockCount: bs.length,
          chars: d.chars,
          loadMs: d.loadMs,
          source: d.source,
        });
        // 首屏合成完成时间：等虚拟列表首帧与高度测量落地（rAF 在窗口失焦时可能不触发，用定时器兜底）
        const markFirstPaint = () => {
          if (!cancelled) {
            setStats((s) => (s ? { ...s, firstPaintMs: performance.now() - t0 } : s));
          }
        };
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => setTimeout(markFirstPaint, 0));
        } else {
          setTimeout(markFirstPaint, 0);
        }
        // 双保险：即便 rAF 被节流，1.5s 内也一定给出数字
        setTimeout(markFirstPaint, 1500);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // 只在挂载时加载一次；主题切换走独立 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------ 主题切换 ------------------------------ */

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    setRendererTheme(theme);
    // mermaid 需要按新主题重绘（Shiki 靠 CSS 变量，自动生效）
    const scroller = readerRef.current?.getScroller();
    if (scroller) void refreshMermaid(scroller);
  }, [theme]);

  /* ------------------------------ 滚动进度 ------------------------------ */

  const onScrollProgress = useCallback((p: ScrollProgress) => {
    setProgress(p);
  }, []);

  const outline = useMemo(
    () =>
      blocks
        .map((b) => (b.heading ? { index: b.index, level: b.heading.level, text: b.heading.text } : null))
        .filter((x): x is { index: number; level: number; text: string } => x !== null),
    [blocks],
  );

  /**
   * 大纲渲染窗口：标题可能上万条（压测件 13,278 个），
   * 全量渲染会拖垮首屏。默认只渲染当前进度附近的 400 条，
   * 用户滚动大纲列表时再平移窗口。
   */
  const [outlineStart, setOutlineStart] = useState(0);
  const OUTLINE_WINDOW = 400;
  const outlineSlice = useMemo(
    () => outline.slice(outlineStart, outlineStart + OUTLINE_WINDOW),
    [outline, outlineStart],
  );
  /** 滚动进度变化时把大纲窗口跟随到当前块附近 */
  useEffect(() => {
    if (!progress || outline.length <= OUTLINE_WINDOW) return;
    // 找到当前块在大纲里的位置（二分）
    let lo = 0;
    let hi = outline.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (outline[mid]!.index < progress.blockIndex) lo = mid + 1;
      else hi = mid;
    }
    const anchor = lo;
    setOutlineStart((prev) => {
      // 当前窗口仍覆盖 anchor 时不打断用户
      if (anchor >= prev && anchor < prev + OUTLINE_WINDOW) return prev;
      // 跟随到 anchor 前 40 条的位置
      return Math.max(0, Math.min(anchor - 40, Math.max(0, outline.length - OUTLINE_WINDOW)));
    });
  }, [progress?.blockIndex, outline]);

  const jumpTo = (value: string) => {
    const n = Number(value.trim());
    if (!Number.isFinite(n)) return;
    // 用户按 1 起始的块号输入
    readerRef.current?.scrollToBlock(n - 1, "start");
  };

  const toggleTheme = () => {
    const next: ReaderTheme = theme === "dark" ? "light" : "dark";
    localStorage.setItem("mojuan-theme", next);
    setTheme(next);
  };

  const percent = progress ? progress.percent.toFixed(1) : "0.0";
  const rendered = progress?.rendered ?? 0;

  return (
    <div class="app-frame">
      <TitleBar title="墨卷 · W3 渲染与虚拟滚动演示" />

      {/* 演示页工具条（正式版由 W4 的 TabStrip 取代） */}
      <div class="demo-toolbar">
        <span class="demo-title">渲染管线验证</span>
        {stats && (
          <span class="demo-stat">
            {stats.blockCount.toLocaleString()} 块 · {stats.chars.toLocaleString()} 字 · 解析{" "}
            {stats.parseMs.toFixed(0)} ms · 首屏 {stats.firstPaintMs?.toFixed(0) ?? "-"} ms
          </span>
        )}
        <span class="demo-spacer" />
        {!isTauri && <span class="demo-badge">浏览器预览模式</span>}
        <button class="ghost" onClick={() => readerRef.current?.scrollToTop()}>
          回到顶部
        </button>
        <button class="ghost" onClick={() => setOutlineOpen((v) => !v)}>
          {outlineOpen ? "隐藏大纲" : "显示大纲"}
        </button>
        <button class="ghost" onClick={toggleTheme}>
          {theme === "dark" ? "浅色" : "深色"}
        </button>
      </div>

      <div class="app-body">
        {/* 侧栏：大纲（点击跳块） */}
        {outlineOpen && (
          <aside class="sidebar demo-outline">
            <div class="outline-head">
              大纲（{outline.length.toLocaleString()}）
              {outline.length > OUTLINE_WINDOW && (
                <span class="outline-window">
                  {" "}· 显示 {outlineStart + 1}-{Math.min(outlineStart + OUTLINE_WINDOW, outline.length)}
                </span>
              )}
            </div>
            <div
              class="outline-list"
              onScroll={(e) => {
                // 大纲自身也做窗口化：滚到底/顶时平移 200 条
                const el = e.currentTarget as HTMLDivElement;
                const max = outline.length - OUTLINE_WINDOW;
                if (max <= 0) return;
                if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) {
                  setOutlineStart((p) => Math.min(max, p + 200));
                } else if (el.scrollTop <= 0 && outlineStart > 0) {
                  setOutlineStart((p) => Math.max(0, p - 200));
                }
              }}
            >
              {outlineSlice.map((h) => (
                <button
                  key={h.index}
                  class="outline-item"
                  style={{ paddingLeft: `${10 + (h.level - 1) * 12}px` }}
                  onClick={() => readerRef.current?.scrollToBlock(h.index, "start")}
                  title={`跳转到第 ${h.index + 1} 块`}
                >
                  {h.text || "(无标题)"}
                </button>
              ))}
            </div>
          </aside>
        )}

        {/* 内容区 */}
        <main class="content-card">
          <div class="reader-wrap">
            {loadError ? (
              <div class="reader-error">文档加载失败：{loadError}</div>
            ) : doc ? (
              <VirtualReader
                blocks={blocks}
                apiRef={readerRef}
                onScrollProgress={onScrollProgress}
                emptyText="文档为空"
              />
            ) : (
              <div class="reader-loading">
                <div class="spinner" />
                <div>正在加载并解析演示文档…</div>
                <div class="reader-loading-hint">首次解析 22MB 压测件约需 2 秒</div>
              </div>
            )}
          </div>

          {/* 底部状态条（W4 由 StatusBar 取代） */}
          <div class="demo-statusbar">
            <span>进度 {percent}%</span>
            <span>
              块 {progress ? progress.blockIndex + 1 : 1} / {blocks.length.toLocaleString()}
            </span>
            <span>挂载 {rendered} 块</span>
            <span>高亮缓存 {highlightedBlockCount()}</span>
            <span class="demo-spacer" />
            <label class="jump-box">
              跳到块
              <input
                type="text"
                inputMode="numeric"
                value={jumpValue}
                placeholder="如 40000"
                onInput={(e) => setJumpValue((e.currentTarget as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") jumpTo(jumpValue);
                }}
              />
            </label>
            <button class="ghost" onClick={() => jumpTo(jumpValue)}>
              跳转
            </button>
            <span class="demo-source">{stats?.source ?? ""}</span>
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
