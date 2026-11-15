/**
 * 墨卷渲染管线（W3）
 * ---------------------------------------------------------------------------
 * 职责：
 *  1. 用 markdown-it 一次性解析整篇 Markdown，按“顶级块”切成 Block[]；
 *  2. 每个块用同一套 markdown-it 规则单独渲染出 HTML（单块独立成立）；
 *  3. 代码高亮走 Shiki（VS Code 同款 TextMate 语法 + dark-plus/light-plus 双主题），
 *     但 Shiki 很重：只在块进入视口后才异步加载/高亮，结果缓存在块对象与 Map 中；
 *  4. KaTeX 行内/块级公式同步渲染（轻量，不延迟）；
 *  5. mermaid 只输出占位卡片，块可见时才异步 import + mermaid.run，失败降级为错误卡片。
 *
 * 性能基线（D:\cache\perf\huge.md，22MB / 1087 万字 / 79,663 个顶级块）：
 *  - md.parse 是主要成本（约 1.8s，单次，不可省）；
 *  - 逐块 renderer.render 合计约 0.2s；
 *  - 因此“整篇解析 + 预生成块 HTML”可行，滚动时只做高亮升级。
 */

import MarkdownIt from "markdown-it";
import type { Env, MarkdownIt as MarkdownItInstance, MarkdownItOptions, Token } from "markdown-it";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import { katex } from "@mdit/plugin-katex";
import type { LanguageInput, ThemeRegistrationAny } from "shiki";
import "katex/dist/katex.min.css";

/* -------------------------------------------------------------------------- */
/* 对外类型                                                                    */
/* -------------------------------------------------------------------------- */

/** 块的语义类别：虚拟滚动据此给未测量块估算高度 */
export type BlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "quote"
  | "table"
  | "code"
  | "math"
  | "hr"
  | "footnotes"
  | "mermaid"
  | "html"
  | "other";

/** 渲染出的一个顶级块 */
export interface Block {
  /** 稳定 id（等于 `b${index}`，供 Preact key 与高亮缓存使用） */
  id: string;
  /** 块序号（0 起） */
  index: number;
  /** 该块独立渲染出的 HTML（高亮完成后会就地升级） */
  html: string;
  /** 语义类别（估算高度、调试用） */
  kind: BlockKind;
  /** 未测量前的估算高度（px），VirtualReader 首次排版用 */
  estHeight: number;
  /** 标题块附带的层级与纯文本（大纲跳转用，非标题块为 undefined） */
  heading?: { level: number; text: string };
  /** 去标签后的字符数（估算/统计用） */
  textLength: number;
  /** 内容版本号：html 被就地升级时自增，供 memo 组件感知变化 */
  revision: number;
}

/** 渲染选项 */
export interface RenderOptions {
  /** 初始主题，仅影响 mermaid 配色；Shiki 输出双主题由 CSS 切换 */
  theme?: ReaderTheme;
}

export type ReaderTheme = "dark" | "light";

/** 滚动进度（VirtualReader 回报） */
export interface ScrollProgress {
  /** 0-100 */
  percent: number;
  /** 视口顶部所在块序号 */
  blockIndex: number;
  scrollTop: number;
  /** 当前挂载的块区间 [start, end) */
  start: number;
  end: number;
  /** 当前挂载的块数量（DOM 级虚拟化指标） */
  rendered: number;
}

/* -------------------------------------------------------------------------- */
/* markdown-it 管线                                                            */
/* -------------------------------------------------------------------------- */

/** 待高亮的代码片段（渲染块时登记，块可见后再补） */
interface PendingCode {
  /** 块内唯一 id */
  id: string;
  /** 归一化后的语言名（空串 = 纯文本，不需要高亮） */
  lang: string;
  code: string;
  /** 与占位 HTML 完全一致的字符串，用于高亮后精确替换 */
  placeholder: string;
}

/** 待渲染的 mermaid 片段 */
interface PendingMermaid {
  id: string;
  source: string;
}

/** 块的内部附加信息（不进入 Block 公开结构） */
interface BlockMeta {
  codes: PendingCode[];
  mermaids: PendingMermaid[];
  /** 高亮 HTML 是否已算好 */
  codeDone: boolean;
  /** 高亮结果是否已写回 block.html（文本选择期间会延后） */
  applied: boolean;
  /** 已算好的高亮 HTML（写回前暂存，避免破坏进行中的选区） */
  pendingHtml?: string;
  /** 高亮中的 Promise（并发去重） */
  highlightPromise?: Promise<boolean>;
}

const blockMeta = new WeakMap<Block, BlockMeta>();

/** 当前正在渲染的块（fence 规则据此登记片段）。逐块同步渲染，无并发问题。 */
let activeMeta: BlockMeta | null = null;
let codeSeq = 0;
let mermaidSeq = 0;

/** 主解析器：只做解析与块内 HTML 输出，代码块先给纯色占位 */
const md = new MarkdownIt({
  html: false, // 禁止内嵌原始 HTML（正文里的 <script> 只会当文本显示）
  linkify: true,
  typographer: false,
  breaks: false,
});

md.use(footnote);
md.use(taskLists, { enabled: false, label: false });
md.use(katex, {
  delimiters: "dollars", // $...$ 行内，$$...$$ 块级
  throwOnError: false, // 公式写错不炸整篇，KaTeX 自己输出错误标记
  strict: "ignore",
  mathFence: true, // ```math 也按块级公式渲染
});

/**
 * 自定义 fence 渲染：普通代码块输出“纯色占位”，mermaid 输出占位卡片。
 * 注意 ```math 要委托给 KaTeX 插件自己的规则（在 md.use 之后捕获）。
 */
const katexFenceRule = md.renderer.rules.fence!;
const mermaidSources = new Map<string, string>();

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = token.info ? token.info.trim() : "";
  const rawLang = info.split(/\s+/)[0] ?? "";
  const lang = rawLang.toLowerCase();

  // ```math 交给 KaTeX 插件（块级公式）
  if (lang === "math") {
    return katexFenceRule(tokens, idx, options, env, self);
  }

  const code = token.content;
  const id = `c${codeSeq++}`;

  if (lang === "mermaid") {
    mermaidSeq++;
    mermaidSources.set(id, code);
    const placeholder = renderMermaidPlaceholder(id, code);
    activeMeta?.mermaids.push({ id, source: code });
    return placeholder;
  }

  // 语言未知：不登记为待高亮项，直接保持纯文本占位
  const normalized = normalizeLang(rawLang);
  const placeholder = renderCodePlaceholder(id, normalized, code);
  if (normalized) {
    activeMeta?.codes.push({ id, lang: normalized, code, placeholder });
  }
  return placeholder;
};

/** 语言名归一化：未知语言返回空串（按纯文本展示） */
function normalizeLang(lang: string): string {
  const key = lang.trim().toLowerCase();
  if (!key) return "";
  const alias = LANG_ALIAS[key];
  if (alias !== undefined) return alias;
  return LANG_LOADERS[key] ? key : "";
}

/** 代码块占位：纯色底 + 语言标签，不含高亮 */
function renderCodePlaceholder(id: string, lang: string, code: string): string {
  const label = escapeHtml(lang || "text");
  return (
    `<div class="mj-code-block" data-code-id="${id}">` +
    `<div class="mj-code-head"><span class="mj-code-lang">${label}</span></div>` +
    `<pre class="mj-code-plain"><code>${escapeHtml(code)}</code></pre>` +
    `</div>`
  );
}

/** mermaid 占位卡片：可见前不加载任何图表代码 */
function renderMermaidPlaceholder(id: string, source: string): string {
  return (
    `<div class="mj-mermaid" data-mermaid-id="${id}" data-state="pending">` +
    `<div class="mj-mermaid-hint">Mermaid 图表 · 滚动到可见时渲染</div>` +
    `<pre class="mj-mermaid-src" hidden>${escapeHtml(source)}</pre>` +
    `</div>`
  );
}

/** 极简 HTML 转义（正文来自本地文件，仍需转义避免误注入） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* -------------------------------------------------------------------------- */
/* 块切分                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 把 markdown 按顶级块切成 Block[]。
 * 切分规则：token 流中 depth=0 的 token 为一个块的开始；遇到 nesting=1 时向后吞掉
 * 整棵子树（到对应 nesting=-1），保证列表/引用/表格/脚注结构完整、可独立渲染。
 */
export function renderBlocks(source: string, opts: RenderOptions = {}): Block[] {
  if (opts.theme) setRendererTheme(opts.theme);

  const env: Env = {};
  const tokens = md.parse(source, env);
  const blocks: Block[] = [];

  let i = 0;
  let index = 0;
  while (i < tokens.length) {
    const start = i;
    const first = tokens[i];
    if (first.nesting === 1) {
      let depth = 1;
      i++;
      while (i < tokens.length && depth > 0) {
        depth += tokens[i].nesting;
        i++;
      }
    } else {
      i++;
    }

    const slice = tokens.slice(start, i);
    activeMeta = { codes: [], mermaids: [], codeDone: false, applied: false };
    // 同步逐块渲染：activeMeta 只在本次调用期间有效
    const html = md.renderer.render(slice, md.options as Required<MarkdownItOptions>, env);
    const meta = activeMeta;
    activeMeta = null;

    const kind = classifyBlock(first, slice);
    const textLength = stripHtml(html).length;
    const heading = kind === "heading" ? readHeading(first, slice) : undefined;
    const block: Block = {
      id: `b${index}`,
      index,
      html,
      kind,
      estHeight: estimateHeight(kind, html, slice, textLength),
      textLength,
      revision: 0,
      ...(heading ? { heading } : {}),
    };
    blockMeta.set(block, meta);
    blocks.push(block);
    index++;
  }

  return blocks;
}

/**
 * 复用同一管线把整篇文档渲染成一段 HTML（不分块）。
 * 给导出/打印等一次性场景用；块级阅读请用 renderBlocks。
 */
export function renderBlockHtml(source: string, opts: RenderOptions = {}): string {
  return renderBlocks(source, opts)
    .map((b) => b.html)
    .join("");
}

/** 判断块类别 */
function classifyBlock(first: Token, tokens: Token[]): BlockKind {
  switch (first.type) {
    case "heading_open":
      return "heading";
    case "paragraph_open":
      return "paragraph";
    case "bullet_list_open":
    case "ordered_list_open":
      return "list";
    case "blockquote_open":
      return "quote";
    case "table_open":
      return "table";
    case "hr":
      return "hr";
    case "math_block":
      return "math";
    case "html_block":
      return "html";
    case "footnote_block_open":
      return "footnotes";
    case "fence": {
      const lang = first.info ? first.info.trim().split(/\s+/)[0]?.toLowerCase() : "";
      if (lang === "mermaid") return "mermaid";
      if (lang === "math") return "math";
      return "code";
    }
    default:
      if (tokens.some((t) => t.type === "fence")) return "code";
      return "other";
  }
}

/** 读取标题层级与纯文本（用于侧栏大纲） */
function readHeading(first: Token, tokens: Token[]): { level: number; text: string } {
  const level = Number(first.tag.replace(/^h/, "")) || 1;
  const inline = tokens.find((t) => t.type === "inline");
  if (!inline) return { level, text: "" };
  const text =
    inline.children && inline.children.length > 0
      ? md.renderer.renderInlineAsText(inline.children, md.options, {})
      : inline.content;
  return { level, text: text.trim() };
}

/** 去掉 HTML 标签并还原常见实体，得到近似纯文本长度 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .trim();
}

/**
 * 估算块高度：首次滚动时这些块还没被测量，按类别 + 字符数估。
 * 内容宽度按 720px（16px 字号、中文约 42 字/行、行高 29px）估算。
 */
function estimateHeight(kind: BlockKind, html: string, tokens: Token[], textLength: number): number {
  const lines = Math.max(1, Math.ceil(textLength / 42));
  switch (kind) {
    case "heading": {
      const level = Number(tokens[0].tag.replace(/^h/, "")) || 1;
      return [0, 58, 50, 44, 40, 36, 34][level] ?? 40;
    }
    case "paragraph":
      return 16 + lines * 29;
    case "quote":
      return 26 + lines * 29;
    case "list": {
      const items = (html.match(/<li/g) ?? []).length;
      return 14 + Math.max(items, lines) * 31;
    }
    case "table": {
      const rows = (html.match(/<tr/g) ?? []).length;
      return 18 + rows * 36;
    }
    case "code":
    case "math": {
      const fence = tokens.find((t) => t.type === "fence" || t.type === "math_block");
      const codeLines = fence ? fence.content.split("\n").length : lines;
      return 50 + codeLines * 21;
    }
    case "mermaid":
      return 300;
    case "hr":
      return 30;
    case "footnotes": {
      const items = (html.match(/<li/g) ?? []).length;
      return 56 + Math.max(items, 1) * 52;
    }
    default:
      return Math.min(4000, Math.max(28, 20 + lines * 29));
  }
}

/* -------------------------------------------------------------------------- */
/* Shiki 可见区高亮（重依赖，全部懒加载）                                       */
/* -------------------------------------------------------------------------- */

type ShikiHighlighter = import("shiki/core").HighlighterCore;

/** Shiki 单例（首次遇到可见代码块时才初始化） */
let highlighter: ShikiHighlighter | null = null;
let highlighterPromise: Promise<ShikiHighlighter | null> | null = null;
/** 用 @shikijs/markdown-it 装好的“迷你渲染器”，把一段代码渲染成 <pre class="shiki"> */
let codeRenderer: MarkdownItInstance | null = null;

/** 已高亮块 HTML 缓存：blockId -> html（滚动离开也不丢，回来直接复用） */
const blockHtmlCache = new Map<string, string>();
/** 相同代码片段去重缓存：lang + code -> shiki html（样例里同一段代码重复上万次） */
const codeHtmlCache = new Map<string, string>();
const CODE_CACHE_LIMIT = 400;

/** 语言别名 -> Shiki 语法名（"" 表示纯文本，不进高亮） */
const LANG_ALIAS: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  rs: "rust",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  cs: "csharp",
  "c#": "csharp",
  "c++": "cpp",
  "obj-c": "objective-c",
  objc: "objective-c",
  ps1: "powershell",
  pwsh: "powershell",
  docker: "dockerfile",
  make: "makefile",
  gql: "graphql",
  kt: "kotlin",
  golang: "go",
  htm: "html",
  text: "",
  plaintext: "",
  txt: "",
  plain: "",
};

/** 按需加载的语言语法（一个语言一个 chunk，首次用到才下载+注册） */
const LANG_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  rust: () => import("@shikijs/langs/rust"),
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  jsx: () => import("@shikijs/langs/jsx"),
  tsx: () => import("@shikijs/langs/tsx"),
  python: () => import("@shikijs/langs/python"),
  bash: () => import("@shikijs/langs/bash"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  markdown: () => import("@shikijs/langs/markdown"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  sql: () => import("@shikijs/langs/sql"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  diff: () => import("@shikijs/langs/diff"),
  xml: () => import("@shikijs/langs/xml"),
  powershell: () => import("@shikijs/langs/powershell"),
  ini: () => import("@shikijs/langs/ini"),
  lua: () => import("@shikijs/langs/lua"),
  php: () => import("@shikijs/langs/php"),
  ruby: () => import("@shikijs/langs/ruby"),
  swift: () => import("@shikijs/langs/swift"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
  dart: () => import("@shikijs/langs/dart"),
  scala: () => import("@shikijs/langs/scala"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  makefile: () => import("@shikijs/langs/makefile"),
  graphql: () => import("@shikijs/langs/graphql"),
  "objective-c": () => import("@shikijs/langs/objective-c"),
  perl: () => import("@shikijs/langs/perl"),
  r: () => import("@shikijs/langs/r"),
  zig: () => import("@shikijs/langs/zig"),
  nim: () => import("@shikijs/langs/nim"),
  clojure: () => import("@shikijs/langs/clojure"),
  groovy: () => import("@shikijs/langs/groovy"),
  haskell: () => import("@shikijs/langs/haskell"),
  batch: () => import("@shikijs/langs/batch"),
  proto: () => import("@shikijs/langs/proto"),
  cmd: () => import("@shikijs/langs/cmd"),
};

/**
 * 懒初始化 Shiki：动态 import core + JS 正则引擎 + 双主题 + markdown-it 适配层。
 * 只加载主题，不预载任何语言。
 */
function ensureHighlighter(): Promise<ShikiHighlighter | null> {
  if (highlighter) return Promise.resolve(highlighter);
  if (highlighterPromise) return highlighterPromise;

  highlighterPromise = (async () => {
    try {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, { fromHighlighter }, darkTheme, lightTheme] =
        await Promise.all([
          import("shiki/core"),
          import("shiki/engine/javascript"),
          import("@shikijs/markdown-it/core"),
          import("@shikijs/themes/dark-plus"),
          import("@shikijs/themes/light-plus"),
        ]);

      const hl = await createHighlighterCore({
        // JS 正则引擎：无需 WASM，Tauri/WebView2 下启动更稳
        engine: createJavaScriptRegexEngine({ forgiving: true }),
        themes: [darkTheme.default as ThemeRegistrationAny, lightTheme.default as ThemeRegistrationAny],
        langs: [],
      });

      // 用官方 @shikijs/markdown-it 适配层渲染单段代码（输出标准 <pre class="shiki">）
      const mini = new MarkdownIt({ html: false });
      fromHighlighter(hl as never, {
        themes: { dark: "dark-plus", light: "light-plus" },
      })(mini);

      highlighter = hl;
      codeRenderer = mini;
      return hl;
    } catch (err) {
      console.warn("[renderer] Shiki 初始化失败，代码块保持纯文本：", err);
      highlighterPromise = null;
      return null;
    }
  })();

  return highlighterPromise;
}

/** 请求的语言是否已加载；未加载则按需加载。返回语法名或 ""（纯文本） */
async function ensureLanguage(lang: string): Promise<string> {
  if (!lang) return "";
  const loader = LANG_LOADERS[lang];
  if (!loader) return "";

  const hl = highlighter;
  if (!hl) return "";

  if (hl.getLoadedLanguages().includes(lang)) return lang;

  try {
    const mod = await loader();
    await hl.loadLanguage(mod.default as LanguageInput);
    return lang;
  } catch (err) {
    console.warn(`[renderer] 语言 ${lang} 加载失败，退化为纯文本：`, err);
    return "";
  }
}

/** 把一段代码渲染成 Shiki 的 <pre class="shiki ...">（双主题 CSS 变量） */
async function highlightCode(lang: string, code: string): Promise<string> {
  const cacheKey = `${lang}\u0000${code}`;
  const cached = codeHtmlCache.get(cacheKey);
  if (cached) return cached;

  const hl = await ensureHighlighter();
  if (!hl || !codeRenderer) return "";

  const resolved = await ensureLanguage(lang);
  if (!resolved) return "";

  // 围栏长度必须比代码里最长的反引号串更长，避免提前闭合
  const longestRun = (code.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const src = `${fence}${resolved}\n${code}\n${fence}\n`;
  const html = codeRenderer.render(src).trim();

  // 有限去重缓存：超出后按插入顺序淘汰最旧
  if (codeHtmlCache.size >= CODE_CACHE_LIMIT) {
    const oldest = codeHtmlCache.keys().next().value;
    if (oldest !== undefined) codeHtmlCache.delete(oldest);
  }
  codeHtmlCache.set(cacheKey, html);
  return html;
}

/** 算好一个块内全部代码片段的高亮 HTML，暂存到 meta.pendingHtml */
async function computeBlockHighlight(block: Block, meta: BlockMeta): Promise<boolean> {
  if (meta.codeDone) return false;

  try {
    const parts = await Promise.all(meta.codes.map((c) => highlightCode(c.lang, c.code)));
    // 全部成功才升级整块，避免同一块里一半高亮一半纯色的割裂观感
    if (parts.some((p) => !p)) {
      meta.codeDone = true;
      return false;
    }

    let html = block.html;
    meta.codes.forEach((c, i) => {
      // 用函数式替换：避免 shiki 输出里的 $&、$' 等被当成替换模板
      const replacement = wrapHighlighted(c.id, c.lang, parts[i]!);
      html = html.replace(c.placeholder, () => replacement);
    });
    meta.codeDone = true;
    meta.pendingHtml = html;
    return true;
  } catch (err) {
    console.warn("[renderer] 代码高亮失败，保留占位：", err);
    meta.codeDone = true;
    return false;
  }
}

/** 高亮结果外套统一的代码块容器（语言标签 + Shiki pre） */
function wrapHighlighted(id: string, lang: string, preHtml: string): string {
  return (
    `<div class="mj-code-block" data-code-id="${id}">` +
    `<div class="mj-code-head"><span class="mj-code-lang">${escapeHtml(lang || "text")}</span></div>` +
    preHtml +
    `</div>`
  );
}

/** 该块是否还有待处理的高亮/图表（VirtualReader 据此调度） */
export function blockNeedsEnhance(block: Block): boolean {
  const meta = blockMeta.get(block);
  if (!meta) return false;
  if (!meta.applied && meta.codes.length > 0) return true;
  return meta.mermaids.length > 0;
}

/** 选区是否落在元素内（用于避免高亮替换打断正在进行的文本选择） */
function selectionInside(el: HTMLElement): boolean {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  return el.contains(sel.anchorNode) || el.contains(sel.focusNode);
}

/**
 * 可见块增强入口：
 *  - 代码块异步高亮，算好后写回 block.html（当选区在块内时延后）；
 *  - mermaid 卡片异步出图（直接改 DOM）。
 * 返回 true 表示 block.html 变了，VirtualReader 需重新渲染该块。
 */
export async function enhanceBlockElement(block: Block, el: HTMLElement): Promise<boolean> {
  const meta = blockMeta.get(block);
  if (!meta) return false;

  let changed = false;

  if (meta.codes.length > 0 && !meta.applied) {
    if (!meta.codeDone) {
      meta.highlightPromise ??= computeBlockHighlight(block, meta);
      await meta.highlightPromise;
    }
    if (meta.codeDone && meta.pendingHtml && !selectionInside(el)) {
      block.html = meta.pendingHtml;
      block.revision++;
      meta.applied = true;
      blockHtmlCache.set(block.id, block.html);
      changed = true;
    }
  }

  if (meta.mermaids.length > 0) {
    await renderMermaidsIn(el, meta);
  }

  return changed;
}

/** 取已缓存的块 HTML（VirtualReader 选中缓存渲染用；未高亮时返回 undefined） */
export function getCachedBlockHtml(blockId: string): string | undefined {
  return blockHtmlCache.get(blockId);
}

/* -------------------------------------------------------------------------- */
/* mermaid（占位 -> 可见时渲染，失败降级）                                      */
/* -------------------------------------------------------------------------- */

interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void;
  run: (opts: { nodes: HTMLElement[]; suppressErrors?: boolean }) => Promise<void>;
}

let mermaidApi: MermaidApi | null = null;
let mermaidPromise: Promise<MermaidApi | null> | null = null;
let currentTheme: ReaderTheme = "dark";
/** 渲染成功的 SVG 缓存：mermaid id + 主题 -> 外层 HTML */
const mermaidHtmlCache = new Map<string, string>();

/** 设置渲染器主题（切换主题时调用；影响后续 mermaid 初始化） */
export function setRendererTheme(theme: ReaderTheme): void {
  currentTheme = theme;
}

/** 懒加载 mermaid（约 500KB，只有文档里出现图且滚动到可见才加载） */
function ensureMermaid(): Promise<MermaidApi | null> {
  if (mermaidApi) return Promise.resolve(mermaidApi);
  if (mermaidPromise) return mermaidPromise;

  mermaidPromise = (async () => {
    try {
      const mod = await import("mermaid");
      const api = mod.default as unknown as MermaidApi;
      api.initialize(mermaidConfig());
      mermaidApi = api;
      return api;
    } catch (err) {
      console.warn("[renderer] mermaid 加载失败：", err);
      mermaidPromise = null;
      return null;
    }
  })();

  return mermaidPromise;
}

function mermaidConfig(): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: "strict", // 禁止图表里的 HTML/脚本
    theme: currentTheme === "dark" ? "dark" : "default",
    fontFamily: "Segoe UI, Microsoft YaHei UI, sans-serif",
  };
}

/** 渲染元素内的 mermaid 占位卡片 */
async function renderMermaidsIn(el: HTMLElement, meta: BlockMeta): Promise<void> {
  const nodes = Array.from(el.querySelectorAll<HTMLElement>(".mj-mermaid[data-state='pending']"));
  if (nodes.length === 0) return;

  const api = await ensureMermaid();
  if (!api) {
    for (const node of nodes) showMermaidError(node, "mermaid 组件加载失败");
    return;
  }

  for (const node of nodes) {
    const id = node.dataset.mermaidId ?? "";
    const source = meta.mermaids.find((m) => m.id === id)?.source;
    if (!source) continue;

    // 已渲染过（离开视口又回来）：直接回填缓存的 SVG
    const cacheKey = `${id}\u0000${currentTheme}`;
    const cached = mermaidHtmlCache.get(cacheKey);
    if (cached) {
      node.innerHTML = cached;
      node.dataset.state = "done";
      continue;
    }

    try {
      node.textContent = source;
      node.removeAttribute("data-processed");
      await api.run({ nodes: [node], suppressErrors: false });
      mermaidHtmlCache.set(cacheKey, node.innerHTML);
      node.dataset.state = "done";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showMermaidError(node, msg);
    }
  }
}

/** mermaid 失败：显示错误卡片，不崩整个页面 */
function showMermaidError(node: HTMLElement, message: string): void {
  node.dataset.state = "error";
  node.innerHTML =
    `<div class="mj-mermaid-error">` +
    `<div class="mj-mermaid-error-title">Mermaid 图表渲染失败</div>` +
    `<pre class="mj-mermaid-error-msg">${escapeHtml(message)}</pre>` +
    `</div>`;
}

/**
 * 主题切换后重绘 root 内已渲染的 mermaid 图（Shiki 靠 CSS 变量切换，无需重绘）。
 * 未渲染的占位卡片保持不动，等可见时按新主题渲染。
 */
export async function refreshMermaid(root: HTMLElement): Promise<void> {
  const api = await ensureMermaid();
  if (!api) return;
  api.initialize(mermaidConfig());

  const nodes = Array.from(root.querySelectorAll<HTMLElement>(".mj-mermaid[data-state='done']"));
  for (const node of nodes) {
    const id = node.dataset.mermaidId ?? "";
    const source = mermaidSources.get(id);
    if (!source) continue;
    node.dataset.state = "pending";
    node.textContent = source;
    node.removeAttribute("data-processed");
    mermaidHtmlCache.delete(`${id}\u0000${currentTheme}`);
    try {
      await api.run({ nodes: [node], suppressErrors: false });
      mermaidHtmlCache.set(`${id}\u0000${currentTheme}`, node.innerHTML);
      node.dataset.state = "done";
    } catch (err) {
      showMermaidError(node, err instanceof Error ? err.message : String(err));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 缓存管理                                                                    */
/* -------------------------------------------------------------------------- */

/** 清空所有渲染缓存（换文档时调用，避免旧 blockId 串味） */
export function clearRenderCaches(): void {
  blockHtmlCache.clear();
  codeHtmlCache.clear();
  mermaidHtmlCache.clear();
  mermaidSources.clear();
}

/** 已缓存的高亮块数量（调试/状态栏用） */
export function highlightedBlockCount(): number {
  return blockHtmlCache.size;
}
