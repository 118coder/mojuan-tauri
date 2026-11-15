/**
 * 统一弹层外壳（W7）
 * ---------------------------------------------------------------------------
 * 命令面板 / 设置 / 通用输入框 / 图片放大 都套这一层，一次解决四类老问题：
 *
 *  1. 滚轮：遮罩**不再**用 wheel 关闭弹层（那是「列表滚一格就消失」的根因）；
 *     W8 起把面板注册给中央仲裁器（registerOverlayMask）：滚轮落在面板内
 *     一律放行，落在面板外才吞掉，绝不穿透背景阅读区。组件不再自己挂
 *     wheel 监听，也不再需要 allow 白名单。内部容器自带 contain。
 *  2. 点外关闭：改用 pointerdown 且**只有点在遮罩本身**才关——旧写法
 *     `onMouseDown={onClose}` 在弹层里拖选文字、松手落到外面时会误关。
 *  3. 键盘：Esc 只关最上层（多弹层叠加不会一次全关）；Tab 焦点锁在弹层里，
 *     不会跑到背后的按钮上；关闭后焦点回到打开它的元素。
 *  4. 语义：role="dialog" aria-modal="true"，读屏器和 WebView 都认。
 */

import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { FOCUSABLE, registerOverlayMask } from "../lib/interaction";

/** 弹层栈：只有栈顶响应 Esc（模块级，跨组件共享） */
const stack: number[] = [];
let seq = 0;

export interface ModalProps {
  open: boolean;
  /** 遮罩附加类名（沿用 .pal-mask 定位规则） */
  maskClass?: string;
  /** 内容面板类名 */
  panelClass?: string;
  /** 无障碍名称 */
  label?: string;
  /** 点遮罩是否关闭（默认 true） */
  maskClose?: boolean;
  /** Esc 是否关闭（默认 true） */
  escClose?: boolean;
  /** 打开时聚焦哪个元素（缺省第一个可聚焦元素） */
  initialFocus?: string;
  /** data-testid（沿用各弹层原有的测试锚点） */
  testId?: string;
  onClose(): void;
  children: ComponentChildren;
}

export function Modal(props: ModalProps) {
  const { open, maskClass = "", panelClass = "", label, maskClose = true, escClose = true, onClose } = props;
  const maskRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const idRef = useRef(0);

  // 注册弹层所有权：滚轮落在面板外由仲裁器统一吞掉（不穿透背景），
  // 面板内一律放行。不再用 W7 的 stopWheel(mask, allow) —— 那个写法
  // 必须把每个内部可滚容器都列进 allow，漏一个就把列表锁死。
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    return registerOverlayMask(panel);
  }, [open]);

  // 栈管理 + Esc + 焦点陷阱 + 焦点归还
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    const id = ++seq;
    idRef.current = id;
    stack.push(id);

    // 记录打开前的焦点，关闭时还回去
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // 初始焦点：优先 initialFocus 选择器，其次第一个可聚焦元素，最后面板本身
    const first = props.initialFocus
      ? panel.querySelector<HTMLElement>(props.initialFocus)
      : panel.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel).focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent): void => {
      // 只处理栈顶
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape" && escClose) {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      // 焦点陷阱：Tab 到边界时回卷
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      const active = document.activeElement;
      if (!e.shiftKey && active === lastEl) {
        e.preventDefault();
        firstEl.focus();
      } else if (e.shiftKey && (active === firstEl || active === panel)) {
        e.preventDefault();
        lastEl.focus();
      }
    };

    // 捕获阶段：抢在全局快捷键之前吃 Esc/Tab，避免「关弹层顺手退出极简模式」
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      const at = stack.lastIndexOf(id);
      if (at >= 0) stack.splice(at, 1);
      // 焦点归还（元素还在 DOM 里才还，避免还给已卸载节点）
      if (prevFocus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
    };
    // initialFocus 只在打开瞬间取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div
      class={"pal-mask" + (maskClass ? " " + maskClass : "")}
      ref={maskRef}
      role="presentation"
      onPointerDown={(e: PointerEvent) => {
        // 只有「按下点就在遮罩上」才算点外：弹层内拖选后松手落到外面不误关
        if (!maskClose) return;
        if (e.target === maskRef.current) onCloseRef.current();
      }}
    >
      <div
        class={panelClass}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-scroll-kind="modal"
        data-testid={props.testId ?? "modal-panel"}
      >
        {props.children}
      </div>
    </div>
  );
}
