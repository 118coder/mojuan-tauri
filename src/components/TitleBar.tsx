/**
 * 无边框窗口自绘标题栏（W1 骨架）：
 * - 拖拽区：data-tauri-drag-region（tauri core 原生支持）
 * - 三键：Win11 记事本样式（46px 宽满高，关闭键悬停红底白叉）
 * - 后续 W4 会往 drag-region 里加标签条/工具按钮
 *
 * W7 改动：
 *  - 最大化按钮的图标跟随真实窗口状态（旧版永远是「放大」图标，
 *    最大化之后用户看不出还能不能还原）；
 *  - 三键补 aria-label（图标按钮没有文字，读屏器全靠它）；
 *  - 双击拖拽区最大化 / 还原（Win11 原生手感，旧版只有按钮能干这事）。
 */

import { useEffect, useState } from "preact/hooks";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** 是否运行在 Tauri 窗口内（纯浏览器预览时无窗口 API，按钮需要降级） */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 取当前窗口；浏览器预览返回 null，避免 getCurrentWindow 直接抛错 */
function currentWin() {
  return inTauri ? getCurrentWindow() : null;
}

function WinIcon({ kind }: { kind: "min" | "max" | "restore" | "close" }) {
  if (kind === "min") return <svg viewBox="0 0 12 12"><path d="M1 6h10" stroke="currentColor" strokeWidth="1.2" /></svg>;
  if (kind === "restore")
    return (
      <svg viewBox="0 0 12 12">
        <rect x="1.5" y="3.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path d="M3.8 3.2V1.5h6.7v6.7H8.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  if (kind === "max")
    return (
      <svg viewBox="0 0 12 12">
        <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  return (
    <svg viewBox="0 0 12 12">
      <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function TitleBar({ title }: { title: string }) {
  const win = currentWin();
  const [maximized, setMaximized] = useState(false);

  // 跟随真实窗口状态（拖动边缘缩放、Win+↑、任务栏操作都会改最大化状态）
  useEffect(() => {
    if (!win) return;
    let un: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const v = await win.isMaximized();
        if (!cancelled) setMaximized(v);
        un = await win.onResized(async () => {
          try {
            const m = await win.isMaximized();
            setMaximized((prev) => (prev === m ? prev : m));
          } catch {
            /* 忽略 */
          }
        });
      } catch {
        /* 忽略 */
      }
    })();
    return () => {
      cancelled = true;
      un?.();
    };
  }, [win]);

  return (
    <div className="titlebar">
      <div
        className="drag-region"
        data-tauri-drag-region
        onDblClick={() => void win?.toggleMaximize()}
      >
        <span className="app-title" data-tauri-drag-region>{title}</span>
      </div>
      <div className="window-buttons">
        <button title="最小化" aria-label="最小化" onClick={() => void win?.minimize()}>
          <WinIcon kind="min" />
        </button>
        <button
          title={maximized ? "向下还原" : "最大化"}
          aria-label={maximized ? "向下还原" : "最大化"}
          onClick={() => void win?.toggleMaximize()}
        >
          <WinIcon kind={maximized ? "restore" : "max"} />
        </button>
        <button className="close" title="关闭" aria-label="关闭窗口" onClick={() => void win?.close()}>
          <WinIcon kind="close" />
        </button>
      </div>
    </div>
  );
}
