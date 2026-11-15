# W4 任务书：界面交互层（等 W2+W3 完成后执行）

## 输入依赖
- W3 产出：`src/lib/renderer.ts`（renderBlocks）、`src/components/VirtualReader.tsx`
- W2 产出：`src-tauri/src/commands/*`（见 docs/api-contract.md）
- 交互规范：`E:\网页小工具\墨卷\调研-阅读软件功能框架.md` 第 2/3/4/5 节（铁律+P0 清单+快捷键表）——**逐条照做**

## 交付物

1. **右键菜单组件 `src/components/ContextMenu.tsx`**（全应用复用）：
   - 按调研 2.1/2.2：选区内右键=选区保留+有选区菜单（复制/复制为 Markdown/搜索所选文字）；选区外右键=清选区+无选区菜单（查找/打开所在文件夹/重新加载）；复制后选区保留；菜单文字不可选中；Esc/点外/滚轮关闭；菜单项右侧标快捷键文本
   - 图片右键：复制图片/放大/复制地址；链接右键：打开/复制地址/外部浏览器打开；代码块右键：复制代码
2. **标签页 `src/components/TabStrip.tsx`**：多开/点切/中键关/右键菜单（关闭/关闭其他/关闭右侧）/长标题截断/Ctrl+Tab 循环切换
3. **侧栏 `src/components/Sidebar.tsx`**：文件树（open_workspace/list_dir）+ 大纲（doc_outline，点击跳块+跟随滚动高亮）+ 搜索（search_workspace）；宽度拖拽可调
4. **查找替换 `src/components/FindBar.tsx`**（编辑区）+ 渲染区查找（Ctrl+F：全部命中弱色高亮+当前强色+计数 3/17+F3 循环+Esc 两步关：先查框后选区；选中文字 Ctrl+F 自动带入）
5. **快捷键系统 `src/lib/shortcuts.ts`**：按调研第 5 节映射表实现 P0 全部（Ctrl+O/N/S/F/H/P/Ctrl+滚轮缩放 Ctrl+0/F11/Space·Shift+Space 翻屏/Esc/Alt+←→ 历史）
6. **状态栏 `src/components/StatusBar.tsx`**：字数/字符数+滚动百分比（点击跳转）
7. **极简模式**：F8 切换（隐藏侧栏+顶栏只留标签，Esc 退出）
8. **拖拽打开**：拖 .md 进窗口打开（Tauri onDragDrop 事件）
9. **命令面板 `src/components/Palette.tsx`**：Ctrl+P 模糊切换文件+执行命令
10. **App.tsx 正式整合**：替换 W3 的演示版骨架，串起：TitleBar（我写的）+Sidebar+TabStrip+内容区（VirtualReader/EditorPane 切换）+StatusBar+右键菜单+查找条+设置对话框（主题切换/字号/行距/页宽，localStorage+save_state）
11. **滚动进度记忆**：switch_tab/关窗时 save_state 记 per-path scrollTop，打开恢复

## 验收（对照调研 P0 清单逐条自测并在回复里给核对表）
- 双击选词/三击选段/拖拽跨段/选区内右键保选区/复制后选区保留
- 千万字文档：打开→大纲跳块→查找→进度记忆，全程流畅
- `npx tauri dev` 真窗口跑通全流程；npm run build 类型零错
- 只动 src/（components/App/styles）+ package.json；不碰 src-tauri/；不 commit；中文注释
