/**
 * 标签条（W4b 任务书第 2 条）
 * ---------------------------------------------------------------------------
 * - 多开/点切/中键关/右键菜单（菜单内容由 App 统一构建，见 ContextMenuStub）。
 * - 长标题截断（CSS ellipsis），脏标记圆点。
 * - 空白区域作为拖拽区（data-tauri-drag-region），极简模式下承担窗口拖动。
 */

interface TabLike {
  path: string;
  name: string;
  dirty: boolean;
  loading: boolean;
}

export interface TabStripProps {
  tabs: TabLike[];
  activePath: string | null;
  minimal: boolean;
  onActivate(path: string): void;
  onClose(path: string): void;
  /** 右键：App 弹出 关闭/关闭其他/关闭右侧 菜单 */
  onTabContextMenu(e: MouseEvent, path: string): void;
  onOpenSettings(): void;
  onExitMinimal(): void;
}

export function TabStrip(props: TabStripProps) {
  const { tabs, activePath, minimal, onActivate, onClose, onTabContextMenu, onOpenSettings, onExitMinimal } = props;

  return (
    <div class={"tabstrip" + (minimal ? " minimal" : "")}>
      <div class="tabstrip-tabs" data-tauri-drag-region>
        {tabs.map((t) => {
          const active = t.path === activePath;
          return (
            <div
              key={t.path}
              class={"tab" + (active ? " active" : "")}
              title={t.path}
              data-path={t.path}
              data-active={active ? "1" : "0"}
              onClick={() => onActivate(t.path)}
              onMouseDown={(e: MouseEvent) => {
                // 中键（button 1）关闭标签
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(t.path);
                }
              }}
              onContextMenu={(e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                onTabContextMenu(e, t.path);
              }}
            >
              {t.loading ? <span class="tab-spin" /> : t.dirty ? <span class="tab-dirty" title="未保存" /> : null}
              <span class="tab-name">{t.name}</span>
              <button
                class="tab-close"
                title="关闭 (Ctrl+W)"
                onClick={(e: MouseEvent) => {
                  e.stopPropagation();
                  onClose(t.path);
                }}
                onMouseDown={(e: MouseEvent) => e.stopPropagation()}
              >
                <svg viewBox="0 0 12 12">
                  <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.1" fill="none" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
      <div class="tabstrip-spacer" data-tauri-drag-region />
      <div class="tabstrip-actions">
        {minimal && (
          <button class="tabstrip-btn" title="退出极简模式 (Esc)" onClick={onExitMinimal}>
            退出极简
          </button>
        )}
        <button class="tabstrip-btn" title="设置 (Ctrl+,)" onClick={onOpenSettings}>
          <svg viewBox="0 0 16 16" width="14" height="14">
            <circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path
              d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
