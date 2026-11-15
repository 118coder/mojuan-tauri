# W6a 交接文档：导出功能（HTML / PNG / PDF / docx）

> 状态：前端完成，无头自测 31/31 PASS；Tauri 真窗验证待做（见「待真窗清单」）。
> 本文档供后续任务（W6b / 真窗验收 / 主线合并）接手使用。

## 一、交付物清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `src/lib/exporters.ts` | 新建 | 四个导出函数 + 三个可测试构建器（buildStandaloneHtml / mountFullRender / installPrintPreview）+ 导出/打印 CSS |
| `src/components/ExportMenu.tsx` | 新建 | EXPORT_ITEMS 四项定义、runExport 统一提示语义、buildExportMenuItems（右键菜单用）、ExportMenu 独立下拉组件 |
| `src/App.tsx` | 修改 | PromptState 加 `onCancel`；getExportTab + exportDeps；右键菜单导出分组；Palette 4 条命令 |
| `package.json` | 修改 | 新增依赖 `@zumer/snapdom@^3.7.6`、`@tauri-apps/plugin-fs@^2.7.1` |
| `.w6a.mjs` | 新建 | 无头 Edge 自测（自起 vite :1421，31 项断言） |
| `docs/task-w6a.md` | 新建 | 本文档 |

未动（按任务约束）：renderer.ts / VirtualReader.tsx / ContextMenu.tsx / FindBar.tsx / src-tauri/。
shortcuts.ts 未改（导出无快捷键需求，走命令面板/右键菜单）。

## 二、四个导出的实现

### 1. exportHtml（standalone HTML）
- `buildStandaloneHtml(tab)` 纯函数：blocks HTML（优先复用 `tab.blocks`，缺失时 renderBlocks 重渲）+ 静态 CSS（theme.css/markdown.css 色值硬编，按当前主题选 dark/light 调色板）+ KaTeX CSS CDN（katex@0.19.1 与应用内版本一致）。
- Shiki 高亮产物是内联样式静态 HTML，导出无 JS；暗色导出时带 `--shiki-dark` 覆盖规则（与 markdown.css 的做法一致）。
- mermaid 占位提示文字替换为「导出不含渲染图」。
- 写盘：plugin-dialog `save(.html)` → plugin-fs `writeTextFile` → 失败兜底 `save_doc`（见「写盘权限」）。浏览器预览直接 blob 下载。

### 2. exportPng（长图，snapdom）
- 虚拟滚动展开：**离屏容器方案**（不动 VirtualReader/renderer）。`mountFullRender` 把全部块 HTML 拼进 `position:fixed; left:-100000px` 的 `.mj-export-root`（正常渲染可测量，截图后销毁）。离屏块只用 `.mj-block-inner` 拿排版（不套 `.mj-block` 的 absolute 定位），零样式覆盖。
- 容器宽度取 `.mj-reader.clientWidth`，折行与阅读视图一致；字号/行距/页宽变量自动从 documentElement 继承。
- 增强：逐块调 `enhanceBlockElement`（与阅读区同一管线），代码块 >500 或 mermaid >50 时跳过保持占位；`FullRender.enhanced` Promise 完成后才截图。
- 防护：estHeight 求和 > 60000px 先确认；> 16000px scale 降 1（浏览器画布上限）。
- 截图：`snapdom.toBlob(root, { scale, format: "png" })`——**注意 toBlob 默认 format 是 SVG，必须显式 "png"**（实测踩过）。
- 写盘：plugin-fs `writeFile`（二进制）→ 剪贴板兜底 → 明确报错。浏览器预览 blob 下载（.w6a.mjs 断言了 PNG 魔数）。

### 3. exportPdf（打印）
- `buildPrintCss()`：`@media print` 隐藏 `.app-frame`，把 body 下的打印根拉回正文；打印**固定浅色**（浅色调色板变量强制注入 + Shiki 暗色覆盖翻回 `--shiki-light`）；`@page { margin: 14mm }`。
- `installPrintPreview(tab)`：注入 `style[data-mj-print]` + 挂全量打印根，返回 `{ cleanup, enhanced, root, blockCount }`（幂等，重复调用先清旧）。
- `exportPdf`：estHeight > 60000px 确认 → 挂打印根 → 等增强完成 → `window.print()`（WebView2 打印对话框选「另存为 PDF」）→ afterprint/1.5s 兜底清理。
- 进度提示在弹打印框前清掉。

### 4. exportDocx
- `invoke("export_docx", { md_path, out_path })`（snake_case）。需要磁盘文件：虚拟文档（path=null）直接报错；dirty 标签先经 `deps.saveDoc`（App 的 cmdSave）保存。
- Rust 侧直接写盘，不经过 fs 插件，当前 capability 下可用。

## 三、写盘权限实测结论（重要）

capabilities 只有 `fs:default`（实测 acl-manifests：仅放行应用专属目录的**读**），用户自选路径的
plugin-fs writeTextFile/writeFile 会被拒。本任务不允许改 src-tauri，处理：

1. 文本（HTML）：先试 plugin-fs（未来放开权限后原生生效），失败自动兜底应用自有 `save_doc`
   命令（任意路径、无 capability 要求、utf-8）——**今天就能用**。
2. 二进制（PNG）：plugin-fs writeFile → navigator.clipboard.write（剪贴板）→ 报错并提示需要
   `fs:allow-write-file`。
3. **主线 TODO**：在 `src-tauri/capabilities/default.json` 增加
   `fs:allow-write-file` + `fs:allow-write-text-file`（scope 按 UI 需求放开）后，
   PNG/HTML 即走原生 fs 路径，前端无需改动。

## 四、UI 挂接

- 右键菜单（阅读区）：`readerMenu` 末尾追加 `separator + buildExportMenuItems(getExportTab, exportDeps)`。
- 命令面板：`paletteCommands` 加 4 条（id：export-html / export-docx / export-pdf / export-png），
  文案与右键菜单共用 `EXPORT_ITEMS`。
- `ExportMenu` 独立组件（触发按钮 + 下拉，复用 `.ctx-menu`/`.ghost` 样式）已实现并经无头渲染断言，
  暂未挂进 App 布局（App 无工具栏位；后续放 TabStrip actions 或标题栏皆可）。
- App 的 `exportDeps`：toast=状态栏消息、confirm=自绘 PromptDialog（`PromptState.onCancel` 为本次
  新增，取消按钮/Esc/点遮罩触发，「确定」不触发）、progress=toast、saveDoc=cmdSave。

## 五、实测结果

- `npx tsc --noEmit` 零错；`npm run build` 过（2.1s，仅既有 chunk 大小提示）。
- `.w6a.mjs`（无头 Edge，自起 vite :1421，跑完自动关）：31/31 PASS。
  覆盖：HTML 产物（doctype/标题/正文标题/KaTeX CDN/主题）；exportHtml blob 回读含 `<html>` 与标题文本；
  exportPng PNG 魔数 + 离屏根清理；exportPdf（print 被调用、style[data-mj-print] + @media print、
  CSSOM media rule、打印根块数、消息文案、清理归零）；installPrintPreview 挂/清；
  ExportMenu 数据级 4 项 + 组件渲染 4 项（kinds html/docx/pdf/png）；App 右键菜单导出分组 4 项、
  Palette 过滤 4 条且点「导出为 HTML…」真跑通导出；docx 两条 mock 错误语义；全程无未捕获页面错误。
- 测试基建备注：无头环境渲染 ExportMenu 组件必须用与其相同的 preact 实例——从 dev server 转换产物
  里抓 `?v=hash` 拼 `deps/preact.js?v=hash`（裸路径是不同实例，hooks 会炸）。

## 六、待真窗清单（Tauri dev / 安装包）

1. export_docx 真调用（选 .docx → 保存 → Word 打开核对样式；含图片相对路径基准）。
2. HTML 导出真写盘（save 对话框 → save_doc 兜底路径是否顺畅；浏览器无 Tauri 未验证该分支）。
3. PNG 导出真写盘：**预期会走剪贴板兜底或报错**（fs:default 无写权限，见第三节）——加权限后复测。
4. window.print() 真窗表现：WebView2 打印对话框选「另存为 PDF」，核对分页、浅色、代码高亮。
5. 22MB 大文档（D:\cache\perf\huge.md）实导 HTML/PNG 的耗时与内存（进度 toast / >60000px 确认框）。
6. 右键菜单导出分组在真窗的点击链路（无头已用合成事件验证 UI 挂接）。

## 七、遗留问题 / 已知限制

- PNG 写盘受 capabilities 限制（主线加 `fs:allow-write-file` 后解决，前端已就绪）。
- 长图/打印里未滚动到过的 mermaid 块显示占位卡片（增强阈值 500/50 外跳过）；代码块同理保持纯色占位。
- HTML 导出的 KaTeX CSS 走 CDN，离线打开公式会裸排版（任务指定 CDN 方案；后续可改为内嵌）。
- 纯文本（.txt）导出：workspace 的 buildPlainBlocks 未导出，exporters 内按同构逻辑自建块（重复代码 ~15 行）。
- 打印固定浅色主题（深色费墨且不可控），确认框文案已注明。
