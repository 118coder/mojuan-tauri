/**
 * 演示页独立入口（W5）：
 * `npx vite` 启动后访问 http://localhost:1420/src/dev/editor.html
 * 不改 App.tsx、不改 index.html，互不干扰。
 *
 * 本文件是 .ts（任务指定的入口文件名），因此不用 JSX，改用 h() 构造虚拟节点。
 */
import { h, render } from "preact";
import { EditorDemo } from "./EditorDemo";
import "../styles/theme.css";

// 演示页默认深色；切换按钮会改 data-theme
document.documentElement.dataset.theme = "dark";

render(h(EditorDemo, {}), document.getElementById("root")!);
