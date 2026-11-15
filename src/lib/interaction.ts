/**
 * 交互仲裁器（W8）—— 全应用唯一的「输入 / 滚动所有权」中心
 * ===========================================================================
 * 为什么重写（W7 方案的死穴）
 * ---------------------------------------------------------------------------
 * W7 把四处 wheel 监听收编了，方向没错，但「谁在滚动」仍然靠四个时间窗猜：
 *   Sidebar 200ms / 1500ms、App 分屏 160ms、EditorPane 60ms + 回声比对。
 * Chromium 的 scroll 事件**不携带来源**：程序化写 scrollTop 与用户滚轮派发的
 * 事件完全同形，社区共识也是「只能自己标记」（见 chenglou/martian-ui
 * 《Scrolling》：preferably only read scrollTop, don't set a new position）。
 * 时间窗遇到连续滚轮、触控板惯性、快速反向、后台节流就必然漏判：
 *   - 大纲程序化滚动被误认成「用户滚了大纲」→ 暂停跟随 1.5s → 高亮掉队；
 *   - 大纲滚到窗口边缘 → 平移 400 条窗口 → 抢写 scrollTop → 打断用户惯性滚动
 *     → 用户感觉「滚轮被抢、列表往回跳」；鼠标稍一偏又变成预览在滚 →
 *     这就是用户报告的「大纲和预览的滚轮冲突」。
 *
 * 本模块的三条铁律（改任何滚动代码前先读）
 * ---------------------------------------------------------------------------
 *  1. **只有一条全局输入链路**：wheel 在 window 捕获阶段、scroll 在 document
 *     捕获阶段，各只挂一次。组件不许再挂 window/document 级 wheel / scroll，
 *     也不许写 `onWheel={...}`；要参与策略就在 DOM 上声明 data-* 属性。
 *  2. **程序化滚动必须申报**：任何 `el.scrollTop = x` 一律走
 *     `programmaticScroll(el, x, reason)`。它登记「写入后读回的预期值 + token」，
 *     `classifyScroll` 用**值比对**精确认领，而不是用时间窗。
 *     位置对不上 = 用户在这期间又滚了 → 老老实实按用户滚动处理，绝不误吞。
 *  3. **滚动所有权归用户**：普通滚轮一个字节都不碰，交给浏览器原生滚动；
 *     程序化滚动只能由「用户主动跳转 / 恢复进度 / 高度补偿」这类显式动作触发，
 *     且禁止因为「预览滚了」就去改「大纲的 scrollTop」（反之亦然）。
 *
 * DOM 契约（组件只声明，不监听）
 *   data-scroll-kind = reader|outline|tree|search|editor|modal|tabstrip|menu
 *   data-wheel       = horizontal（纵向滚轮转横向）| swallow（吞掉普通滚轮）
 *   data-no-zoom     = 1（该区域内 Ctrl+滚轮交回浏览器；目前无使用点，留作逃生舱）
 *
 * 对外能力
 *   programmaticScroll / classifyScroll   程序化滚动登记与溯源
 *   onUserScroll / onProgramScroll / onUserWheel   订阅真实输入（菜单关闭等）
 *   useWheelZoom                          Ctrl+滚轮缩放（全应用唯一实现）
 *   registerOverlayMask                  弹层遮罩所有权（滚轮不穿透背景）
 *   isGestureActive / lastUserScrollAt   手势会话（大纲「跟随」的礼貌判断）
 *   focusScroller / FOCUSABLE            焦点与键盘滚动
 */

import { useEffect, useRef } from "preact/hooks";

/* -------------------------------------------------------------------------- */
/* 类型                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 滚动原因。程序化滚动必须显式申报，用户滚动统一为 "user"。
 * App 只看这个字段决定要不要联动别的面板，不再靠 `Date.now()` 猜。
 */
export type ScrollReason =
  | "user" // 真实用户输入：滚轮 / 键盘 / 拖滚动条
  | "jump" // 用户主动跳转：大纲点击、百分比跳转、导航前进后退
  | "restore" // 刷新 / 切标签恢复阅读进度
  | "sync" // 分屏联动同步
  | "measure" // 高度模型校正的锚点补偿
  | "reset" // 换文档回顶
  | "follow"; // 大纲跟随当前章节（仅在用户允许且大纲静止时）

/** 滚动域标识：声明在 DOM 上，仲裁器据此判定归属 */
export type ScrollKind =
  | "reader"
  | "outline"
  | "tree"
  | "search"
  | "editor"
  | "modal"
  | "tabstrip"
  | "menu"
  | "other";

export interface ScrollOrigin {
  programmatic: boolean;
  reason: ScrollReason;
  kind: ScrollKind;
  el: HTMLElement;
}

/* -------------------------------------------------------------------------- */
/* 统计（无头回归用只读快照断言，不参与任何业务判定）                              */
/* -------------------------------------------------------------------------- */

const stats = {
  programWrites: 0,
  programConsumed: 0,
  programMismatch: 0,
  programExpired: 0,
  userScrolls: 0,
  wheelEvents: 0,
  zoomEvents: 0,
  blockedByOverlay: 0,
  horizontalWheel: 0,
  swallowedWheel: 0,
};

/* -------------------------------------------------------------------------- */
/* 程序化滚动：登记 → 精确认领                                                   */
/* -------------------------------------------------------------------------- */

interface Pending {
  axis: "y" | "x";
  expected: number;
  reason: ScrollReason;
  seq: number;
  at: number;
}

/** 每个元素按轴分别保留「最近一次」程序化写入；scroll 事件到达即消费 */
const pending = new Map<HTMLElement, { y?: Pending; x?: Pending }>();
/** 每个元素最近一次「真实用户滚动」的时间（手势会话静默判定用） */
const userScrollAt = new WeakMap<HTMLElement, number>();
/** 最近一次分类结果：供组件「只读」查询，不重复消费登记 */
const lastOrigin = new WeakMap<HTMLElement, ScrollOrigin>();
let seq = 0;

/** 登记记录的存活上限：超过这个时间还没被 scroll 事件消费，就认定它已失效 */
const CLAIM_TTL_MS = 1200;

/**
 * 补登记：位置**已经变了**，但变化不是我们写 scrollTop 造成的。
 *
 * 唯一来源是 `scrollIntoView()`——它的目标是浏览器算出来的（受对齐方式、
 * 祖先布局、滚动边界影响），我们事先不知道最终落点，没法像
 * programmaticScroll 那样「先写再读回」。做法是：调用前记下 before，
 * 调用后读回当前值登记为 expected。
 *
 * 不补这一步的后果：键盘选文件树 / 命令面板方向键 / 切标签 / 点页内锚点
 * 都会被仲裁器判成「用户滚动」，进而触发分屏联动回写、关掉右键菜单等
 * 本不该发生的副作用。
 */
export function claimScroll(
  el: HTMLElement,
  before: number,
  reason: ScrollReason,
  axis: "y" | "x" = "y",
): void {
  const cur = axis === "y" ? el.scrollTop : el.scrollLeft;
  if (Math.abs(cur - before) < 0.5) return; // 没动，不需申报（也不会派发 scroll）
  const slot = pending.get(el) ?? {};
  slot[axis] = { axis, expected: cur, reason, seq: ++seq, at: Date.now() };
  pending.set(el, slot);
  stats.programWrites++;
}

/**
 * 全应用**唯一**允许写 scrollTop / scrollLeft 的入口。
 *
 * 关键：写入后立刻读回实际值作为 expected。scroll 事件是异步派发的，
 * 如果写入与派发之间用户又滚了一下，读到的值就对不上 expected，
 * classifyScroll 会把它判成用户滚动——这正是我们要的「不误吞」。
 * 值相同（浏览器不会派发 scroll）时不登记，避免留下永远消费不掉的脏记录。
 */
export function programmaticScroll(
  el: HTMLElement,
  value: number,
  reason: ScrollReason,
  axis: "y" | "x" = "y",
): void {
  const max =
    axis === "y"
      ? el.scrollHeight - el.clientHeight
      : el.scrollWidth - el.clientWidth;
  const next = Math.max(0, Math.min(value, Math.max(0, max)));
  const before = axis === "y" ? el.scrollTop : el.scrollLeft;
  if (Math.abs(before - next) < 0.5) return;

  if (axis === "y") el.scrollTop = next;
  else el.scrollLeft = next;
  const actual = axis === "y" ? el.scrollTop : el.scrollLeft;

  const slot = pending.get(el) ?? {};
  slot[axis] = { axis, expected: actual, reason, seq: ++seq, at: Date.now() };
  pending.set(el, slot);
  stats.programWrites++;
}

/**
 * 在 scroll 事件里问「这次滚动是谁引起的」。
 * 必须由该滚动容器的 scroll 监听器（或全局捕获监听）调用一次并消费掉记录。
 */
export function classifyScroll(el: HTMLElement, axis: "y" | "x" = "y"): ScrollOrigin {
  const kind = (el.dataset.scrollKind as ScrollKind | undefined) ?? "other";
  const slot = pending.get(el);
  let rec = slot?.[axis];

  // 过期登记一律作废：写入后浏览器可能因为元素隐藏、同帧合并、被父级夹断
  // 而根本没派发（或没派发第二次）scroll。留着的旧 expected 一旦与用户滚动
  // 位置偶然接近，就会把真实用户输入误吞成程序化——宁可漏认，不可误吞。
  if (rec && Date.now() - rec.at > CLAIM_TTL_MS) {
    if (slot) delete slot[axis];
    if (!slot?.y && !slot?.x) pending.delete(el);
    stats.programExpired++;
    rec = undefined;
  }

  let result: ScrollOrigin;

  if (rec) {
    if (slot) delete slot[axis];
    if (!slot?.y && !slot?.x) pending.delete(el);

    const cur = axis === "y" ? el.scrollTop : el.scrollLeft;
    if (Math.abs(cur - rec.expected) <= 1.5) {
      stats.programConsumed++;
      result = { programmatic: true, reason: rec.reason, kind, el };
    } else {
      // 位置对不上：用户在这中间又滚了。按用户滚动处理，绝不误吞。
      stats.programMismatch++;
      userScrollAt.set(el, Date.now());
      stats.userScrolls++;
      result = { programmatic: false, reason: "user", kind, el };
    }
  } else {
    userScrollAt.set(el, Date.now());
    stats.userScrolls++;
    result = { programmatic: false, reason: "user", kind, el };
  }

  lastOrigin.set(el, result);
  return result;
}

/**
 * 只读查询最近一次分类结果（不消费登记）。
 *
 * 为什么需要它：scroll 事件的捕获阶段先经过 document（全局监听已经
 * classifyScroll 消费过一次），组件自己的 scroll 监听器再调一次就会把
 * 「程序化」误读成「用户」。组件一律用这个读缓存。
 */
export function peekOrigin(el: HTMLElement): ScrollOrigin {
  return (
    lastOrigin.get(el) ?? {
      programmatic: false,
      reason: "user" as ScrollReason,
      kind: ((el.dataset.scrollKind as ScrollKind | undefined) ?? "other") as ScrollKind,
      el,
    }
  );
}

/** 某容器最近一次真实用户滚动的时间（0 = 从未） */
export function lastUserScrollAt(el: HTMLElement | null): number {
  return el ? (userScrollAt.get(el) ?? 0) : 0;
}

/* -------------------------------------------------------------------------- */
/* 单一全局输入链路                                                             */
/* -------------------------------------------------------------------------- */

type ScrollSub = (o: ScrollOrigin) => void;
type WheelSub = (e: WheelEvent, host: HTMLElement | null) => void;
const userScrollSubs = new Set<ScrollSub>();
const programScrollSubs = new Set<ScrollSub>();
const userWheelSubs = new Set<WheelSub>();
const zoomSubs = new Set<(delta: 1 | -1) => void>();

export function onUserScroll(fn: ScrollSub): () => void {
  userScrollSubs.add(fn);
  return () => void userScrollSubs.delete(fn);
}
export function onProgramScroll(fn: ScrollSub): () => void {
  programScrollSubs.add(fn);
  return () => void programScrollSubs.delete(fn);
}
export function onUserWheel(fn: WheelSub): () => void {
  userWheelSubs.add(fn);
  return () => void userWheelSubs.delete(fn);
}

/** Ctrl+滚轮缩放：全应用唯一实现，组件只订阅，不再自己挂 window 监听 */
export function useWheelZoom(onZoom: (delta: 1 | -1) => void): void {
  const cb = useRef(onZoom);
  cb.current = onZoom;
  useEffect(() => {
    const h = (d: 1 | -1) => cb.current(d);
    zoomSubs.add(h);
    return () => void zoomSubs.delete(h);
  }, []);
}

/* ------------------------------ 手势会话 ------------------------------ */

interface Gesture {
  host: HTMLElement | null;
  kind: ScrollKind;
  lastAt: number;
}
const gesture: Gesture = { host: null, kind: "other", lastAt: 0 };
/** 手势活跃窗口：只用于「要不要自动跟随」这类礼貌判断，不用于判定事件因果 */
const GESTURE_QUIET_MS = 250;

function noteGesture(host: HTMLElement | null): void {
  gesture.host = host;
  gesture.kind = (host?.dataset.scrollKind as ScrollKind | undefined) ?? "other";
  gesture.lastAt = Date.now();
}

/**
 * 用户是否正在操作某个滚动域。
 * 传 el 时要求手势就发生在该容器上；不传则问「全局有没有活跃手势」。
 */
export function isGestureActive(el?: HTMLElement | null): boolean {
  if (Date.now() - gesture.lastAt >= GESTURE_QUIET_MS) return false;
  return el ? gesture.host === el : true;
}

/* ------------------------------ 弹层所有权 ------------------------------ */

interface OverlayMask {
  kind: "modal" | "lightbox";
  panel: HTMLElement;
  id: number;
}
const masks: OverlayMask[] = [];
let maskSeq = 0;

/**
 * 注册弹层。顶层弹层存在时：
 *   - 滚轮落在面板内 → 放行（面板内部容器自己 overscroll-behavior: contain）
 *   - 滚轮落在面板外（遮罩空白）→ 吞掉，绝不穿透到背景阅读区
 * 比 W7 的 `stopWheel(mask, allow)` 干净：不再需要 allow 白名单，
 * 也不会因为漏配 allow 把弹层里的列表一起锁死。
 */
export function registerOverlayMask(
  panel: HTMLElement,
  kind: "modal" | "lightbox" = "modal",
): () => void {
  const rec: OverlayMask = { kind, panel, id: ++maskSeq };
  masks.push(rec);
  return () => {
    const at = masks.indexOf(rec);
    if (at >= 0) masks.splice(at, 1);
  };
}

/* ------------------------------ 全局 wheel ------------------------------ */

function hostOf(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  return el?.closest<HTMLElement>("[data-scroll-kind]") ?? null;
}

function onGlobalWheel(e: WheelEvent): void {
  stats.wheelEvents++;
  const node = e.target instanceof Node ? e.target : null;
  const el = node instanceof Element ? (node as Element) : null;
  const host = hostOf(node);
  noteGesture(host);

  // 1) Ctrl+滚轮缩放：优先级最高，屏蔽 WebView 整页缩放。
  //    不再排除编辑器/输入框——编辑器里按 Ctrl+滚轮同样该缩放。
  if (e.ctrlKey) {
    if (el?.closest("[data-no-zoom]")) return;
    e.preventDefault();
    e.stopPropagation();
    stats.zoomEvents++;
    for (const fn of zoomSubs) fn(e.deltaY < 0 ? 1 : -1);
    return;
  }

  // 2) 顶层弹层所有权：面板外一律吞掉，面板内放行。
  const top = masks.length ? masks[masks.length - 1]! : null;
  if (top && el && !top.panel.contains(el)) {
    e.preventDefault();
    e.stopPropagation();
    stats.blockedByOverlay++;
    return; // 背景不该收到这次滚轮，也不派发 userWheel
  }

  // 3) 明确声明「吞掉普通滚轮」的控件（数字输入框等，防止滚轮静默改值）
  if (el?.closest('[data-wheel="swallow"]')) {
    e.preventDefault();
    stats.swallowedWheel++;
    return;
  }

  // 4) 纵向滚轮 → 横向滚动（标签条）。滚到头即让出，不锁死父级。
  const hEl = el?.closest<HTMLElement>('[data-wheel="horizontal"]') ?? null;
  if (hEl && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    const max = hEl.scrollWidth - hEl.clientWidth;
    if (max > 1) {
      const goingUp = e.deltaY < 0;
      if (!(goingUp ? hEl.scrollLeft <= 0 : hEl.scrollLeft >= max - 1)) {
        e.preventDefault();
        // deltaMode：0=像素、1=行、2=页。滚轮驱动（尤其部分鼠标/驱动）会报行模式，
        // 直接拿 deltaY(≈3) 当像素加，标签条几乎不动 —— 必须换算成像素。
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? hEl.clientWidth : 1;
        const step = e.deltaY * unit;
        // 这里是「用户输入的直通执行」而非程序化位置修正：写完派发的 scroll
        // 由仲裁器判为用户滚动（会触发菜单关闭等真实用户语义），故不申报。
        hEl.scrollLeft = Math.max(0, Math.min(max, hEl.scrollLeft + step));
        stats.horizontalWheel++;
        noteGesture(hEl);
        for (const fn of userWheelSubs) fn(e, hEl);
        return;
      }
    }
  }

  // 5) 普通滚轮：什么都不做。不 preventDefault、不 stopPropagation，
  //    完全交给浏览器原生滚动。这是「滚轮不打架」最重要的一条。
  for (const fn of userWheelSubs) fn(e, host);
}

/* ------------------------------ 全局 scroll ------------------------------ */

function onGlobalScrollCapture(e: Event): void {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return; // document/window 滚动不归我们管
  // 标签条是横向滚动容器，按 x 轴分类，避免把横滚误记成纵向用户滚动。
  const axis: "y" | "x" = el.dataset.wheel === "horizontal" ? "x" : "y";
  const origin = classifyScroll(el, axis);
  const subs = origin.programmatic ? programScrollSubs : userScrollSubs;
  for (const fn of subs) fn(origin);
}

const SCROLL_KEYS = new Set([
  "ArrowUp", "ArrowDown", "PageUp", "PageDown",
  "Home", "End", " ", "Spacebar",
]);

function onGestureKey(e: KeyboardEvent): void {
  if (!SCROLL_KEYS.has(e.key)) return;
  const active = document.activeElement;
  noteGesture(active instanceof HTMLElement ? hostOf(active) : null);
}

function onGesturePointer(e: PointerEvent): void {
  noteGesture(hostOf(e.target instanceof Node ? e.target : null));
}

let installed = false;
function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("wheel", onGlobalWheel, { capture: true, passive: false });
  // scroll 事件不冒泡，但捕获阶段会经过 document —— 这一条能收到所有元素的滚动。
  document.addEventListener("scroll", onGlobalScrollCapture, { capture: true, passive: true });
  document.addEventListener("keydown", onGestureKey, { capture: true, passive: true });
  document.addEventListener("pointerdown", onGesturePointer, { capture: true, passive: true });
}
install();

/* -------------------------------------------------------------------------- */
/* 焦点与键盘滚动                                                              */
/* -------------------------------------------------------------------------- */

/** 可聚焦元素选择器（Modal 焦点陷阱用） */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 让滚动容器可获得键盘焦点（PageDown / 空格 / ↑↓ 是滚动容器的原生能力） */
export function focusScroller(el: HTMLElement | null): void {
  if (!el) return;
  if (document.activeElement === el) return;
  el.focus({ preventScroll: true });
}

/* -------------------------------------------------------------------------- */
/* 无头回归只读快照                                                             */
/* -------------------------------------------------------------------------- */

declare global {
  interface Window {
    __mjArbiter?: {
      snapshot(): Record<string, number | string | null>;
      reset(): void;
    };
  }
}

if (typeof window !== "undefined") {
  window.__mjArbiter = {
    snapshot: () => ({
      ...stats,
      pending: Array.from(pending.values()).reduce(
        (n, s) => n + (s.y ? 1 : 0) + (s.x ? 1 : 0),
        0,
      ),
      overlay: masks.length ? masks[masks.length - 1]!.kind : null,
      gestureKind: gesture.kind,
      gestureAgeMs: Date.now() - gesture.lastAt,
    }),
    reset: () => {
      for (const k of Object.keys(stats) as Array<keyof typeof stats>) stats[k] = 0;
    },
  };
}
