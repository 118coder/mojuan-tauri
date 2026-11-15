/**
 * 块级虚拟滚动阅读器（W3）
 * ---------------------------------------------------------------------------
 * 设计要点：
 *  1. 只挂载视口 ±5 屏内的块；未挂载区域由一个等高 spacer 占位；
 *  2. 高度模型用 Fenwick 树：未测量的块先用 renderer 给的估算高度，
 *     块挂载后用 ResizeObserver 记录真实高度并 O(log n) 更新；
 *  3. 高度校正不跳变：测量块在视口锚点上方时，同步补偿 scrollTop，保持锚点稳定；
 *  4. 文本选择：所有块按文档顺序真实 DOM 排列（绝对定位但不改顺序），
 *     并给选区所在块加挂载保护，避免高亮升级/滚动把选区打断；
 *  5. 外部控制：apiRef 提供 scrollToBlock/getProgress，另支持 scrollTopByProp 受控滚动。
 */

import { memo } from "preact/compat";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Block, ScrollProgress } from "../lib/renderer";
import { enhanceBlockElement } from "../lib/renderer";

/* -------------------------------------------------------------------------- */
/* 对外类型                                                                    */
/* -------------------------------------------------------------------------- */

export interface VirtualReaderProps {
  /** renderBlocks 产出的块数组 */
  blocks: Block[];
  /** 每侧预渲染的“屏”数（默认 5） */
  overscanScreens?: number;
  /** 外部受控的 scrollTop（变化时直接滚过去） */
  scrollTopByProp?: number | null;
  /** 滚动进度回调（rAF 节流） */
  onScrollProgress?: (p: ScrollProgress) => void;
  /** 外部调用句柄 */
  apiRef?: { current: VirtualReaderHandle | null };
  /** 空文档占位文案 */
  emptyText?: string;
}

export interface VirtualReaderHandle {
  /** 滚动到第 index 块；align 决定对齐方式 */
  scrollToBlock: (index: number, align?: "start" | "center" | "end") => void;
  /** 回到顶部 */
  scrollToTop: () => void;
  /** 读取当前进度 */
  getProgress: () => ScrollProgress;
  /** 当前挂载的块数（DOM 级指标） */
  getRenderedCount: () => number;
  /** 手动重试一次可见块增强（代码高亮/mermaid） */
  retryEnhance: () => void;
  /** 滚动容器元素（主题重绘 mermaid 等场景用） */
  getScroller: () => HTMLElement | null;
}

/** 单次挂载的块数硬上限：保证 DOM 节点可控（视口内块永远全部渲染） */
const MAX_MOUNTED_BLOCKS = 96;

/* -------------------------------------------------------------------------- */
/* Fenwick 树：块高度前缀和（O(log n) 更新 / 查询）                             */
/* -------------------------------------------------------------------------- */

class Fenwick {
  private readonly tree: Float64Array;
  readonly n: number;

  constructor(values: Float64Array) {
    this.n = values.length;
    this.tree = new Float64Array(this.n + 1);
    for (let i = 0; i < this.n; i++) this.add(i, values[i]!);
  }

  /** 第 index 项增加 delta */
  add(index: number, delta: number): void {
    for (let i = index + 1; i <= this.n; i += i & -i) this.tree[i]! += delta;
  }

  /** 前 index 项之和（[0, index)） */
  prefix(index: number): number {
    let s = 0;
    for (let i = Math.min(index, this.n); i > 0; i -= i & -i) s += this.tree[i]!;
    return s;
  }

  total(): number {
    return this.prefix(this.n);
  }

  /** 找出最大的 i，使前 i 项之和 <= offset（即 offset 落在第 i 块内） */
  findIndex(offset: number): number {
    if (this.n === 0) return 0;
    let pos = 0;
    let rest = offset;
    let bit = 1;
    while (bit * 2 <= this.n) bit *= 2;
    for (; bit > 0; bit >>= 1) {
      const next = pos + bit;
      if (next <= this.n && this.tree[next]! <= rest) {
        pos = next;
        rest -= this.tree[next]!;
      }
    }
    return Math.min(Math.max(pos, 0), Math.max(0, this.n - 1));
  }

  /** 返回下标 i 对应块的顶部偏移（等于前缀和） */
  offsetOf(index: number): number {
    return this.prefix(index);
  }
}

/** 高度模型（随 blocks 重建） */
interface HeightModel {
  n: number;
  heights: Float64Array;
  measured: Uint8Array;
  fw: Fenwick;
}

function buildModel(blocks: Block[]): HeightModel {
  const n = blocks.length;
  const heights = new Float64Array(n);
  for (let i = 0; i < n; i++) heights[i] = Math.max(20, blocks[i]!.estHeight);
  return { n, heights, measured: new Uint8Array(n), fw: new Fenwick(heights) };
}

/* -------------------------------------------------------------------------- */
/* 单个块：用 memo 隔离，只有 html/top 变化才重渲染                             */
/* -------------------------------------------------------------------------- */

interface BlockViewProps {
  block: Block;
  top: number;
}

/**
 * 块视图。用 memo 包住的意义：
 *  - mermaid 渲染直接改块内 DOM，父级重渲染不能把 SVG 冲掉；
 *  - 滚动时只有区间变化，未变化的块不进入 diff。
 * Preact 的 dangerouslySetInnerHTML 只在字符串变化时写 innerHTML，因此选区不会被无谓清洗。
 */
const BlockView = memo(
  function BlockView({ block, top }: BlockViewProps) {
    return (
      <div class="mj-block" data-block-index={block.index} style={{ transform: `translateY(${top}px)` }}>
        <div class="mj-block-inner" dangerouslySetInnerHTML={{ __html: block.html }} />
      </div>
    );
  },
  // 注意：block.html 是就地升级的，引用不变时必须靠 revision 才能感知变化
  (a, b) => a.block === b.block && a.block.revision === b.block.revision && a.top === b.top,
);

/* -------------------------------------------------------------------------- */
/* 组件实现                                                                    */
/* -------------------------------------------------------------------------- */

export function VirtualReader(props: VirtualReaderProps) {
  const { blocks, overscanScreens = 5, scrollTopByProp, onScrollProgress, apiRef, emptyText } = props;

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const model = useMemo(() => buildModel(blocks), [blocks]);
  const modelRef = useRef<HeightModel>(model);
  modelRef.current = model;

  /** 总高度（px），用状态驱动 spacer */
  const [totalHeight, setTotalHeight] = useState(() => model.fw.total());
  /** 当前挂载区间 [start, end) */
  const [range, setRange] = useState(() => ({ start: 0, end: Math.min(blocks.length, 12) }));
  /** 自增版本号：块 HTML 升级/高度校正后触发重渲染 */
  const [rev, setRev] = useState(0);

  const rangeRef = useRef(range);
  rangeRef.current = range;

  const rafRef = useRef<number | null>(null);
  /** rAF 兜底定时器：窗口不可见/失焦时 rAF 会被节流甚至不执行，必须保证更新最终发生 */
  const rafFallbackRef = useRef<number | null>(null);
  const observedRef = useRef<Map<HTMLElement, number>>(new Map());
  const roRef = useRef<ResizeObserver | null>(null);
  const pendingScrollAdjustRef = useRef(0);
  const progressCbRef = useRef(onScrollProgress);
  progressCbRef.current = onScrollProgress;

  /**
   * 请求一次“下一帧”更新。
   * rAF 在窗口失焦/最小化、后台标签页时会被浏览器节流到不触发；
   * 这里同时挂一个 120ms 的定时器兜底，谁先到谁执行（执行一次后互相取消）。
   */
  const requestFrame = useCallback((task: () => void) => {
    if (rafRef.current != null || rafFallbackRef.current != null) return;
    const run = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (rafFallbackRef.current != null) {
        window.clearTimeout(rafFallbackRef.current);
        rafFallbackRef.current = null;
      }
      task();
    };
    rafRef.current = requestAnimationFrame(run);
    rafFallbackRef.current = window.setTimeout(run, 120);
  }, []);

  /* ------------------------------ 进度计算 ------------------------------ */

  const computeProgress = (): ScrollProgress => {
    const scroller = scrollerRef.current;
    const m = modelRef.current;
    const st = scroller?.scrollTop ?? 0;
    const vh = scroller?.clientHeight ?? 0;
    const max = Math.max(0, m.fw.total() - vh);
    const percent = max > 0 ? Math.min(100, Math.max(0, (st / max) * 100)) : 0;
    return {
      percent,
      blockIndex: m.n > 0 ? m.fw.findIndex(st + 1) : 0,
      scrollTop: st,
      start: rangeRef.current.start,
      end: rangeRef.current.end,
      rendered: rangeRef.current.end - rangeRef.current.start,
    };
  };

  /* ------------------------------ 区间计算 ------------------------------ */

  const updateRange = (force = false) => {
    const scroller = scrollerRef.current;
    const m = modelRef.current;
    if (!scroller || m.n === 0) return;

    const st = scroller.scrollTop;
    const vh = scroller.clientHeight;
    if (vh <= 0) return;

    const pad = vh * overscanScreens;
    const total = m.fw.total();

    // 视口内块区间（用于保证可见块全渲染）
    const visStart = m.fw.findIndex(Math.max(0, st));
    const visEnd = Math.min(m.n, m.fw.findIndex(Math.min(total - 1, st + vh)) + 1);
    const visCount = Math.max(1, visEnd - visStart);

    let start = m.fw.findIndex(Math.max(0, st - pad));
    let end = Math.min(m.n, m.fw.findIndex(Math.min(total - 1, st + vh + pad)) + 1);

    // 硬上限：以视口块为中心收缩（视口本身必须完整保留）
    const limit = Math.max(MAX_MOUNTED_BLOCKS, visCount + 8);
    if (end - start > limit) {
      const center = Math.floor((visStart + visEnd) / 2);
      start = Math.max(0, center - Math.floor(limit / 2));
      end = Math.min(m.n, start + limit);
      start = Math.max(0, Math.min(start, visStart));
      end = Math.max(end, visEnd);
    }

    // 选区保护：正在被选择的块不能被卸载
    const sel = selectionRange();
    if (sel) {
      start = Math.min(start, sel.min);
      end = Math.max(end, sel.max + 1);
    }

    if (force || start !== rangeRef.current.start || end !== rangeRef.current.end) {
      rangeRef.current = { start, end };
      setRange({ start, end });
    }

    progressCbRef.current?.({
      percent: computePercent(st, vh, total),
      blockIndex: m.fw.findIndex(st + 1),
      scrollTop: st,
      start,
      end,
      rendered: end - start,
    });
  };

  const computePercent = (st: number, vh: number, total: number): number => {
    const max = Math.max(0, total - vh);
    return max > 0 ? Math.min(100, Math.max(0, (st / max) * 100)) : 0;
  };

  /** 当前选区覆盖的块区间（用于挂载保护） */
  const selectionRange = (): { min: number; max: number } | null => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const idxOf = (node: Node | null): number | null => {
      if (!node) return null;
      const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      const block = el?.closest(".mj-block");
      if (!block) return null;
      const raw = block.getAttribute("data-block-index");
      return raw == null ? null : Number(raw);
    };
    const a = idxOf(sel.anchorNode);
    const b = idxOf(sel.focusNode);
    if (a == null || b == null) return null;
    return { min: Math.min(a, b), max: Math.max(a, b) };
  };

  /* ------------------------------ 高度测量 ------------------------------ */

  /** 测量单个块并更新模型；返回高度是否有变化 */
  const measureBlock = (el: HTMLElement, index: number): boolean => {
    const m = modelRef.current;
    if (index < 0 || index >= m.n) return false;
    const h = el.getBoundingClientRect().height;
    if (h <= 0) return false;

    const old = m.heights[index]!;
    if (Math.abs(h - old) < 0.5 && m.measured[index]) return false;

    // 锚点：视口顶部所在块（在更新前计算，作为不跳变的基准）
    const scroller = scrollerRef.current;
    const anchor = scroller ? m.fw.findIndex(scroller.scrollTop + 1) : 0;
    // 被测量块在锚点上方：高度变化会把锚点顶走，累计补偿
    if (scroller && index < anchor) pendingScrollAdjustRef.current += h - old;

    m.heights[index] = h;
    m.measured[index] = 1;
    m.fw.add(index, h - old);
    return true;
  };

  /** 批量测量 + 应用滚动补偿 */
  const flushMeasurements = (): void => {
    let changed = false;
    for (const [el, index] of observedRef.current) {
      if (!el.isConnected) {
        roRef.current?.unobserve(el);
        observedRef.current.delete(el);
        continue;
      }
      if (measureBlock(el, index)) changed = true;
    }
    if (changed) {
      setTotalHeight(modelRef.current.fw.total());
      setRev((v) => v + 1);
    }
    const adjust = pendingScrollAdjustRef.current;
    pendingScrollAdjustRef.current = 0;
    const scroller = scrollerRef.current;
    if (adjust !== 0 && scroller) {
      const next = Math.max(0, scroller.scrollTop + adjust);
      if (Math.abs(next - scroller.scrollTop) > 0.5) scroller.scrollTop = next;
    }
  };

  /* ------------------------------ 生命周期 ------------------------------ */

  // blocks 变化：重置模型状态、回到顶部
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const m = modelRef.current;
    observedRef.current.clear();
    pendingScrollAdjustRef.current = 0;
    if (roRef.current) roRef.current.disconnect();
    setTotalHeight(m.fw.total());
    setRev((v) => v + 1);
    if (scroller) scroller.scrollTop = 0;
    rangeRef.current = { start: 0, end: Math.min(m.n, 12) };
    setRange(rangeRef.current);
    updateRange(true);
    // 只跟随 blocks 引用变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks]);

  // 创建 ResizeObserver（一次）
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      // 合并到下一帧，避免测量期间反复 reflow
      requestFrame(() => flushMeasurements());
    });
    roRef.current = ro;
    return () => {
      ro.disconnect();
      roRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 每次挂载区间/版本变化：观察新块并立即测一次
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const ro = roRef.current;
    if (!scroller) return;

    const els = scroller.querySelectorAll<HTMLElement>(".mj-block");
    for (const el of Array.from(els)) {
      if (observedRef.current.has(el)) continue;
      const index = Number(el.getAttribute("data-block-index"));
      if (Number.isNaN(index)) continue;
      observedRef.current.set(el, index);
      ro?.observe(el);
    }
    flushMeasurements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.end, rev]);

  // 滚动监听（rAF 节流）
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const onScroll = () => {
      requestFrame(() => updateRange());
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });

    const onResize = () => updateRange(true);
    window.addEventListener("resize", onResize);

    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (rafFallbackRef.current != null) window.clearTimeout(rafFallbackRef.current);
      rafRef.current = null;
      rafFallbackRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部受控 scrollTop
  useEffect(() => {
    if (typeof scrollTopByProp !== "number") return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = scrollTopByProp;
    updateRange(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTopByProp]);

  // 可见块增强：代码高亮 / mermaid（按挂载区间逐个处理，不阻塞滚动）
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const start = rangeRef.current.start;
      const end = rangeRef.current.end;
      for (let i = start; i < end; i++) {
        if (cancelled) return;
        const block = blocks[i];
        if (!block) continue;
        const el = scroller.querySelector<HTMLElement>(
          `.mj-block[data-block-index="${i}"] .mj-block-inner`,
        );
        if (!el) continue;
        const changed = await enhanceBlockElement(block, el);
        if (changed && !cancelled) setRev((v) => v + 1);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [blocks, range.start, range.end]);

  // 选区变化后重试被延后的高亮（避免打断选区）
  useEffect(() => {
    let timer: number | null = null;
    const onSelectionChange = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void retryEnhance();
      }, 220);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      if (timer != null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks]);

  /* ------------------------------ 对外句柄 ------------------------------ */

  const scrollToBlock = (index: number, align: "start" | "center" | "end" = "start") => {
    const scroller = scrollerRef.current;
    const m = modelRef.current;
    if (!scroller || m.n === 0) return;
    const i = Math.max(0, Math.min(m.n - 1, Math.round(index)));
    const top = m.fw.prefix(i);
    const h = m.heights[i]!;
    const vh = scroller.clientHeight;
    let y = top;
    if (align === "center") y = top - (vh - h) / 2;
    else if (align === "end") y = top - vh + h;
    const max = Math.max(0, m.fw.total() - vh);
    scroller.scrollTop = Math.max(0, Math.min(y, max));
    updateRange(true);
  };

  const retryEnhance = async (): Promise<void> => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const { start, end } = rangeRef.current;
    for (let i = start; i < end; i++) {
      const block = blocks[i];
      if (!block) continue;
      const el = scroller.querySelector<HTMLElement>(`.mj-block[data-block-index="${i}"] .mj-block-inner`);
      if (!el) continue;
      const changed = await enhanceBlockElement(block, el);
      if (changed) setRev((v) => v + 1);
    }
  };

  if (apiRef) {
    apiRef.current = {
      scrollToBlock,
      scrollToTop: () => {
        const scroller = scrollerRef.current;
        if (scroller) scroller.scrollTop = 0;
        updateRange(true);
      },
      getProgress: computeProgress,
      getRenderedCount: () => rangeRef.current.end - rangeRef.current.start,
      retryEnhance: () => void retryEnhance(),
      getScroller: () => scrollerRef.current,
    };
  }

  /* ------------------------------ 渲染 ------------------------------ */

  const visible = blocks.slice(range.start, range.end);
  const offsets = visible.map((_, i) => model.fw.prefix(range.start + i));

  return (
    <div class="mj-reader" ref={scrollerRef}>
      {blocks.length === 0 ? (
        <div class="mj-reader-empty">{emptyText ?? "没有可显示的内容"}</div>
      ) : (
        <div class="mj-canvas" style={{ height: `${totalHeight}px` }}>
          {visible.map((block, i) => (
            <BlockView key={block.id} block={block} top={offsets[i]!} />
          ))}
        </div>
      )}
    </div>
  );
}
