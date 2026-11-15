/**
 * 状态栏（W4b 任务书第 6 条 / 调研 P0 第 9 条）
 * ---------------------------------------------------------------------------
 * - 字数（中文字 + 西文单词）/ 字符数；
 * - 滚动百分比：VirtualReader onScrollProgress 上报；点击弹出输入框跳百分比；
 * - 右侧：模式、脏标记、瞬时消息（保存成功等）。
 */

import { useEffect, useRef, useState } from "preact/hooks";

export interface StatusBarProps {
  words: number;
  chars: number;
  /** 0-100 */
  percent: number;
  /** 点击百分比输入后跳转（接受 0-100） */
  onPercentJump(percent: number): void;
  mode: "read" | "split" | "edit";
  dirty: boolean;
  big: boolean;
  message: string | null;
}

const MODE_LABEL: Record<StatusBarProps["mode"], string> = {
  read: "阅读",
  split: "分屏",
  edit: "编辑",
};

export function StatusBar(props: StatusBarProps) {
  const { words, chars, percent, onPercentJump, mode, dirty, big, message } = props;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * Esc 取消标记。
   * 旧实现在 Esc 里 setEditing(false)，紧随其后的 onBlur 又会 commit 一次；
   * 此时 value 已被清空，Number("") === 0 → 进度直接跳到 0%（文档回顶）。
   * 用户按 Esc 想「算了」，结果被扔回开头——典型的输入框失焦陷阱。
   */
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setEditing(false);
      setValue("");
      return;
    }
    const v = value.trim().replace("%", "");
    const n = Number(v);
    // 空输入不跳转（按 Esc / 点空白处退出不应改变阅读位置）
    if (v !== "" && Number.isFinite(n)) onPercentJump(Math.max(0, Math.min(100, n)));
    setEditing(false);
    setValue("");
  };

  return (
    <div class="statusbar" data-testid="statusbar">
      <span class="sb-item" title="字数（中文字符 + 西文单词）">
        {words.toLocaleString()} 字
      </span>
      <span class="sb-item" title="字符数">
        {chars.toLocaleString()} 字符
      </span>
      {big && (
        <span class="sb-item sb-big" title="该文档超过 1MB，经 read_doc_blocks 分块读取">
          分块
        </span>
      )}
      {dirty && (
        <span class="sb-item sb-dirty" title="有未保存修改">
          ● 未保存
        </span>
      )}
      <span class="sb-spacer" />
      {message && <span class="sb-message">{message}</span>}
      <span class="sb-item sb-mode">{MODE_LABEL[mode]}模式</span>
      {editing ? (
        <span class="sb-percent-edit">
          <input
            ref={inputRef}
            value={value}
            placeholder="0-100"
            inputMode="decimal"
            onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e: KeyboardEvent) => {
              e.stopPropagation();
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") {
                e.preventDefault();
                cancelledRef.current = true;
                setEditing(false);
                setValue("");
              }
            }}
            onBlur={commit}
            size={6}
          />
          %
        </span>
      ) : (
        <button
          class="sb-item sb-percent"
          title="点击输入百分比跳转（Ctrl+G 也可）"
          data-testid="sb-percent"
          onClick={() => {
            cancelledRef.current = false;
            setValue("");
            setEditing(true);
          }}
        >
          {percent.toFixed(1)}%
        </button>
      )}
    </div>
  );
}
