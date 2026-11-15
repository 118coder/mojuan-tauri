/**
 * 墨卷编辑区：CodeMirror 6 Markdown 编辑器（W5）
 *
 * 设计要点：
 * 1. 只创建一次 EditorView，外部 props 变化全部走 Compartment 重配置或事务回写，
 *    避免重建视图导致滚动位置、撤销历史、输入法状态丢失。
 * 2. value 外部回写时跳过 addToHistory，并跳过中文 IME 合成中的回写，
 *    否则候选框会被打断（CodeMirror 合成期 DOM 由输入法接管）。
 * 3. 滚动同步双向防回环：上报用 rAF 节流；外部 scrollToRatio 落地后吞掉
 *    紧随其后的那一次 scroll 事件，避免 "A 滚 -> 通知 B -> B 回传 A" 的抖动。
 * 4. 主题色全部取自 src/styles/theme.css 的 CSS 变量，data-theme 切换即时生效；
 *    EditorView 的 dark 标记只影响 CodeMirror 基础主题（光标、面板底色等）。
 */
import { useEffect, useRef } from "preact/hooks";
import {
  Compartment,
  EditorState,
  Transaction,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { tags } from "@lezer/highlight";

/** 选区信息（阅读侧联动 / 状态栏用） */
export interface EditorSelectionInfo {
  from: number;
  to: number;
  text: string;
}

export interface EditorPaneProps {
  /** 文档内容（受控；外部变化时整篇回写，不进撤销栈） */
  value: string;
  /** 用户编辑后的最新全文 */
  onChange: (v: string) => void;
  /** 只读模式（阅读态） */
  readOnly?: boolean;
  /** 主题，跟随应用 data-theme */
  theme: "dark" | "light";
  /** 编辑区滚动比例 0~1，rAF 节流后上报（分屏同步用） */
  onScrollRatio?: (ratio: number) => void;
  /** 外部驱动滚动比例（阅读侧联动编辑区） */
  scrollToRatio?: number;
  /** 主选区变化回调 */
  onSelectionChange?: (sel: EditorSelectionInfo) => void;
  /** Ctrl+S：拦截浏览器默认保存，回调由上层决定是否落盘 */
  onSave?: () => void;
}

/* ------------------------------------------------------------------ */
/* 主题：全部引用 theme.css 的 CSS 变量，深/浅两套仅 CodeMirror 基础标记不同 */
/* ------------------------------------------------------------------ */

/** style-mod 风格的规则对象（嵌套选择器 / 属性值） */
type StyleRule = { [propOrSelector: string]: string | number | StyleRule | null };
/** EditorView.theme 的顶层形态：键为选择器，值为样式规则 */
type ThemeSpec = { [selector: string]: StyleRule };

/**
 * 编辑区主题规则（与 theme.css 变量对齐）。
 *
 * 选择器统一写成 `&.cm-editor .cm-xxx`：CodeMirror 内置主题用的是
 * `.<前缀> .<light|dark 类> .cm-xxx` 三级类选择器，只写 `.cm-xxx`
 * 会因优先级不足被内置色覆盖（例如行号栏底色、选区色）。
 */
function buildThemeSpec(): ThemeSpec {
  return {
    "&": {
      height: "100%",
      fontSize: "14px",
      color: "var(--text)",
      backgroundColor: "var(--code-bg)",
    },
    "&.cm-focused": { outline: "none" },
    "&.cm-editor .cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.6",
      overflow: "auto",
    },
    "&.cm-editor .cm-content": {
      // 底部留白，最后一行不会贴住窗口边
      padding: "12px 0 48px",
    },
    "&.cm-editor .cm-line": { padding: "0 18px 0 10px" },
    // 行号栏：透明底 + 极细分割线，和内容区同一底色
    "&.cm-editor .cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--text-faint)",
      borderRight: "1px solid var(--border)",
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      userSelect: "none",
    },
    "&.cm-editor .cm-lineNumbers .cm-gutterElement": {
      padding: "0 8px 0 12px",
      minWidth: "30px",
    },
    "&.cm-editor .cm-activeLine": { backgroundColor: "var(--accent-soft)" },
    "&.cm-editor .cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "var(--text-dim)",
    },
    // 选区：统一用主题选区色（drawSelection 自绘层 + 原生兜底）
    "&.cm-editor .cm-selectionBackground": {
      backgroundColor: "var(--sel-bg) !important",
    },
    "&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
      {
        backgroundColor: "var(--sel-bg) !important",
      },
    "&.cm-editor .cm-cursor, &.cm-editor .cm-dropCursor": {
      borderLeftColor: "var(--accent)",
      borderLeftWidth: "2px",
    },
    // 括号匹配
    "&.cm-editor.cm-focused .cm-matchingBracket": {
      backgroundColor: "var(--sel-bg)",
      outline: "1px solid var(--accent)",
    },
    "&.cm-editor.cm-focused .cm-nonmatchingBracket": {
      backgroundColor: "color-mix(in srgb, var(--danger) 28%, transparent)",
    },
    // 查找命中：全部弱高亮，当前项加强
    "&.cm-editor .cm-searchMatch": {
      backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)",
      borderRadius: "2px",
    },
    "&.cm-editor .cm-searchMatch-selected": {
      backgroundColor: "color-mix(in srgb, var(--accent) 46%, transparent)",
    },
    // 查找面板（顶部条）
    "&.cm-editor .cm-panels": {
      backgroundColor: "var(--panel)",
      color: "var(--text)",
      borderColor: "var(--border)",
    },
    "&.cm-editor .cm-panels-top": { borderBottom: "1px solid var(--border)" },
    "&.cm-editor .cm-panel.cm-search": {
      // 保持块级流：内置面板靠 <br> 把「替换」拆到第二行，改成 flex 会失效
      padding: "8px 34px 8px 12px",
      fontSize: "12.5px",
      lineHeight: "1.9",
    },
    "&.cm-editor .cm-panel.cm-search label": { color: "var(--text-dim)" },
    "&.cm-editor .cm-textfield": {
      backgroundColor: "var(--content)",
      color: "var(--text)",
      border: "1px solid var(--border)",
      borderRadius: "4px",
      fontSize: "12.5px",
      padding: "3px 8px",
      outline: "none",
      minWidth: "9em",
    },
    "&.cm-editor .cm-textfield:focus": { borderColor: "var(--accent)" },
    "&.cm-editor .cm-button": {
      backgroundImage: "none",
      backgroundColor: "var(--elev)",
      border: "1px solid var(--border)",
      color: "var(--text-dim)",
      borderRadius: "4px",
      fontSize: "12px",
      padding: "3px 10px",
      cursor: "default",
    },
    "&.cm-editor .cm-button:hover": {
      backgroundColor: "var(--hover)",
      color: "var(--text)",
    },
    "&.cm-editor .cm-panel.cm-search [name=close]": {
      color: "var(--text-dim)",
      fontSize: "16px",
      lineHeight: "1",
      padding: "0 4px",
      cursor: "default",
    },
    "&.cm-editor .cm-panel.cm-search [name=close]:hover": {
      color: "var(--text)",
    },
  };
}

const darkEditorTheme = EditorView.theme(buildThemeSpec(), { dark: true });
const lightEditorTheme = EditorView.theme(buildThemeSpec(), { dark: false });

/** Markdown 语法高亮：颜色走 CSS 变量，深浅主题自动适配 */
const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "var(--text)", fontWeight: "700" },
  { tag: tags.heading1, color: "var(--text)", fontWeight: "700" },
  { tag: tags.heading2, color: "var(--text)", fontWeight: "700" },
  {
    tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6],
    color: "var(--text)",
    fontWeight: "600",
  },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  {
    tag: tags.strikethrough,
    textDecoration: "line-through",
    color: "var(--text-dim)",
  },
  {
    tag: [tags.link, tags.url],
    color: "var(--accent)",
    textDecoration: "underline",
  },
  {
    tag: [tags.monospace],
    color: "var(--text)",
    backgroundColor: "var(--inline-code-bg)",
  },
  { tag: tags.quote, color: "var(--text-dim)", fontStyle: "italic" },
  { tag: tags.list, color: "var(--text)" },
  {
    tag: [tags.processingInstruction, tags.contentSeparator],
    color: "var(--text-faint)",
  },
  { tag: tags.labelName, color: "var(--text-faint)" },
  { tag: tags.comment, color: "var(--text-faint)", fontStyle: "italic" },
  { tag: tags.string, color: "var(--accent)" },
  { tag: tags.invalid, color: "var(--danger)" },
]);

/** 查找面板中文化（CodeMirror 内置短语表） */
const zhPhrases: { [key: string]: string } = {
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "全部",
  "match case": "区分大小写",
  regexp: "正则",
  "by word": "全词",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "Go to line": "跳转到行",
  go: "跳转",
  "current match": "当前匹配",
  "on line": "位于第",
  "replaced $ matches": "已替换 $ 处",
  "replaced match on line $": "已替换第 $ 行的匹配",
};

/* ------------------------------------------------------------------ */
/* 滚动同步状态：pending 表示刚由外部驱动落地，需吞掉回声事件 */
/* ------------------------------------------------------------------ */

interface ScrollSyncState {
  lastEmitted: number;
  pending: number | null;
  pendingTimer: number;
  raf: number;
}

function createScrollSyncState(): ScrollSyncState {
  return { lastEmitted: 0, pending: null, pendingTimer: 0, raf: 0 };
}

/** 只读/可编辑重配置（两个 facet 必须一起切） */
function readOnlyExtension(ro: boolean): Extension {
  return [EditorState.readOnly.of(ro), EditorView.editable.of(!ro)];
}

/** 外部比例落到滚动容器；成功滚动后标记 pending，供 scroll 监听吞回声 */
function applyExternalRatio(
  view: EditorView,
  ratio: number,
  sync: ScrollSyncState,
): void {
  const el = view.scrollDOM;
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 0) return; // 内容不满一屏，无需滚动
  const next = Math.max(0, Math.min(1, ratio));
  const top = next * max;
  if (Math.abs(el.scrollTop - top) < 1) return; // 已在目标位置，避免无谓事件
  sync.pending = next;
  if (sync.pendingTimer) window.clearTimeout(sync.pendingTimer);
  sync.pendingTimer = window.setTimeout(() => {
    sync.pending = null;
    sync.pendingTimer = 0;
  }, 300);
  el.scrollTop = top;
}

/* ------------------------------------------------------------------ */
/* 组件 */
/* ------------------------------------------------------------------ */

export function EditorPane(props: EditorPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const scrollSyncRef = useRef<ScrollSyncState>(createScrollSyncState());

  // 回调用 ref 持有最新引用，编辑器的扩展闭包只创建一次
  const onChangeRef = useRef(props.onChange);
  const onSelectionChangeRef = useRef(props.onSelectionChange);
  const onScrollRatioRef = useRef(props.onScrollRatio);
  const onSaveRef = useRef(props.onSave);
  onChangeRef.current = props.onChange;
  onSelectionChangeRef.current = props.onSelectionChange;
  onScrollRatioRef.current = props.onScrollRatio;
  onSaveRef.current = props.onSave;

  // Compartment：主题 / 只读可热切换，不重建状态
  const themeCompartmentRef = useRef(new Compartment());
  const readOnlyCompartmentRef = useRef(new Compartment());
  const currentThemeRef = useRef(props.theme);
  const currentReadOnlyRef = useRef(!!props.readOnly);
  // 外部回写标记：回写引发的事务不回调 onChange，避免受控组件自激
  const syncingFromPropsRef = useRef(false);
  const initialValueRef = useRef(props.value);
  // 最近一次由用户编辑产生的全文：props.value 与它相同就跳过整篇比较（大文档省开销）
  const lastLocalValueRef = useRef(props.value);
  // IME 合成期间被推迟的外部值；合成结束后再对齐
  const pendingValueRef = useRef<string | null>(null);

  /** 把外部值写入编辑器（不进撤销栈，不触发 onChange） */
  const applyValueFromProps = (view: EditorView, next: string) => {
    if (view.state.doc.toString() === next) return;
    syncingFromPropsRef.current = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        selection: { anchor: 0 },
        annotations: Transaction.addToHistory.of(false),
        userEvent: "set.doc",
        scrollIntoView: false,
      });
    } finally {
      syncingFromPropsRef.current = false;
    }
  };

  /* 创建编辑器（仅一次） */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const sync = scrollSyncRef.current;

    const themeCompartment = themeCompartmentRef.current;
    const readOnlyCompartment = readOnlyCompartmentRef.current;

    const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged && !syncingFromPropsRef.current) {
        const text = update.state.doc.toString();
        // 记下本编辑器最后一次产出的全文：上层把它原样回传时可直接跳过回写
        lastLocalValueRef.current = text;
        onChangeRef.current(text);
      }
      if (update.selectionSet || update.docChanged) {
        const cb = onSelectionChangeRef.current;
        if (cb) {
          const main = update.state.selection.main;
          cb({
            from: main.from,
            to: main.to,
            text: update.state.sliceDoc(main.from, main.to),
          });
        }
      }
    });

    const state = EditorState.create({
      doc: initialValueRef.current,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }), // GFM：表格/任务列表/删除线
        syntaxHighlighting(markdownHighlightStyle),
        search({ top: true }),
        EditorState.phrases.of(zhPhrases),
        EditorView.contentAttributes.of({ "aria-label": "Markdown 编辑器" }),
        readOnlyCompartment.of(readOnlyExtension(!!props.readOnly)),
        themeCompartment.of(
          props.theme === "dark" ? darkEditorTheme : lightEditorTheme,
        ),
        keymap.of([
          {
            // Ctrl+S：始终拦截，避免 WebView 弹保存网页；有回调才执行落盘
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              onSaveRef.current?.();
              return true;
            },
          },
          ...searchKeymap,
          ...historyKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    currentThemeRef.current = props.theme;
    currentReadOnlyRef.current = !!props.readOnly;

    /* 滚动上报：rAF 节流 + 回声吞掉 */
    const emitScroll = () => {
      const el = view.scrollDOM;
      const max = el.scrollHeight - el.clientHeight;
      const ratio = max > 0 ? Math.max(0, Math.min(1, el.scrollTop / max)) : 0;
      if (sync.pending !== null) {
        const isEcho = Math.abs(ratio - sync.pending) <= 0.002;
        sync.pending = null;
        if (sync.pendingTimer) {
          window.clearTimeout(sync.pendingTimer);
          sync.pendingTimer = 0;
        }
        if (isEcho) {
          sync.lastEmitted = ratio;
          return; // 外部驱动产生的滚动，不再回传
        }
      }
      if (Math.abs(ratio - sync.lastEmitted) < 0.0004) return;
      sync.lastEmitted = ratio;
      onScrollRatioRef.current?.(ratio);
    };

    const onScroll = () => {
      if (sync.raf) return;
      sync.raf = window.requestAnimationFrame(() => {
        sync.raf = 0;
        emitScroll();
      });
    };
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });

    // IME 合成结束后补一次外部值对齐：合成期间 value 回写被跳过，
    // 若上层确实换了文档，这里兜底写入（合成期写会打断候选框）
    let compositionEndTimer = 0;
    const onCompositionEnd = () => {
      // 稍等一拍：部分输入法 compositionend 与内部状态复位不同步
      if (compositionEndTimer) window.clearTimeout(compositionEndTimer);
      compositionEndTimer = window.setTimeout(() => {
        compositionEndTimer = 0;
        const next = pendingValueRef.current;
        if (next === null) return;
        if (view.composing || view.compositionStarted) return;
        pendingValueRef.current = null;
        applyValueFromProps(view, next);
      }, 20);
    };
    view.contentDOM.addEventListener("compositionend", onCompositionEnd);

    // 创建后按当前外部比例定位一次（例如恢复阅读进度）
    return () => {
      view.scrollDOM.removeEventListener("scroll", onScroll);
      view.contentDOM.removeEventListener("compositionend", onCompositionEnd);
      if (compositionEndTimer) window.clearTimeout(compositionEndTimer);
      if (sync.raf) window.cancelAnimationFrame(sync.raf);
      if (sync.pendingTimer) window.clearTimeout(sync.pendingTimer);
      sync.raf = 0;
      sync.pending = null;
      sync.pendingTimer = 0;
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 外部 value 回写（切换文档 / 重新加载） */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // 上层把我们刚产出的内容原样回传（受控组件的常见形态）：无需任何动作，
    // 也避免大文档每次按键都做一次整篇 toString 比较
    if (props.value === lastLocalValueRef.current) {
      pendingValueRef.current = null;
      return;
    }
    if (view.composing || view.compositionStarted) {
      // 中文输入法正在合成：此刻重写文档会打断候选框，先记账，合成结束再对齐
      pendingValueRef.current = props.value;
      return;
    }
    applyValueFromProps(view, props.value);
    // applyValueFromProps 只读取 ref 与入参，无需列入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);

  /* 主题切换：只重配置主题隔间 */
  useEffect(() => {
    const view = viewRef.current;
    if (!view || currentThemeRef.current === props.theme) return;
    currentThemeRef.current = props.theme;
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(
        props.theme === "dark" ? darkEditorTheme : lightEditorTheme,
      ),
    });
  }, [props.theme]);

  /* 只读切换 */
  useEffect(() => {
    const view = viewRef.current;
    const ro = !!props.readOnly;
    if (!view || currentReadOnlyRef.current === ro) return;
    currentReadOnlyRef.current = ro;
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure(
        readOnlyExtension(ro),
      ),
    });
  }, [props.readOnly]);

  /* 外部驱动滚动（阅读侧 -> 编辑区） */
  useEffect(() => {
    const view = viewRef.current;
    if (!view || props.scrollToRatio === undefined) return;
    applyExternalRatio(view, props.scrollToRatio, scrollSyncRef.current);
  }, [props.scrollToRatio]);

  return (
    <div
      class="mojuan-editor"
      ref={hostRef}
      style={{
        height: "100%",
        minHeight: "0",
        overflow: "hidden",
        backgroundColor: "var(--code-bg)",
      }}
    />
  );
}

export default EditorPane;
