/**
 * W5 独立演示页：不经过 App.tsx，专测 EditorPane 的输入/选择/查找/主题/滚动同步。
 *
 * 布局：左侧编辑区 + 右侧「模拟阅读侧」。
 * - 编辑区滚动 -> onScrollRatio -> 右栏比例条跟随，并按比例截取原文做预览
 * - 右栏比例条滚动 -> scrollToRatio -> 编辑区跟随
 * 两边都做了回声抑制，来回拖动不会互相抖。
 * 右栏只渲染一小段预览文本 + 一根长比例条，不把 8 万字全塞进 DOM，
 * 避免「演示页自己卡」污染对编辑器流畅度的判断。
 */
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { EditorPane, type EditorSelectionInfo } from "../components/EditorPane";
import { buildDemoText } from "./demoText";
import "./dev.css";

type Theme = "dark" | "light";

/** 比例条内部高度（像素），仅用于产生可滚动空间 */
const TRACK_HEIGHT = 32000;
/** 预览片段长度 */
const PREVIEW_CHARS = 900;

export function EditorDemo() {
  const text = useMemo(() => buildDemoText(80000), []);
  const [value, setValue] = useState(text);
  const [theme, setTheme] = useState<Theme>("dark");
  const [readOnly, setReadOnly] = useState(false);
  const [sel, setSel] = useState<EditorSelectionInfo>({ from: 0, to: 0, text: "" });
  const [ratio, setRatio] = useState(0);
  const [saveCount, setSaveCount] = useState(0);
  const [editCount, setEditCount] = useState(0);

  // ---- 右栏比例条 ----
  const trackRef = useRef<HTMLDivElement | null>(null);
  const trackEchoRef = useRef<number | null>(null);

  /** 编辑区 -> 右栏 */
  const handleEditorScroll = (r: number) => {
    setRatio(r);
    const el = trackRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    const top = r * max;
    if (Math.abs(el.scrollTop - top) < 1) return;
    trackEchoRef.current = r; // 这轮滚动由外部触发，回程忽略
    el.scrollTop = top;
  };

  /** 右栏 -> 编辑区 */
  const handleTrackScroll = () => {
    const el = trackRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    const r = Math.max(0, Math.min(1, el.scrollTop / max));
    if (trackEchoRef.current !== null) {
      const echo = Math.abs(r - trackEchoRef.current) <= 0.002;
      trackEchoRef.current = null;
      if (echo) return;
    }
    setRatio(r);
  };

  // 主题同步到 <html data-theme>，让 theme.css 变量生效
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const lines = useMemo(() => value.split("\n").length, [value]);
  const chars = value.length;

  // 按滚动比例截取一段原文做「阅读侧预览」
  const preview = useMemo(() => {
    const start = Math.max(0, Math.floor((chars - PREVIEW_CHARS) * ratio));
    return value.slice(start, start + PREVIEW_CHARS);
  }, [value, chars, ratio]);

  const resetDoc = () => {
    setValue(text);
    setRatio(0);
  };

  /** 压力测试：整篇替换成更大的文档（走外部 value 回写路径） */
  const appendStress = () => {
    setValue((v) => (v + "\n\n" + text).slice(0, 400000));
  };

  return (
    <div class="dev-root">
      <header class="dev-toolbar">
        <strong class="dev-title">EditorPane 演示（W5）</strong>
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          主题：{theme === "dark" ? "深色" : "浅色"}
        </button>
        <button onClick={() => setReadOnly((v) => !v)}>
          {readOnly ? "只读：开" : "只读：关"}
        </button>
        <button onClick={resetDoc}>重置文档</button>
        <button onClick={appendStress}>追加到 40 万字（压力）</button>
        <span class="dev-stat">
          {chars} 字符 / {lines} 行
        </span>
        <span class="dev-stat">滚动 {Math.round(ratio * 100)}%</span>
        <span class="dev-stat">
          选区 {sel.from}-{sel.to}
          {sel.text
            ? `：「${sel.text.length > 12 ? sel.text.slice(0, 12) + "…" : sel.text}」`
            : ""}
        </span>
        <span class="dev-stat">onChange {editCount} 次</span>
        <span class="dev-stat">Ctrl+S {saveCount} 次</span>
      </header>

      <div class="dev-body">
        <section class="dev-pane dev-editor-pane">
          <EditorPane
            value={value}
            onChange={(v) => {
              setValue(v);
              setEditCount((n) => n + 1);
            }}
            readOnly={readOnly}
            theme={theme}
            onScrollRatio={handleEditorScroll}
            scrollToRatio={ratio}
            onSelectionChange={setSel}
            onSave={() => setSaveCount((n) => n + 1)}
          />
        </section>

        <section class="dev-pane dev-mirror-pane">
          <div class="dev-mirror-caption">
            模拟阅读侧（按比例截取原文；右侧长条可拖动反向驱动编辑区）
          </div>
          <div class="dev-mirror-body">
            <pre class="dev-mirror-preview">{preview}</pre>
            <div
              ref={trackRef}
              class="dev-mirror-track"
              onScroll={handleTrackScroll}
              title="拖动这里反向驱动编辑区"
            >
              <div class="dev-mirror-spacer" style={{ height: `${TRACK_HEIGHT}px` }} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export default EditorDemo;
