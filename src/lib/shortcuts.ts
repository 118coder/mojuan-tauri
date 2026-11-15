/**
 * 全局快捷键系统（W4b，映射表见调研报告第 5 节 P0 全集）
 * ---------------------------------------------------------------------------
 * - window keydown 统一分发；已被组件处理过的事件（defaultPrevented，如
 *   CodeMirror 内部 Ctrl+S/F）不再重复处理。
 * - 焦点在输入框/编辑器时跳过与输入冲突的组合（Ctrl+F 让给 CodeMirror 内置
 *   查找面板，否则编辑区里 Ctrl+F 会被全局抢走、什么都不发生）。
 * - 滚轮缩放已迁到 lib/interaction.ts 的 useWheelZoom（全局 wheel 由仲裁器
 *   在捕获阶段统一分发），本文件只处理键盘，避免同一事件被两处争抢。
 */

import { useEffect, useRef } from "preact/hooks";

export interface ShortcutHandlers {
  /** Ctrl+O 打开文件 */
  onOpenFile(): void;
  /** Ctrl+N 新建文件 */
  onNewFile(): void;
  /** Ctrl+S 保存 */
  onSave(): void;
  /** Ctrl+W 关闭当前标签 */
  onCloseTab(): void;
  /** Ctrl+Shift+T 重新打开刚关闭的标签 */
  onReopenTab(): void;
  /** Ctrl+Tab / Ctrl+Shift+Tab 切换标签 */
  onCycleTab(dir: 1 | -1): void;
  /** Ctrl+E 阅读分屏编辑循环切换 */
  onCycleMode(): void;
  /** F8 极简模式 */
  onToggleMinimal(): void;
  /** F11 全屏 */
  onToggleFullscreen(): void;
  /** Ctrl+G 跳转到行/位置 */
  onGoto(): void;
  /** Ctrl+P 命令面板 / 快速切换器 */
  onPalette(): void;
  /** Ctrl+F 页内查找（阅读区） */
  onFind(): void;
  /** F3 / Shift+F3 查找下一个/上一个 */
  onFindNav(dir: 1 | -1): void;
  /** Ctrl+- / Ctrl+= 缩放；delta 为 +1 / -1（按次） */
  onZoom(delta: 1 | -1): void;
  /** Ctrl+0 复位缩放 */
  onZoomReset(): void;
  /** Alt+←/→ 导航历史 */
  onNavBack(): void;
  onNavForward(): void;
  /** Ctrl+, 设置 */
  onOpenSettings(): void;
  /** Ctrl+\ / Ctrl+Shift+L 切换侧栏 */
  onToggleSidebar(): void;
  /** Esc（仅在无对话框/查找条消费时触发：退出极简模式） */
  onEscape(): void;
}

/** 目标是否是文本输入类元素（编辑器内容、输入框） */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  return target.isContentEditable || target.closest(".cm-content") != null;
}

export function useGlobalShortcuts(handlers: ShortcutHandlers): void {
  // 回调统一走 ref，监听器只注册一次，避免每次渲染重挂
  const h = useRef(handlers);
  h.current = handlers;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // CodeMirror / 组件内部已处理的事件（已 preventDefault）不重复分发
      if (e.defaultPrevented) return;

      const key = e.key;
      const mod = e.ctrlKey || e.metaKey;
      const editable = isEditableTarget(e.target);

      // ---------- 组合键 ----------
      if (mod) {
        const lower = key.length === 1 ? key.toLowerCase() : key;
        switch (lower) {
          case "o":
            e.preventDefault();
            h.current.onOpenFile();
            return;
          case "n":
            if (e.shiftKey) return; // Ctrl+Shift+N 新窗口：本次不做
            e.preventDefault();
            h.current.onNewFile();
            return;
          case "s":
            e.preventDefault();
            h.current.onSave();
            return;
          case "w":
            e.preventDefault();
            h.current.onCloseTab();
            return;
          case "t":
            // Ctrl+Shift+T：重开最近关闭的标签（浏览器/Win11 通用）
            if (e.shiftKey) {
              e.preventDefault();
              h.current.onReopenTab();
            }
            return;
          case "Tab":
            e.preventDefault();
            h.current.onCycleTab(e.shiftKey ? -1 : 1);
            return;
          case "e":
            e.preventDefault();
            h.current.onCycleMode();
            return;
          case "g":
            e.preventDefault();
            h.current.onGoto();
            return;
          case "p":
            e.preventDefault();
            h.current.onPalette();
            return;
          case "f":
            // 焦点在编辑器/输入框里：让给 CodeMirror 自带的查找面板。
            // 旧实现无条件 preventDefault 再调 onFind，而 onFind 在非阅读模式下
            // 直接 return —— 结果就是「编辑区按 Ctrl+F 毫无反应」。
            if (editable) return;
            e.preventDefault();
            h.current.onFind();
            return;
          case "0":
            e.preventDefault();
            h.current.onZoomReset();
            return;
          case "=":
          case "+":
            e.preventDefault();
            h.current.onZoom(1);
            return;
          case "-":
            e.preventDefault();
            h.current.onZoom(-1);
            return;
          case ",":
            e.preventDefault();
            h.current.onOpenSettings();
            return;
          case "\\":
            e.preventDefault();
            h.current.onToggleSidebar();
            return;
          case "l":
            // Ctrl+Shift+L：切换侧栏（旧代码写成 "L"，但 key 已被 lower 化，永远命中不了）
            if (e.shiftKey) {
              e.preventDefault();
              h.current.onToggleSidebar();
            }
            return;
          default:
            return;
        }
      }

      // ---------- 功能键 ----------
      if (key === "F8") {
        e.preventDefault();
        h.current.onToggleMinimal();
        return;
      }
      if (key === "F11") {
        e.preventDefault();
        h.current.onToggleFullscreen();
        return;
      }
      if (key === "F3") {
        e.preventDefault();
        h.current.onFindNav(e.shiftKey ? -1 : 1);
        return;
      }

      // ---------- Alt+←/→ 导航历史 ----------
      if (e.altKey && key === "ArrowLeft") {
        e.preventDefault();
        h.current.onNavBack();
        return;
      }
      if (e.altKey && key === "ArrowRight") {
        e.preventDefault();
        h.current.onNavForward();
        return;
      }

      // ---------- Esc：对话框/查找条在自己的 onKeyDown 里 stopPropagation，
      // 走到这里说明没有浮层消费，用于退出极简模式 ----------
      if (key === "Escape" && !editable) {
        h.current.onEscape();
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
