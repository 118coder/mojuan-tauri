/**
 * 导出菜单（W6a）
 * ---------------------------------------------------------------------------
 * 导出功能的 UI 挂接层，三种用法：
 *  1. buildExportMenuItems(deps)：产出 4 个 CtxMenuItem（导出为 HTML / Word /
 *     PDF / 长图 PNG），App 直接塞进阅读区右键菜单的 items（受控模式）；
 *  2. Palette：App 用同一份定义追加 4 条命令（id export-*）；
 *  3. <ExportMenu />：独立的下拉菜单组件（触发按钮 + 弹出列表），供后续
 *     工具栏使用与无头测试「四项渲染」断言。
 *
 * 成功/失败都 toast（deps.toast 缺省用内置 fixed 提示条，样式复用
 * theme.css 的 .toast-float）；用户取消（保存对话框 Esc）不提示。
 */

import { useEffect, useRef, useState } from "preact/hooks";
import type { CtxMenuItem } from "./ContextMenu";
import {
  exportDocx,
  exportHtml,
  exportPdf,
  exportPng,
} from "../lib/exporters";
import type { ExportDeps, ExportResult, ExportTabInfo } from "../lib/exporters";

/* -------------------------------------------------------------------------- */
/* 菜单项定义                                                                  */
/* -------------------------------------------------------------------------- */

export type ExportKind = "html" | "docx" | "pdf" | "png";

/** 四个导出项（右键菜单 / Palette / 组件共用同一份定义） */
export const EXPORT_ITEMS: { kind: ExportKind; label: string; paletteTitle: string }[] = [
  { kind: "html", label: "导出为 HTML…", paletteTitle: "导出为 HTML…" },
  { kind: "docx", label: "导出为 Word（docx）…", paletteTitle: "导出为 Word（docx）…" },
  { kind: "pdf", label: "导出为 PDF（打印）…", paletteTitle: "导出为 PDF（打印）…" },
  { kind: "png", label: "导出为长图（PNG）…", paletteTitle: "导出为长图 PNG…" },
];

/** 导出菜单依赖：宿主提供 toast / 确认框 / 进度条等（缺省用内置实现） */
export interface ExportMenuDeps extends ExportDeps {
  /** 结果提示（App 传状态栏 toast；缺省用内置 fixed 提示条） */
  toast?: (msg: string) => void;
}

/** 内置提示条：复用 .toast-float 样式，2.6s 自动消失 */
function fallbackToast(msg: string): void {
  if (typeof document === "undefined") return;
  const el = document.createElement("div");
  el.className = "toast-float";
  el.setAttribute("data-mj-export-toast", "");
  el.textContent = msg;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 2600);
}

/** 取标签导出信息（App 传 ws.activeTab 的映射；null = 无可导出文档） */
export type ExportTabGetter = () => ExportTabInfo | null;

/** 执行一个导出动作：统一成功/失败/取消的提示语义 */
export async function runExport(kind: ExportKind, getTab: ExportTabGetter, deps: ExportMenuDeps = {}): Promise<void> {
  const toast = deps.toast ?? fallbackToast;
  const tab = getTab();
  if (!tab) {
    toast("没有可导出的文档（请先打开文档）");
    return;
  }
  let result: ExportResult;
  try {
    switch (kind) {
      case "html":
        result = await exportHtml(tab, deps);
        break;
      case "docx":
        result = await exportDocx(tab, deps);
        break;
      case "pdf":
        result = await exportPdf(tab, deps);
        break;
      case "png":
        result = await exportPng(tab, deps);
        break;
      default:
        return;
    }
    if (result.ok) toast(result.message);
    // 用户取消：静默
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

/**
 * 右键菜单导出分组：4 个 CtxMenuItem（不含分组前的分隔线，由调用方控制）。
 * App 在 readerMenu 里 `items.push({ separator: true }); items.push(...buildExportMenuItems(deps))`。
 */
export function buildExportMenuItems(getTab: ExportTabGetter, deps: ExportMenuDeps = {}): CtxMenuItem[] {
  return EXPORT_ITEMS.map(({ kind, label }) => ({
    label,
    action: () => void runExport(kind, getTab, deps),
  }));
}

/* -------------------------------------------------------------------------- */
/* 独立下拉菜单组件（触发按钮 + 弹出列表；右键菜单/Palette 之外的第二形态）       */
/* -------------------------------------------------------------------------- */

export interface ExportMenuProps {
  getTab: ExportTabGetter;
  deps?: ExportMenuDeps;
  /** 无可导出文档时触发按钮置灰（缺省自动按 getTab() 判定） */
  disabled?: boolean;
}

export function ExportMenu(props: ExportMenuProps) {
  const { getTab, deps, disabled } = props;
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    setPos(r ? { x: r.left, y: r.bottom + 4 } : { x: 16, y: 16 });
    setOpen(true);
  };

  // 打开期间：点外部 / Esc 关闭（与 ContextMenu 行为一致）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isDisabled = disabled ?? getTab() == null;

  return (
    <>
      <button
        ref={btnRef}
        class="ghost export-btn"
        data-testid="export-menu-trigger"
        disabled={isDisabled}
        onClick={toggle}
        title="导出当前文档"
      >
        导出
      </button>
      {open && pos && (
        <div
          ref={menuRef}
          class="ctx-menu"
          data-testid="export-menu"
          style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
        >
          {EXPORT_ITEMS.map(({ kind, label }) => (
            <button
              key={kind}
              class="menu-item"
              data-export-kind={kind}
              onClick={() => {
                setOpen(false);
                void runExport(kind, getTab, deps);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
