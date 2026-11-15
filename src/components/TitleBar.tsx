/**
 * 无边框窗口自绘标题栏（W1 骨架）：
 * - 拖拽区：data-tauri-drag-region（tauri core 原生支持）
 * - 三键：Win11 记事本样式（46px 宽满高，关闭键悬停红底白叉）
 * - 后续 W4 会往 drag-region 里加标签条/工具按钮
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

/** 是否运行在 Tauri 窗口内（纯浏览器预览时无窗口 API，按钮需要降级） */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 取当前窗口；浏览器预览返回 null，避免 getCurrentWindow 直接抛错 */
function currentWin() {
  return inTauri ? getCurrentWindow() : null;
}

function WinIcon({ kind }: { kind: "min" | "max" | "close" }) {
  if (kind === "min") return <svg viewBox="0 0 12 12"><path d="M1 6h10" stroke="currentColor" strokeWidth="1.2" /></svg>;
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
  return (
    <div className="titlebar">
      <div className="drag-region" data-tauri-drag-region>
        <span className="app-title" data-tauri-drag-region>{title}</span>
      </div>
      <div className="window-buttons">
        <button title="最小化" onClick={() => win?.minimize()}>
          <WinIcon kind="min" />
        </button>
        <button title="最大化 / 还原" onClick={() => win?.toggleMaximize()}>
          <WinIcon kind="max" />
        </button>
        <button className="close" title="关闭" onClick={() => win?.close()}>
          <WinIcon kind="close" />
        </button>
      </div>
    </div>
  );
}
