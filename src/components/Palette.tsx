/**
 * 命令面板 / 快速切换器（W4b 任务书第 9 条，调研 P1 第 5/9 条）
 * ---------------------------------------------------------------------------
 * - Ctrl+P 呼出：上半区命令清单，下半区文件模糊搜索（search_filenames）。
 * - ↑↓ 选择、Enter 执行、Esc 关闭。
 * - 模糊匹配：子序列 + 连续命中加分（前端本地过滤，结果已由后端粗排）。
 */

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../lib/backend";

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
      .map((c) => ({ kind: "cmd" as const, key: c.id, title: c.title, hint: c.shortcut, score: fuzzy(q, c.title), run: c.run }))
      .filter((r) => r.score > 0);
    const fileRows: Row[] = files
      .map((f) => ({ kind: "file" as const, key: f.path, title: f.name, hint: f.path, score: fuzzy(q, f.name) * 1.1, run: () => onOpenFile(f.path) }))
      .filter((r) => r.score > 0);
    const all = [...cmdRows, ...fileRows].sort((a, b) => b.score - a.score);
    return all.slice(0, 60);
  }, [query, commands, files, onOpenFile]);

  useEffect(() => {
    setSel((prev) => (prev >= rows.length ? 0 : prev));
  }, [rows]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector(".pal-row.sel");
    el?.scrollIntoView({ block: "nearest" });
  }, [sel, rows]);

  if (!open) return null;

  const exec = (row: Row | undefined) => {
    if (!row) return;
    onClose();
    row.run();
  };

  return (
    <div
      class="pal-mask"
      onMouseDown={() => onClose()}
      onWheel={() => onClose()}
      onKeyDown={(e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          onClose();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          setSel((p) => Math.min(rows.length - 1, p + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setSel((p) => Math.max(0, p - 1));
        } else if (e.key === "Enter") {
          e.preventDefault();
          exec(rows[sel]);
        }
      }}
    >
      <div class="palette" onMouseDown={(e: MouseEvent) => e.stopPropagation()} data-testid="palette">
        <input
          ref={inputRef}
          class="pal-input"
          type="text"
          placeholder="输入命令或文件名（↑↓ 选择，Enter 执行，Esc 关闭）"
          value={query}
          onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
        />
        <div class="pal-list" ref={listRef}>
          {rows.length === 0 && <div class="pal-empty">没有匹配项</div>}
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
      </div>
    </div>
  );
}
