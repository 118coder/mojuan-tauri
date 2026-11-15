/**
 * 右键菜单 · 临时 stub（W4b）
 * ---------------------------------------------------------------------------
 * W4a 的 ContextMenu.tsx 已合入，但其【受控模式】当前存在无限渲染循环：
 *   useLayoutEffect 依赖 [effMenu]，受控模式每次渲染都重建 effMenu 对象，
 *   effect 内 setPos({x, y}) 传新对象 → 状态更新 → 重渲染 → 新 effMenu →
 *   再 setPos……菜单一旦弹出页面即永久冻结。
 * 修复方案（改 src/components/ContextMenu.tsx，一行）：
 *   setPos((p) => (p && p.x === x && p.y === y ? p : { x, y }));
 *   （或将 effMenu 的构建 memo 化，保证受控菜单对象引用稳定）
 * 修复合入后，App.tsx 把这里的 import 换回 "./components/ContextMenu" 即可
 * （CtxMenuItem / CtxMenuState 类型两边同形）。
 */

import { useEffect, useRef } from "preact/hooks";

export interface CtxMenuItem {
  label?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  action?: () => void;
  separator?: true;
}

export interface CtxMenuState {
  x: number;
  y: number;
  items: CtxMenuItem[];
}

export interface ContextMenuProps {
  menu: CtxMenuState | null;
  onClose(): void;
}

export function ContextMenu(props: ContextMenuProps) {
  const { menu, onClose } = props;
  const ref = useRef<HTMLDivElement | null>(null);

  // Esc / 点外 / 滚轮关闭（菜单挂载期间生效）
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onWheel = () => onClose();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("wheel", onWheel);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  // 视口内夹紧，避免菜单贴边被裁掉
  const clamp = (v: number, size: number) => Math.max(4, Math.min(v, window.innerHeight - size - 8));
  const estimatedH = Math.min(menu.items.length * 30 + 12, 420);

  return (
    <div
      ref={ref}
      class="ctx-menu"
      style={{
        left: Math.min(menu.x, window.innerWidth - 230) + "px",
        top: clamp(menu.y, estimatedH) + "px",
      }}
      onContextMenu={(e: MouseEvent) => e.preventDefault()}
      onMouseDown={(e: MouseEvent) => e.stopPropagation()}
      onWheel={(e: MouseEvent) => e.stopPropagation()}
      data-testid="ctx-menu"
    >
      {menu.items.map((item, i) =>
        item.separator ? (
          <div class="menu-sep" key={i} />
        ) : (
          <button
            key={i}
            class={"menu-item" + (item.danger ? " danger" : "")}
            disabled={item.disabled}
            onClick={() => {
              item.action?.();
              onClose();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span class="shortcut">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
