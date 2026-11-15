/**
 * 墨卷导出管线（W6a）：HTML / PNG 长图 / PDF 打印 / Word(docx)
 * ---------------------------------------------------------------------------
 * 四个入口（exportHtml / exportPng / exportPdf / exportDocx）+ 三个可独立测试
 * 的构建器（buildStandaloneHtml / mountFullRender / installPrintStyles）。
 *
 * 虚拟滚动展开策略（PNG / PDF）：
 *  - 阅读区只挂载视口 ±5 屏的块（VirtualReader），导出需要全量内容；
 *  - 不动 VirtualReader / renderer：把 tab.blocks 的全部块 HTML 拼进一个
 *    position:fixed 偏移到视口外的离屏容器（正常参与渲染、可测量、可截图），
 *    截图/打印完成后销毁；块数组为空时用 renderBlocks 重渲（纯函数，无副作用）；
 *  - 离屏块不用 .mj-block 类（它是 absolute 定位），只用 .mj-block-inner 拿排版，
 *    因此无需覆盖任何现有规则；
 *  - 代码高亮 / mermaid 增强：块已在阅读区看过就直接复用升级后的 block.html，
 *    没看过的逐块调 enhanceBlockElement（与阅读区同一管线），阈值外保持占位，
 *    避免超大文档导出卡死。
 *
 * 写盘路径（W6a 实测结论）：
 *  - capabilities 只有 fs:default（只放行应用专属目录的读），对用户自选路径
 *    plugin-fs 的 writeTextFile/writeFile 会被拒（权限不存在，src-tauri 本任务
 *    不允许改）；因此文本写盘先试 plugin-fs，失败自动兜底应用自有 save_doc
 *    命令（任意路径、无 capability 要求，见 FRONTEND_API.md）；
 *  - PNG 是二进制，save_doc 救不了：先试 plugin-fs writeFile，失败退剪贴板
 *    （navigator.clipboard.write），再失败则报错并提示需要 fs:allow-write-file；
 *  - docx 走 export_docx 命令（Rust 直接写盘，不经过 fs 插件）；需要文档已保存
 *    到磁盘，未保存的先由 App 保存（deps.saveDoc）。
 *  - 浏览器预览（无 Tauri）：文本/PNG 走 blob 下载，docx 报「需在桌面应用中用」。
 */

import { invoke } from "@tauri-apps/api/core";
import { api, isTauri } from "./backend";
import { renderBlocks } from "./renderer";
import { blockNeedsEnhance, enhanceBlockElement } from "./renderer";
import type { Block, ReaderTheme } from "./renderer";

/* -------------------------------------------------------------------------- */
/* 对外类型                                                                    */
/* -------------------------------------------------------------------------- */

/** 导出源信息（App 从当前标签构造；演示文档 path 为 null） */
export interface ExportTabInfo {
  /** 文档磁盘路径；虚拟文档（demo://）传 null */
  path: string | null;
  /** 标签名（含扩展名） */
  name: string;
  /** 标题（去扩展名，导出文件名与 HTML <title> 用） */
  title: string;
  /** Markdown 原文（或纯文本全文） */
  content: string;
  /** 当前渲染块（复用避免大文档重解析；可为 null，由导出方重渲） */
  blocks: Block[] | null;
  /** .txt 纯文本 */
  isPlain: boolean;
  /** 当前主题（决定导出配色） */
  theme: ReaderTheme;
}

export interface SaveFileOptions {
  defaultName: string;
  filters: { name: string; extensions: string[] }[];
}

/** 可注入的宿主能力（App/ExportMenu 提供；缺省用内置实现） */
export interface ExportDeps {
  /** 系统保存对话框；返回 null = 用户取消 */
  saveFile?: (opts: SaveFileOptions) => Promise<string | null>;
  /** 写文本文件（HTML 导出） */
  writeText?: (path: string, content: string) => Promise<void>;
  /** 写二进制文件（PNG 导出）；返回 "clipboard" 表示已退剪贴板 */
  writeBlob?: (path: string, blob: Blob) => Promise<"file" | "clipboard">;
  /** 确认框（超长文档导出前）；false = 取消 */
  confirm?: (title: string, body: string) => Promise<boolean> | boolean;
  /** 进度提示（开始渲染传文案，结束传 null） */
  progress?: (msg: string | null) => void;
  /** docx：先把当前标签保存到磁盘（App 的 cmdSave） */
  saveDoc?: () => Promise<void>;
}

export interface ExportResult {
  ok: boolean;
  /** 用户取消为 true（不算失败，不弹错误） */
  cancelled?: boolean;
  /** 人话结果（toast 直接展示） */
  message: string;
  /** 成功时的落盘路径（浏览器下载为文件名） */
  path?: string;
}

/* -------------------------------------------------------------------------- */
/* 内置默认实现（可被 deps 覆盖）                                                */
/* -------------------------------------------------------------------------- */

async function defaultSaveFile(opts: SaveFileOptions): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const picked = await save({ defaultPath: opts.defaultName, filters: opts.filters });
    return typeof picked === "string" ? picked : null;
  } catch (e) {
    console.warn("[export] 保存对话框失败", e);
    return null;
  }
}

/**
 * 文本写盘：plugin-fs writeTextFile 优先（未来 capabilities 放开 write 权限后
 * 原生生效），失败兜底 save_doc（应用自有命令，任意路径可用）。
 */
async function defaultWriteText(path: string, content: string): Promise<void> {
  if (isTauri) {
    try {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, content);
      return;
    } catch {
      // fs:default 只放行应用专属目录 → 走 save_doc（utf-8，保留换行风格的逻辑
      // 对新文件是 LF 原样写出，HTML 无影响）
      await api.saveDoc(path, content, "utf-8");
      return;
    }
  }
  downloadBlob(path, new Blob([content], { type: "text/html;charset=utf-8" }));
}

/** 二进制写盘（PNG）：plugin-fs writeFile → 剪贴板兜底 → 明确报错 */
async function defaultWriteBlob(path: string, blob: Blob): Promise<"file" | "clipboard"> {
  if (isTauri) {
    try {
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      return "file";
    } catch {
      /* 权限不足等，往下退剪贴板 */
    }
    try {
      // clipboard-manager:default 未放开 write-image，大概率也失败；浏览器侧
      // WebView2 的 navigator.clipboard 在用户手势链内可用
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return "clipboard";
    } catch {
      /* 全部失败 → 报错 */
    }
    throw new Error("保存 PNG 失败：缺少文件写入权限（需在 src-tauri capabilities 增加 fs:allow-write-file）");
  }
  downloadBlob(path, blob);
  return "file";
}

/** 浏览器下载（预览模式自测用） */
function downloadBlob(path: string, blob: Blob): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = path.split(/[\\/]/).pop() ?? "export";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

/** docx：export_docx 命令（Rust 直接写盘） */
async function defaultExportDocx(mdPath: string, outPath: string): Promise<void> {
  if (!isTauri) throw new Error("docx 导出需要在墨卷桌面应用中使用（浏览器预览仅支持 HTML/PNG）");
  await invoke("export_docx", { md_path: mdPath, out_path: outPath });
}

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

const MAX_PRINT_HEIGHT = 60_000; // 超长确认阈值（任务约定）
const ENHANCE_CODE_LIMIT = 500; // 代码块增强上限（超出保持占位）
const ENHANCE_MERMAID_LIMIT = 50; // mermaid 增强上限
const CANVAS_SAFE_HEIGHT = 16_000; // 超过此高度 scale 降到 1（浏览器画布上限）

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 取导出用块数组：优先复用现有块，缺失时重渲（.txt 按纯文本段落切块） */
function resolveBlocks(tab: ExportTabInfo): Block[] {
  if (tab.blocks && tab.blocks.length > 0) return tab.blocks;
  if (tab.isPlain) return buildPlainBlocks(tab.content);
  return renderBlocks(tab.content, { theme: tab.theme });
}

/** 纯文本块（与 workspace.ts buildPlainBlocks 同构；那边未导出） */
function buildPlainBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  for (const p of content.split(/\n{2,}/)) {
    if (p.trim() === "" && blocks.length > 0) continue;
    blocks.push({
      id: `b${blocks.length}`,
      index: blocks.length,
      html: `<div class="mj-plain">${escapeHtml(p) || "<br>"}</div>`,
      kind: "other",
      estHeight: Math.max(24, p.split("\n").length * 26 + 12),
      textLength: p.length,
      revision: 0,
    });
  }
  return blocks;
}

/** 估算全量渲染高度（px）：estHeight 求和（阅读区实测值不回写 Block，取近似） */
function estimateFullHeight(blocks: Block[]): number {
  let h = 0;
  for (const b of blocks) h += Math.max(20, b.estHeight);
  return h;
}

/* -------------------------------------------------------------------------- */
/* 离屏全量渲染容器（PNG 截图 / PDF 打印共用）                                    */
/* -------------------------------------------------------------------------- */

export interface FullRender {
  /** 离屏根元素（已挂到 body，position:fixed 偏移出视口） */
  root: HTMLElement;
  blockCount: number;
  /** 估算总高（px） */
  estHeight: number;
  /** 块增强（代码高亮/图表）完成信号；未启用增强时为已兑现的空 Promise */
  enhanced: Promise<void>;
  /** 销毁（从 DOM 摘除） */
  cleanup(): void;
}

export interface MountFullRenderOptions {
  /** 容器宽度（阅读区 clientWidth 优先，缺省 900） */
  width?: number;
  /** 是否增强代码高亮/mermaid（阈值外保持占位） */
  enhance?: boolean;
  /** 逐块进度（每 60 块上报一次） */
  progress?: (msg: string) => void;
}

/**
 * 把全部块拼进离屏容器。
 * - 容器 class=mj-export-root：静态定位块 + .mj-block-inner 排版（复用
 *   markdown.css / theme.css 的文档内样式，字号/行距/页宽变量自动继承）；
 * - PNG 用原样（fixed 偏移出视口）；PDF 打印时 print CSS 把它拉回正文。
 */
export function mountFullRender(tab: ExportTabInfo, opts: MountFullRenderOptions = {}): FullRender {
  const blocks = resolveBlocks(tab);
  const width = Math.max(360, Math.round(opts.width ?? 900));

  const root = document.createElement("div");
  root.className = "mj-export-root";
  root.setAttribute("data-mj-export", "");
  root.style.cssText =
    `position:fixed;left:-100000px;top:0;width:${width}px;margin:0;` +
    `background:${PALETTES[tab.theme].content};z-index:-1;`;

  for (const block of blocks) {
    const wrap = document.createElement("div");
    wrap.className = "mj-export-block";
    wrap.setAttribute("data-block-index", String(block.index));
    const inner = document.createElement("div");
    inner.className = "mj-block-inner";
    inner.innerHTML = block.html;
    wrap.appendChild(inner);
    root.appendChild(wrap);
  }
  document.body.appendChild(root);

  const enhanced = opts.enhance ? enhanceAll(blocks, root, opts.progress) : Promise.resolve();

  const full: FullRender = {
    root,
    blockCount: blocks.length,
    estHeight: estimateFullHeight(blocks),
    enhanced,
    cleanup() {
      root.remove();
    },
  };
  return full;
}

/** 逐块增强（代码高亮 / mermaid），阈值外跳过；异步进行，失败保留占位 */
async function enhanceAll(
  blocks: Block[],
  root: HTMLElement,
  progress?: (msg: string) => void,
): Promise<void> {
  const codeCount = blocks.filter((b) => b.kind === "code").length;
  const mermaidCount = blocks.filter((b) => b.kind === "mermaid").length;
  const codeOk = codeCount <= ENHANCE_CODE_LIMIT;
  const mermaidOk = mermaidCount <= ENHANCE_MERMAID_LIMIT;
  if (!codeOk || !mermaidOk) {
    progress?.(
      `代码块 ${codeCount} 个 / 图表 ${mermaidCount} 个超出渲染上限，` +
        `导出保持占位样式（高亮上限 ${ENHANCE_CODE_LIMIT}、图表上限 ${ENHANCE_MERMAID_LIMIT}）`,
    );
    return;
  }
  let done = 0;
  let pending = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (!blockNeedsEnhance(block)) continue;
    pending++;
    const inner = root.querySelector<HTMLElement>(
      `.mj-export-block[data-block-index="${block.index}"] .mj-block-inner`,
    );
    if (!inner) continue;
    try {
      await enhanceBlockElement(block, inner);
    } catch {
      /* 增强失败保留占位 */
    }
    done++;
    if (done % 60 === 0) progress?.(`正在渲染高亮与图表… ${done}/${pending}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 导出 CSS（主题变量硬编成静态值，值与 src/styles/theme.css 对齐）               */
/* -------------------------------------------------------------------------- */

interface Palette {
  content: string;
  text: string;
  textDim: string;
  textFaint: string;
  border: string;
  accent: string;
  inlineCodeBg: string;
  codeBg: string;
  quoteBg: string;
  selBg: string;
}

/** 调色板（theme.css 的 content/border/code 系色值） */
const PALETTES: Record<ReaderTheme, Palette> = {
  dark: {
    content: "#242424",
    text: "#ffffff",
    textDim: "#b8b8b8",
    textFaint: "#7a7a7a",
    border: "#3d3d3d",
    accent: "#4cc2ff",
    inlineCodeBg: "rgba(255, 255, 255, 0.09)",
    codeBg: "#1e1e1e",
    quoteBg: "rgba(255, 255, 255, 0.04)",
    selBg: "rgba(76, 194, 255, 0.35)",
  },
  light: {
    content: "#ffffff",
    text: "#1a1a1a",
    textDim: "#5c5c5c",
    textFaint: "#9a9a9a",
    border: "#e5e5e5",
    accent: "#0067c0",
    inlineCodeBg: "rgba(0, 0, 0, 0.06)",
    codeBg: "#f6f8fa",
    quoteBg: "#f8f9fa",
    selBg: "rgba(0, 103, 192, 0.25)",
  },
};

/** KaTeX 样式（CDN；与应用内 katex 版本一致） */
const KATEX_VERSION = "0.19.1";

/**
 * 导出 HTML 的静态 CSS：正文排版取自 markdown.css 的 .mj-block-inner 系规则，
 * 主题变量硬编为当前主题的静态值；Shiki 双主题按导出主题固定一侧。
 */
export function buildExportCss(theme: ReaderTheme): string {
  const p = PALETTES[theme];
  // Shiki 双主题：markdown.css 在暗色下用 --shiki-dark 覆盖内联 light 色；
  // 导出按当前主题固定（暗色导出加覆盖规则，亮色导出直接用内联色）。
  const shikiDark =
    theme === "dark"
      ? `.shiki, .shiki span {
  color: var(--shiki-dark) !important;
  background-color: transparent !important;
  font-style: var(--shiki-dark-font-style) !important;
  font-weight: var(--shiki-dark-font-weight) !important;
  text-decoration: var(--shiki-dark-text-decoration) !important;
}
.mj-code-block pre.shiki { background-color: ${p.codeBg} !important; }`
      : "";
  return `
:root {
  --font-ui: "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
  --font-mono: "Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace;
}
html { background: ${p.content}; }
body {
  margin: 0;
  background: ${p.content};
  color: ${p.text};
  font-family: var(--font-ui);
  -webkit-font-smoothing: antialiased;
}
::selection { background: ${p.selBg}; }
.mj-export { max-width: 860px; margin: 0 auto; padding: 24px 40px 64px; }
.mj-export .mj-plain { white-space: pre-wrap; font-family: inherit; }

/* 正文排版（与阅读视图 .mj-block-inner 一致） */
.mj-export .mj-block-inner {
  max-width: 760px;
  margin: 0 auto;
  padding: 6px 40px;
  color: ${p.text};
  font-size: 16px;
  line-height: 1.8;
  word-wrap: break-word;
  overflow-wrap: break-word;
  text-align: left;
  display: flow-root;
}
.mj-export .mj-block-inner h1,
.mj-export .mj-block-inner h2,
.mj-export .mj-block-inner h3,
.mj-export .mj-block-inner h4,
.mj-export .mj-block-inner h5,
.mj-export .mj-block-inner h6 {
  margin: 0; font-weight: 600; line-height: 1.35; color: ${p.text};
}
.mj-export .mj-block-inner h1 { font-size: 1.9em; padding-bottom: 0.25em; border-bottom: 1px solid ${p.border}; }
.mj-export .mj-block-inner h2 { font-size: 1.5em; padding-bottom: 0.2em; border-bottom: 1px solid ${p.border}; }
.mj-export .mj-block-inner h3 { font-size: 1.24em; }
.mj-export .mj-block-inner h4 { font-size: 1.08em; }
.mj-export .mj-block-inner h5 { font-size: 1em; color: ${p.textDim}; }
.mj-export .mj-block-inner h6 { font-size: 0.94em; color: ${p.textFaint}; }
.mj-export .mj-block-inner p { margin: 0; padding: 8px 0; }
.mj-export .mj-block-inner strong { font-weight: 650; }
.mj-export .mj-block-inner em { font-style: italic; }
.mj-export .mj-block-inner del { color: ${p.textFaint}; }
.mj-export .mj-block-inner a {
  color: ${p.accent}; text-decoration: none;
  border-bottom: 1px solid ${p.accent}55;
}
.mj-export .mj-block-inner code {
  font-family: var(--font-mono);
  font-size: 0.88em;
  background: ${p.inlineCodeBg};
  border-radius: 4px;
  padding: 0.15em 0.4em;
  white-space: pre-wrap;
}
.mj-export .mj-block-inner img { max-width: 100%; height: auto; border-radius: 6px; display: block; margin: 8px 0; }
.mj-export .mj-block-inner hr { border: none; border-top: 1px solid ${p.border}; margin: 8px 0; }
.mj-export .mj-block-inner ul, .mj-export .mj-block-inner ol { margin: 0; padding: 6px 0 6px 1.9em; }
.mj-export .mj-block-inner li { padding: 1px 0; }
.mj-export .mj-block-inner li > p { padding: 2px 0; }
.mj-export .mj-block-inner .contains-task-list { list-style: none; padding-left: 0.4em; }
.mj-export .mj-block-inner .task-list-item { display: flex; align-items: flex-start; gap: 8px; }
.mj-export .mj-block-inner .task-list-item-checkbox { margin: 0.5em 0 0; width: 14px; height: 14px; flex-shrink: 0; accent-color: ${p.accent}; }
.mj-export .mj-block-inner table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 0.94em; display: block; overflow-x: auto; }
.mj-export .mj-block-inner thead { background: ${p.text}0d; }
.mj-export .mj-block-inner th, .mj-export .mj-block-inner td { border: 1px solid ${p.border}; padding: 7px 12px; text-align: left; vertical-align: top; }
.mj-export .mj-block-inner th { font-weight: 600; }
.mj-export .mj-block-inner tbody tr:nth-child(even) { background: ${p.text}08; }
.mj-export .mj-block-inner blockquote {
  margin: 8px 0; padding: 6px 16px;
  background: ${p.quoteBg};
  border-left: 3px solid ${p.accent};
  border-radius: 0 6px 6px 0;
  color: ${p.textDim};
}
.mj-export .mj-block-inner blockquote p { padding: 4px 0; }

/* 代码块容器（占位/高亮共用结构） */
.mj-code-block { margin: 10px 0; border-radius: 8px; border: 1px solid ${p.border}; background: ${p.codeBg}; overflow: hidden; }
.mj-code-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 5px 12px; font-size: 11.5px; font-family: var(--font-mono);
  color: ${p.textFaint}; background: ${p.text}0a; border-bottom: 1px solid ${p.border};
}
.mj-code-lang { text-transform: lowercase; }
.mj-code-block pre, .mj-code-plain {
  margin: 0; padding: 12px 14px; overflow-x: auto;
  font-family: var(--font-mono); font-size: 13px; line-height: 1.65;
  background: transparent; tab-size: 2;
}
.mj-code-block pre code { font-family: inherit; font-size: inherit; background: none; padding: 0; border-radius: 0; }
.mj-code-block pre.shiki { color: ${p.text}; background: ${p.codeBg} !important; }
${shikiDark}

/* KaTeX / Mermaid / 脚注 */
.mj-export .mj-block-inner .katex { font-size: 1.08em; }
.mj-export .mj-block-inner .katex-display { margin: 10px 0; overflow-x: auto; overflow-y: hidden; padding: 2px 0; }
.mj-export .mj-block-inner p.katex-block { padding: 4px 0; text-align: center; }
.mj-export .mj-block-inner .katex-error { font-family: var(--font-mono); font-size: 0.9em; white-space: pre-wrap; word-break: break-word; }
.mj-mermaid { margin: 12px 0; min-height: 120px; border: 1px solid ${p.border}; border-radius: 8px; background: ${p.text}05; display: flex; align-items: center; justify-content: center; padding: 16px; overflow-x: auto; }
.mj-mermaid svg { max-width: 100%; height: auto; }
.mj-mermaid-hint { color: ${p.textFaint}; font-size: 12.5px; }
.mj-mermaid-error { width: 100%; color: #c42b1c; font-size: 13px; }
.mj-mermaid-error-title { font-weight: 600; margin-bottom: 6px; }
.mj-mermaid-error-msg { margin: 0; padding: 8px; background: #c42b1c14; border-radius: 6px; white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono); font-size: 12px; }
.mj-export .mj-block-inner .footnotes-sep { margin: 16px 0 8px; border: none; border-top: 1px solid ${p.border}; }
.mj-export .mj-block-inner .footnotes { font-size: 0.9em; color: ${p.textDim}; }
.mj-export .mj-block-inner .footnotes-list { padding-left: 1.6em; }
.mj-export .mj-block-inner .footnote-item p { padding: 2px 0; }
.mj-export .mj-block-inner .footnote-ref a, .mj-export .mj-block-inner .footnote-backref { text-decoration: none; border-bottom: none; }
`.trim();
}

/* -------------------------------------------------------------------------- */
/* 1) 导出 standalone HTML                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 纯函数：构建 standalone HTML（可无头断言）。
 * - 渲染产物即静态 HTML（Shiki 高亮输出内联样式，无需 JS）；
 * - KaTeX CSS 走 CDN 链接（公式离线查看需联网加载一次）；
 * - mermaid 占位卡提示改为「导出不含渲染图」。
 */
export function buildStandaloneHtml(tab: ExportTabInfo): string {
  const blocks = resolveBlocks(tab);
  const bodyHtml = blocks
    .map((b) => `<div class="mj-export-block"><div class="mj-block-inner">${b.html}</div></div>`)
    .join("\n")
    .replace(/Mermaid 图表 · 滚动到可见时渲染/g, "Mermaid 图表 · 导出不含渲染图，请用墨卷打开原文档查看");

  return `<!doctype html>
<html lang="zh-CN" data-theme="${tab.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(tab.title)} · 墨卷导出</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.css">
<style>
${buildExportCss(tab.theme)}
</style>
</head>
<body>
<main class="mj-export">
${bodyHtml}
</main>
</body>
</html>
`;
}

/** 导出为 standalone HTML（.html） */
export async function exportHtml(tab: ExportTabInfo, deps: ExportDeps = {}): Promise<ExportResult> {
  const html = buildStandaloneHtml(tab);
  const defaultName = `${tab.title}.html`;

  if (!isTauri) {
    // 浏览器预览：blob 下载
    downloadBlob(defaultName, new Blob([html], { type: "text/html;charset=utf-8" }));
    return { ok: true, message: "已通过浏览器下载 HTML", path: defaultName };
  }

  const path = await (deps.saveFile ?? defaultSaveFile)({
    defaultName,
    filters: [{ name: "HTML 文档", extensions: ["html"] }],
  });
  if (!path) return { ok: false, cancelled: true, message: "已取消" };

  try {
    await (deps.writeText ?? defaultWriteText)(path, html);
    return { ok: true, message: "已导出 HTML", path };
  } catch (e) {
    throw new Error(`导出 HTML 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 2) 导出长图 PNG（snapdom 截离屏全量容器）                                     */
/* -------------------------------------------------------------------------- */

/**
 * 导出长图：
 *  1. 全量块拼离屏容器（增强代码/图表，阈值外占位）；
 *  2. 估算高度 > 60000px 先确认；> 16000px scale 降 1（浏览器画布上限保护）；
 *  3. snapdom.toBlob 截图 → Tauri 存盘 / 浏览器下载。
 */
export async function exportPng(tab: ExportTabInfo, deps: ExportDeps = {}): Promise<ExportResult> {
  const width = readReaderWidth();
  // 先估高确认（离屏容器挂载前），22MB 大文档给进度提示
  const est = estimateFullHeight(resolveBlocks(tab));
  if (est > MAX_PRINT_HEIGHT) {
    const go = await (deps.confirm ?? defaultConfirm)(
      "导出超长图片确认",
      `文档估算高度约 ${Math.round(est).toLocaleString()}px（超过 ${MAX_PRINT_HEIGHT.toLocaleString()}px），` +
        "长图可能生成缓慢且难以打开，继续吗？",
    );
    if (!go) return { ok: false, cancelled: true, message: "已取消" };
  }
  (deps.progress ?? noopProgress)("正在渲染全部块（含代码高亮与图表）…");

  const full = mountFullRender(tab, { width, enhance: true, progress: (m) => (deps.progress ?? noopProgress)(m) });
  try {
    // 等代码高亮/图表增强完成再截图（增强与阅读区同一管线，失败保留占位）
    await full.enhanced;
    const scale = full.estHeight > CANVAS_SAFE_HEIGHT ? 1 : 2;
    const { snapdom } = await import("@zumer/snapdom");
    // 注意 toBlob 默认 format 是 SVG（见其 BlobOptions 注释），必须显式 "png"
    const blob = await snapdom.toBlob(full.root, { scale, format: "png" });
    const defaultName = `${tab.title}.png`;

    if (!isTauri) {
      downloadBlob(defaultName, blob);
      return { ok: true, message: "已通过浏览器下载 PNG", path: defaultName };
    }

    const path = await (deps.saveFile ?? defaultSaveFile)({
      defaultName,
      filters: [{ name: "PNG 图片", extensions: ["png"] }],
    });
    if (!path) return { ok: false, cancelled: true, message: "已取消" };

    const how = await (deps.writeBlob ?? defaultWriteBlob)(path, blob);
    return {
      ok: true,
      message: how === "clipboard" ? "文件写入无权限，PNG 已复制到剪贴板" : "已导出 PNG 长图",
      path,
    };
  } catch (e) {
    throw new Error(`导出 PNG 失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    full.cleanup();
    (deps.progress ?? noopProgress)(null);
  }
}

/** 读阅读区当前宽度（离屏容器与阅读视图同宽，折行一致） */
function readReaderWidth(): number {
  const scroller = document.querySelector<HTMLElement>(".mj-reader");
  return scroller?.clientWidth || 900;
}

/* -------------------------------------------------------------------------- */
/* 3) 导出 PDF（注入 print CSS + 全量打印根 + window.print）                     */
/* -------------------------------------------------------------------------- */

/**
 * 打印 CSS：隐藏应用外壳，把离屏打印根拉回正文。
 * 打印固定用浅色（深色打印费墨且多数打印机不适配）：
 *  - 根容器强制浅色调色板变量；
 *  - Shiki 在暗色 data-theme 下的 --shiki-dark 覆盖翻回 --shiki-light。
 */
export function buildPrintCss(): string {
  const p = PALETTES.light;
  return `
@media print {
  .app-frame { display: none !important; }
  body > .mj-export-root {
    position: static !important;
    left: 0 !important;
    top: 0 !important;
    width: auto !important;
    z-index: auto !important;
    display: block !important;
    /* 打印固定浅色 */
    background: #ffffff !important;
    color: ${p.text} !important;
    --text: ${p.text};
    --text-dim: ${p.textDim};
    --text-faint: ${p.textFaint};
    --border: ${p.border};
    --accent: ${p.accent};
    --inline-code-bg: ${p.inlineCodeBg};
    --code-bg: ${p.codeBg};
    --quote-bg: ${p.quoteBg};
  }
  body > .mj-export-root .mj-export-block .mj-block-inner { font-size: 12pt; line-height: 1.7; max-width: 100%; padding: 4px 0; }
  body > .mj-export-root .mj-export-block .mj-block-inner h1 { font-size: 1.9em; }
  /* 暗色主题下 Shiki 的暗色覆盖翻回亮色 */
  :root[data-theme="dark"] .shiki,
  :root[data-theme="dark"] .shiki span {
    color: var(--shiki-light) !important;
    background-color: transparent !important;
    font-style: var(--shiki-light-font-style) !important;
    font-weight: var(--shiki-light-font-weight) !important;
    text-decoration: var(--shiki-light-text-decoration) !important;
  }
  :root[data-theme="dark"] .mj-code-block pre.shiki { background-color: ${p.codeBg} !important; }
  @page { margin: 14mm; }
}
`.trim();
}

/** 打印预览句柄（exportPdf 用；测试也可直接断言） */
export interface PrintPreviewHandle {
  /** 摘除打印样式与打印根 */
  cleanup(): void;
  /** 块增强完成信号 */
  enhanced: Promise<void>;
  /** 打印根元素（已挂 body） */
  root: HTMLElement;
  blockCount: number;
}

/** 当前打印预览（exportPdf 的 afterprint/兜底清理用） */
let printPreview: PrintPreviewHandle | null = null;

function uninstallPrintPreview(): void {
  if (printPreview) {
    printPreview.cleanup();
    printPreview = null;
  }
}

/**
 * 注入打印样式 + 挂全量打印根。独立导出供无头测试断言
 * （@media print 规则存在、打印根挂载、清理后归零）。
 */
export function installPrintPreview(tab: ExportTabInfo, opts: MountFullRenderOptions = {}): PrintPreviewHandle {
  // 幂等：先清掉旧的
  uninstallPrintPreview();
  const style = document.createElement("style");
  style.setAttribute("data-mj-print", "");
  style.textContent = buildPrintCss();
  document.head.appendChild(style);
  const full = mountFullRender(tab, { ...opts, enhance: opts.enhance ?? true });
  const handle: PrintPreviewHandle = {
    cleanup() {
      style.remove();
      full.cleanup();
    },
    enhanced: full.enhanced,
    root: full.root,
    blockCount: full.blockCount,
  };
  printPreview = handle;
  return handle;
}

/** 导出为 PDF：提示 → 全量打印根 → window.print()（WebView2 打印对话框选「另存为 PDF」） */
export async function exportPdf(tab: ExportTabInfo, deps: ExportDeps = {}): Promise<ExportResult> {
  const est = estimateFullHeight(resolveBlocks(tab));
  if (est > MAX_PRINT_HEIGHT) {
    const go = await (deps.confirm ?? defaultConfirm)(
      "打印超长文档确认",
      `文档估算高度约 ${Math.round(est).toLocaleString()}px（超过 ${MAX_PRINT_HEIGHT.toLocaleString()}px），` +
        "生成打印视图可能耗时较长，继续吗？（打印固定使用浅色主题）",
    );
    if (!go) return { ok: false, cancelled: true, message: "已取消" };
  }
  const progress = deps.progress ?? noopProgress;
  progress("正在准备打印视图（全量渲染）… 完成后弹出打印对话框，请在「打印机」中选择「另存为 PDF」");
  try {
    installPrintPreview(tab, { width: readReaderWidth(), enhance: true });
    // 等代码高亮/图表增强完成再弹打印框
    await printPreview?.enhanced;
    // afterprint 清理 + 兜底定时（无头浏览器 print 立即返回、afterprint 可能不触发）
    window.addEventListener("afterprint", uninstallPrintPreview, { once: true });
    progress(null);
    window.print();
    window.setTimeout(uninstallPrintPreview, 1500);
    return { ok: true, message: "已打开打印对话框，选择「另存为 PDF」即可导出" };
  } catch (e) {
    uninstallPrintPreview();
    throw new Error(`导出 PDF 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 4) 导出 Word（docx，走 export_docx 命令）                                    */
/* -------------------------------------------------------------------------- */

/**
 * 导出 docx：
 *  - 需要文档已保存到磁盘（虚拟文档直接报错；dirty 标签先经 deps.saveDoc 保存）；
 *  - invoke export_docx { md_path, out_path }（snake_case，见 FRONTEND_API.md）。
 */
export async function exportDocx(tab: ExportTabInfo, deps: ExportDeps = {}): Promise<ExportResult> {
  if (!tab.path || tab.path.startsWith("demo://")) {
    throw new Error("演示文档无法导出 docx：请先把内容保存为本地 Markdown 文件");
  }
  if (isTauri && deps.saveDoc) {
    // dirty 的文档先落盘（export_docx 读磁盘文件；md 所在目录决定图片相对路径基准）
    await deps.saveDoc();
  }

  const path = await (deps.saveFile ?? defaultSaveFile)({
    defaultName: `${tab.title}.docx`,
    filters: [{ name: "Word 文档", extensions: ["docx"] }],
  });
  if (!path) return { ok: false, cancelled: true, message: "已取消" };

  try {
    await defaultExportDocx(tab.path, path);
    return { ok: true, message: "已导出 Word（docx）", path };
  } catch (e) {
    throw new Error(`导出 docx 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 确认/进度缺省实现                                                            */
/* -------------------------------------------------------------------------- */

async function defaultConfirm(title: string, body: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  return window.confirm(`${title}\n\n${body}`);
}

function noopProgress(_msg: string | null): void {
  /* 无宿主提示时静默 */
}
