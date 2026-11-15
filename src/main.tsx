import { render } from "preact";
import App from "./App";
import "./styles/theme.css";

/** 主题初始化：跟随系统 + localStorage 记忆（W4 会接入设置持久化与手动切换） */
function initTheme() {
  const saved = localStorage.getItem("mojuan-theme");
  const sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved ?? (sysDark ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
}
initTheme();
// 跟随系统变化（手动切换过则以手动为准）
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  if (!localStorage.getItem("mojuan-theme")) {
    document.documentElement.dataset.theme = e.matches ? "dark" : "light";
  }
});

render(<App />, document.getElementById("root")!);
