/**
 * 命令面板 / 快速切换器（W4b 任务书第 9 条，调研 P1 第 5/9 条）
 * ---------------------------------------------------------------------------
 * - Ctrl+P 呼出：上半区命令清单，下半区文件模糊搜索（search_filenames）。
 * - ↑↓ 选择、Enter 执行、Esc 关闭（Esc/Tab/焦点陷阱由 Modal 统一处理）。
 * - 模糊匹配：子序列 + 连续命中加分（前端本地过滤，结果已由后端粗排）。
 *
 * W7 改动（滚轮冲突修复的主战场之一）：
 *  - 遮罩上原来的 `onWheel={onClose}` 已删除。它让 `.pal-list`（max-height
 *    46vh 的滚动区）完全无法用滚轮浏览——滚一格面板就消失，用户感受就是
 *    「面板里的列表滚不动」。现在滚轮只滚列表，关闭靠点外 / Esc。
 *  - 套上统一 Modal：点外只在按下点就在遮罩上时才关，拖选不误关；焦点锁在面板内。
 *  - 空查询时把最近用过的命令排前面（Windows 开始菜单的做法），第二次调用快得多。
 */

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../lib/backend";
import { claimScroll } from "../lib/interaction";
import { Modal } from "./Modal";

export interface PaletteCommand {
  id: string;
  title: string;
  shortcut?: string;
  run(): void;
}

export interface PaletteProps {
  open: boolean;
  onClose(): void;
  /** 工作区根（null 时只显示命令区） */
  root: string | null;
  commands: PaletteCommand[];
  onOpenFile(path: string): void;
}

/** 最近执行过的命令 id（模块级：面板反复开关也记得住） */
const recentCmds: string[] = [];
const RECENT_MAX = 6;

/** 子序列模糊匹配打分：命中返回分数，未命中返回 0 */
function fuzzy(query: string, target: string): number {
  if (!query) return 0.1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 200 - direct;
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return 0;
    streak = idx === ti ? streak + 1 : 0;
    score += 1 + streak;
    ti = idx + 1;
  }
  return score;
}

interface Row {
  kind: "cmd" | "file";
  key: string;
  title: string;
  hint?: string;
  score: number;
  /** 命令在清单里的原始序（空查询未命中"最近使用"时按它排） */
  order?: number;
  run(): void;
}

export function Palette(props: PaletteProps) {
  const { open, onClose, root, commands, onOpenFile } = props;
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [files, setFiles] = useState<{ path: string; name: string }[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 打开时重置并拉取文件名索引
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSel(0);
    setFiles([]);
    inputRef.current?.focus();
    if (!root) return;
    let cancelled = false;
    void api
      .searchFilenames(root, "", 500)
      .then((hits) => {
        if (cancelled) return;
        setFiles(hits.map((h) => ({ path: h.path, name: h.text || h.path })));
      })
      .catch(() => void 0);
    return () => {
      cancelled = true;
    };
  }, [open, root]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim();
    const cmdRows: Row[] = commands
      .map((c, i) => ({
        kind: "cmd" as const,
        key: c.id,
        title: c.title,
        hint: c.shortcut,
        score: fuzzy(q, c.title),
        order: i,
        run: c.run,
      }))
      .filter((r) => r.score > 0)
      // 空查询：最近用过的排前面，其余保持清单原序
      .sort((a, b) => {
        if (q) return 0;
        const ra = recentCmds.indexOf(a.key);
        const rb = recentCmds.indexOf(b.key);
        if (ra >= 0 || rb >= 0) {
          if (ra < 0) return 1;
          if (rb < 0) return -1;
          return ra - rb;
        }
        return (a.order ?? 0) - (b.order ?? 0);
      });
    const fileRows: Row[] = files
      .map((f) => ({
        kind: "file" as const,
        key: f.path,
        title: f.name,
        hint: f.path,
        score: fuzzy(q, f.name) * 1.1,
        run: () => onOpenFile(f.path),
      }))
      .filter((r) => r.score > 0 && (!q || r.score > 0.1));
    const all = [...cmdRows, ...fileRows];
    if (q) all.sort((a, b) => b.score - a.score);
    return all.slice(0, 60);
  }, [query, commands, files, onOpenFile]);

  useEffect(() => {
    setSel((prev) => (prev >= rows.length ? 0 : prev));
  }, [rows]);

  // 选中项跟随键盘滚动（nearest：不把整列表拽到顶部）。
  // scrollIntoView 的落点由浏览器算，事后 claimScroll 补申报，避免被误判成用户滚动。
  useEffect(() => {
    if (!open) return;
    const listEl = listRef.current;
    const before = listEl?.scrollTop ?? 0;
    const el = listEl?.querySelector(".pal-row.sel");
    el?.scrollIntoView({ block: "nearest" });
    if (listEl) claimScroll(listEl, before, "jump");
  }, [sel, rows, open]);

  const exec = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "cmd") {
      const at = recentCmds.indexOf(row.key);
      if (at >= 0) recentCmds.splice(at, 1);
      recentCmds.unshift(row.key);
      if (recentCmds.length > RECENT_MAX) recentCmds.length = RECENT_MAX;
    }
    onClose();
    row.run();
  };

  return (
    <Modal
      open={open}
      panelClass="palette"
      label="命令面板"
      initialFocus=".pal-input"
      onClose={onClose}
      maskClass="mask-top"
      testId="palette"
    >
      <input
        ref={inputRef}
        class="pal-input"
        type="text"
        placeholder="输入命令或文件名（↑↓ 选择，Enter 执行，Esc 关闭）"
        value={query}
        onInput={(e) => {
          setQuery((e.currentTarget as HTMLInputElement).value);
          setSel(0);
        }}
        onKeyDown={(e: KeyboardEvent) => {
          // 面板内的键不上送全局（Esc/Tab 已由 Modal 在捕获阶段处理）
          e.stopPropagation();
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((p) => Math.min(Math.max(0, rows.length - 1), p + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((p) => Math.max(0, p - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            exec(rows[sel]);
          }
        }}
      />
      <div class="pal-list" ref={listRef} data-scroll-kind="modal">
        {rows.length === 0 && (
          <div class="pal-empty">{query.trim() ? `没有匹配「${query.trim()}」的命令或文件` : "没有可用命令"}</div>
        )}
        {rows.map((r, i) => (
          <div
            key={r.kind + r.key}
            class={"pal-row" + (i === sel ? " sel" : "")}
            data-kind={r.kind}
            onMouseEnter={() => setSel(i)}
            onClick={() => exec(r)}
          >
            <span class="pal-title">{r.title}</span>
            <span class="pal-hint">{r.hint}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
