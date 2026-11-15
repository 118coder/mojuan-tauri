/**
 * 墨卷页内查找条（W4a · 渲染区）
 * ---------------------------------------------------------------------------
 * 布局：输入框 + 「当前 / 总数」计数 + ↑↓ 跳转 + Aa 大小写开关 + 关闭按钮。
 * 样式：.mj-findbar（theme.css），固定在阅读区右上角，全主题可用。
 *
 * 两种接法（可混用）：
 *  A. W4a 契约（前三个必接）：
 *   <FindBar
 *     onQueryChange={(q) => setQuery(q)}   // 词变化 → 传进渲染管线 renderBlocks(…, { query })
 *     onJump={(dir) => jumpHit(dir)}       // ↑/↓/Enter 触发；F3/Shift+F3 键盘监听由 W4b 挂，复用同一个 onJump
 *     onClose={() => closeFind()}          // Esc/× → 关闭并清掉全部高亮（铁律 2.4-4：关闭后清高亮）
 *     caseSensitive={cs}                    // 可选：初始大小写敏感
 *     initialQuery={selectedText}           // 可选：预填词（见下方「选中文字带入」）
 *     hitTotal={total} hitCurrent={cur + 1} // 可选：外部统计（传了优先用）
 *     onCaseSensitiveChange={setCs}         // 可选：Aa 切换回传
 *   />
 *  B. W4b Stub 兼容（可选 props，配合 A 一起用）：
 *   open={findOpen}          // false 时不渲染（App 可常驻挂载）
 *   blocks={blocks}          // 当前渲染块；未传 hitTotal 时用它 + getBlockHitCounts 精确统计总命中
 *   navTick={findTick}       // F3/Shift+F3 计数（0=无；正=下一个，负=上一个）→ 触发 onJump
 *   getScroller={…}          // 兼容接受；计数走 blocks 高亮统计，不再用 innerText 数
 *
 * 「选中文字带入搜索词」（铁律 2.4-3，由 W4b 完成）：打开查找框前读选区——
 *   openFindBar 时把 document.getSelection()?.toString().trim() 设进 initialQuery；
 *   组件在打开/预填词变化时聚焦、全选并触发一次 onQueryChange(preset)（立即开始查找）。
 *
 * 计数来源优先级：hitTotal/hitCurrent props（外部统计，虚拟滚动下唯一准确）>
 * blocks + getBlockHitCounts 求和（精确总数；当前命中用 DOM 里的 .current 序号）>
 * 纯 DOM 兜底（全量挂载的演示页准确，虚拟滚动会漏未挂载块）。
 * 「3 / 17」中当前为 1 基显示；renderer 的 currentHit / data-hit 是 0 基。
 *
 * 当前命中强色切换：全量重渲（renderBlocks 传 currentHit）代价高；增量路径是
 * renderer.applyCurrentHit(readerEl, hit)（只翻 DOM class），配合
 * getBlockHitCounts 前缀和定位命中所在块（见 renderer.ts 注释）。
 */

import { useEffect, useRef, useState } from "preact/hooks";
import type { Block } from "../lib/renderer";
import { getBlockHitCounts } from "../lib/renderer";

/* -------------------------------------------------------------------------- */
/* 对外类型                                                                    */
/* -------------------------------------------------------------------------- */

export interface FindBarProps {
  /* ── W4a 契约 ── */
  /** 词变化（含挂载预填、Aa 切换后同词重发）→ W4b 把 query 传进渲染管线 */
  onQueryChange: (q: string) => void;
  /** ↑ / ↓ / Enter(±Shift) / navTick 变化时触发；F3=1、Shift+F3=-1 */
  onJump: (dir: 1 | -1) => void;
  /** 关闭（Esc / ×）；W4b 在此清查找高亮 */
  onClose: () => void;
  /** 初始大小写敏感（内部可切换，切换时重发 onQueryChange 并回调 onCaseSensitiveChange） */
  caseSensitive?: boolean;
  /** 打开时预填的查找词（W4b 传选中文本；打开即触发一次 onQueryChange） */
  initialQuery?: string;
  /** 外部统计的总命中数（推荐；虚拟滚动下 DOM 兜底会漏计） */
  hitTotal?: number;
  /** 外部统计的当前命中（1 基显示） */
  hitCurrent?: number;
  /** Aa 开关变化回传（W4b 同步进渲染管线 opts.caseSensitive） */
  onCaseSensitiveChange?: (caseSensitive: boolean) => void;

  /* ── W4b Stub 兼容 ── */
  /** false 时不渲染（App 常驻挂载用）；缺省视为 true */
  open?: boolean;
  /** 当前渲染块：未传 hitTotal 时按 getBlockHitCounts 精确统计总命中 */
  blocks?: Block[] | null;
  /** F3/Shift+F3 导航计数（0=无；正=下一个，负=上一个）；变化时触发 onJump */
  navTick?: number;
  /** 兼容接受（Stub 契约），计数不再走 innerText 统计 */
  getScroller?: () => HTMLElement | null;
}

/* -------------------------------------------------------------------------- */
/* 组件                                                                        */
/* -------------------------------------------------------------------------- */

export function FindBar(props: FindBarProps) {
  const { onQueryChange, onJump, onClose } = props;
  const [q, setQ] = useState(props.initialQuery ?? "");
  const [cs, setCs] = useState(props.caseSensitive === true);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** q 的实时镜像（effect 里比较预填词用） */
  const qRef = useRef(q);
  qRef.current = q;
  const isOpen = props.open !== false;

  /* ------------------------------ 计数 ------------------------------ */

  // DOM 兜底计数（hitTotal / blocks 都没给时才启用）
  const useDomCount = typeof props.hitTotal !== "number" && !props.blocks;
  const [domCount, setDomCount] = useState({ total: 0, current: 0 });

  useEffect(() => {
    if (!useDomCount || !isOpen) return;
    let raf = 0;
    const count = (): void => {
      raf = 0;
      const total = document.querySelectorAll("mark[data-hit]").length;
      const cur = document.querySelector<HTMLElement>("mark[data-hit].current");
      const idx = cur?.getAttribute("data-hit");
      setDomCount({ total, current: idx == null ? 0 : Number(idx) + 1 });
    };
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(count);
    };
    count();
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    return () => {
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [useDomCount, isOpen]);

  /* ------------------------------ 预填与聚焦 ------------------------------ */

  // 挂载：聚焦 + 全选预填词；有预填词立即触发一次查找（铁律 2.4-3）
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!isOpen) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    if (props.initialQuery) onQueryChange(props.initialQuery);
    // 只在挂载时执行一次；后续 open/initialQuery 变化走下面的 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 打开瞬间 / 打开中预填词变化（W4b 把选中文本设进 initialQuery）：聚焦 + 重新查找
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (!isOpen) return;
    const preset = props.initialQuery ?? "";
    if (preset && preset !== qRef.current) {
      setQ(preset);
      qRef.current = preset;
      onQueryChange(preset);
    }
    inputRef.current?.focus();
    inputRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.initialQuery]);

  /* ------------------------------ navTick（F3/Shift+F3 由 W4b 传入） ------------------------------ */

  const navRef = useRef(props.navTick);
  useEffect(() => {
    const t = props.navTick;
    const prev = navRef.current;
    navRef.current = t;
    if (t === undefined || t === 0 || t === prev) return;
    onJump(t > (prev === undefined ? 0 : prev) ? 1 : -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.navTick]);

  /* ------------------------------ 交互 ------------------------------ */

  const onInput = (e: Event): void => {
    const v = (e.currentTarget as HTMLInputElement).value;
    setQ(v);
    qRef.current = v;
    onQueryChange(v);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      // Enter=下一个，Shift+Enter=上一个
      e.preventDefault();
      onJump(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  /** Aa 开关：语义变化时用当前词重发 onQueryChange，让管线按新大小写重算 */
  const toggleCase = (): void => {
    const next = !cs;
    setCs(next);
    props.onCaseSensitiveChange?.(next);
    onQueryChange(q);
  };

  /* ------------------------------ 计数显示 ------------------------------ */

  // 总数优先级：hitTotal prop > blocks 统计 > DOM 兜底
  let total: number;
  if (typeof props.hitTotal === "number") total = props.hitTotal;
  else if (props.blocks) total = getBlockHitCounts(props.blocks).reduce((a, b) => a + b, 0);
  else total = domCount.total;
  const rawCurrent = typeof props.hitCurrent === "number" ? props.hitCurrent : domCount.current;
  const current = total > 0 ? Math.min(Math.max(rawCurrent, 1), total) : 0;
  const countText = q.length === 0 ? "" : total === 0 ? "无结果" : `${current} / ${total}`;

  if (!isOpen) return null;

  return (
    <div class="mj-findbar" data-testid="findbar" role="search" aria-label="页内查找">
      <input
        ref={inputRef}
        type="text"
        placeholder="查找"
        aria-label="查找内容"
        value={q}
        onInput={onInput}
        onKeyDown={onKeyDown}
        spellcheck={false}
      />
      {countText && <span class="find-count">{countText}</span>}
      <button
        type="button"
        class="find-prev"
        title="上一个 (Shift+F3)"
        aria-label="上一个命中"
        onClick={() => onJump(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        class="find-next"
        title="下一个 (F3)"
        aria-label="下一个命中"
        onClick={() => onJump(1)}
      >
        ↓
      </button>
      <button
        type="button"
        class={"find-case" + (cs ? " active" : "")}
        title="区分大小写"
        aria-label="区分大小写"
        aria-pressed={cs}
        onClick={toggleCase}
      >
        Aa
      </button>
      <button type="button" class="find-close" title="关闭 (Esc)" aria-label="关闭查找" onClick={() => onClose()}>
        ×
      </button>
    </div>
  );
}
