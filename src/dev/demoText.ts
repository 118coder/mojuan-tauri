/**
 * 演示用长文：程序化拼装约 8 万字 Markdown，覆盖常见语法，
 * 用于验证 CodeMirror 6 视口渲染在大文档下的输入/滚动/查找流畅度。
 */

const SECTIONS: string[] = [];

const PARA =
  "墨卷的设计目标是把「读」做到极致：排版克制、滚动顺滑、查找准确。编辑器同样遵循这一原则——不堆功能，只求输入跟手。" +
  "CodeMirror 6 采用视口渲染，只有可视区域附近的行会真正进入 DOM，因此十万字级别的文档滚动与输入都不会随字数线性变慢。" +
  "中文输入法在合成期间由浏览器接管 DOM，编辑器必须避免在该阶段重建内容，否则候选框会被打断、光标会跳到行首。";

function headingBlock(i: number): string {
  return [
    `## 第 ${i} 节 · 视口渲染与长文档体验`,
    "",
    PARA,
    "",
    "### 列表与任务",
    "",
    "- 普通列表项：**加粗**、*斜体*、~~删除线~~、`行内代码`",
    "- 链接示例：[CodeMirror](https://codemirror.net/6/) 与自动链接 https://example.com/docs",
    "- 任务列表：",
    "  - [x] 视口渲染验证",
    "  - [ ] 中文 IME 验证",
    "  - [ ] 查找面板中文标签",
    "",
    "1. 有序列表第一项",
    "2. 有序列表第二项，包含 `--code-bg` 这类变量名",
    "3. 有序列表第三项，包含 <kbd>Ctrl</kbd> + <kbd>F</kbd> 键盘提示",
    "",
    "> 引用块：编辑器的价值不在功能多，而在每一次按键都有确定的回应。",
    "> 第二行引用，测试 `--quote-bar` 与文字层级。",
    "",
    "| 场景 | 字数 | 预期 |",
    "| --- | --- | --- |",
    "| 短文档 | 1 千字 | 即开即用 |",
    "| 中篇 | 5 万字 | 滚动无掉帧 |",
    "| 长篇 | 10 万字 | 视口渲染稳定 |",
    "",
    "```ts",
    "// 代码块高亮：等宽字体 + 行内底色",
    "export function ratioOf(el: HTMLElement): number {",
    "  const max = el.scrollHeight - el.clientHeight;",
    "  return max > 0 ? el.scrollTop / max : 0;",
    "}",
    "```",
    "",
  ].join("\n");
}

/** 生成约 80000 字符的演示文本 */
export function buildDemoText(target = 80000): string {
  if (SECTIONS.length > 0) return SECTIONS.join("\n");
  const parts: string[] = [
    "# 墨卷编辑区演示文档",
    "",
    "这是一份程序化生成的长文，用于测试 CodeMirror 6 在八万字量级下的输入、滚动与查找表现。",
    "文档包含标题、段落、列表、任务列表、引用、表格、代码块、链接、行内代码等常见 Markdown 语法。",
    "",
  ];
  let total = parts.join("\n").length;
  let i = 1;
  while (total < target) {
    const block = headingBlock(i++);
    parts.push(block);
    total += block.length;
  }
  SECTIONS.push(parts.join("\n"));
  return SECTIONS[0];
}
