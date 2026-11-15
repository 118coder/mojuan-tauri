/**
 * 设置对话框（W4b 任务书第 6 条 / 调研 P1 第 2 条）
 * ---------------------------------------------------------------------------
 * - 主题：亮 / 暗 / 跟随系统（写 html[data-theme] + localStorage 镜像）；
 * - 字号 12~32、行距 1.2/1.5/1.75/2.0、页宽 42em~60em（居中上限）；
 * - 自动保存开关（3s 节流由 App 层实现）；
 * - 加载演示文档按钮；
 * - 持久化：save_state 合并写（App 层），关闭时立即落库。
 */

import type { AppInfo, AppState } from "../lib/backend";

export interface SettingsDialogProps {
  open: boolean;
  settings: AppState;
  onPatch(p: Partial<AppState>): void;
  onClose(): void;
  onLoadDemo(): void;
  appInfo: AppInfo | null;
  onOpenWorkspace(): void;
}

const LINE_SPACINGS = [1.2, 1.5, 1.75, 2.0];
/** 页宽（em）选项；AppState.measure 存 px = em × 字号，换算见 App */
const MEASURE_EM = [42, 46, 52, 56, 60];

function currentMeasureEm(settings: AppState): number {
  return Math.round((settings.measure / Math.max(12, settings.font_size)) * 10) / 10;
}

export function SettingsDialog(props: SettingsDialogProps) {
  const { open, settings, onPatch, onClose, onLoadDemo, appInfo, onOpenWorkspace } = props;
  if (!open) return null;

  const em = currentMeasureEm(settings);
  const nearestEm = MEASURE_EM.reduce((a, b) => (Math.abs(b - em) < Math.abs(a - em) ? b : a));

  return (
    <div
      class="pal-mask"
      onMouseDown={onClose}
      onWheel={onClose}
      onKeyDown={(e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        class="settings-dialog"
        onMouseDown={(e: MouseEvent) => e.stopPropagation()}
        data-testid="settings-dialog"
      >
        <div class="dlg-head">
          <span>设置</span>
          <button class="side-btn" title="关闭 (Esc)" onClick={onClose}>
            ✕
          </button>
        </div>

        <div class="dlg-body">
          <div class="dlg-row">
            <label class="dlg-label">主题</label>
            <div class="seg">
              {(["light", "dark", "auto"] as const).map((t) => (
                <button
                  key={t}
                  class={"seg-btn" + (settings.theme === t ? " on" : "")}
                  data-theme-choice={t}
                  onClick={() => onPatch({ theme: t })}
                >
                  {t === "light" ? "亮色" : t === "dark" ? "暗色" : "跟随系统"}
                </button>
              ))}
            </div>
          </div>

          <div class="dlg-row">
            <label class="dlg-label">字号（px）</label>
            <div class="dlg-value">
              <button class="side-btn" onClick={() => onPatch({ font_size: Math.max(12, settings.font_size - 1) })}>
                −
              </button>
              <input
                class="dlg-number"
                type="number"
                min={12}
                max={32}
                value={settings.font_size}
                onKeyDown={(e: KeyboardEvent) => e.stopPropagation()}
                onInput={(e) => {
                  const v = Number((e.currentTarget as HTMLInputElement).value);
                  if (Number.isFinite(v) && v >= 12 && v <= 32) onPatch({ font_size: Math.round(v) });
                }}
              />
              <button class="side-btn" onClick={() => onPatch({ font_size: Math.min(32, settings.font_size + 1) })}>
                ＋
              </button>
            </div>
          </div>

          <div class="dlg-row">
            <label class="dlg-label">行距</label>
            <div class="seg">
              {LINE_SPACINGS.map((v) => (
                <button
                  key={v}
                  class={"seg-btn" + (Math.abs(settings.line_spacing - v) < 0.01 ? " on" : "")}
                  onClick={() => onPatch({ line_spacing: v })}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          <div class="dlg-row">
            <label class="dlg-label">页宽</label>
            <div class="seg">
              {MEASURE_EM.map((v) => (
                <button
                  key={v}
                  class={"seg-btn" + (nearestEm === v ? " on" : "")}
                  data-measure-em={v}
                  onClick={() => onPatch({ measure: Math.round(v * settings.font_size) })}
                >
                  {v}em
                </button>
              ))}
            </div>
          </div>

          <div class="dlg-row">
            <label class="dlg-label">自动保存</label>
            <button
              class={"switch" + (settings.autosave ? " on" : "")}
              role="switch"
              aria-checked={settings.autosave}
              onClick={() => onPatch({ autosave: !settings.autosave })}
            >
              <span class="switch-knob" />
            </button>
          </div>

          <div class="dlg-row">
            <label class="dlg-label">侧栏</label>
            <button
              class={"switch" + (settings.sidebar_open ? " on" : "")}
              role="switch"
              aria-checked={settings.sidebar_open}
              onClick={() => onPatch({ sidebar_open: !settings.sidebar_open })}
            >
              <span class="switch-knob" />
            </button>
          </div>

          <div class="dlg-actions">
            <button class="ghost" onClick={onOpenWorkspace}>
              打开文件夹…
            </button>
            <button class="ghost" data-testid="load-demo" onClick={onLoadDemo}>
              加载演示文档
            </button>
          </div>

          <div class="dlg-about">
            {appInfo ? `墨卷 ${appInfo.version} · ${appInfo.platform} · ${appInfo.data_dir}` : "墨卷"}
          </div>
        </div>
      </div>
    </div>
  );
}
