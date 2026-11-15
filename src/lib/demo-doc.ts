/**
 * 演示文档加载（W3 演示页用）
 * ---------------------------------------------------------------------------
 * 优先读 D:\cache\perf\huge.md（22MB / 千万字压测件），读不到则生成 30 万字演示文档。
 * 浏览器环境下没有 fs，走 Vite 的 /@fs/ 静态文件通道（已配 server.fs.allow）。
 * 后续 W4 接 Tauri read_doc 后，这里整体替换成命令调用。
 */

/** 演示文档来源信息 */
export interface DemoDoc {
  text: string;
  /** 来源标识（状态栏展示） */
  source: string;
  /** 字符数 */
  chars: number;
  /** 加载耗时（ms） */
  loadMs: number;
}

/** 压测件路径（Windows） */
const HUGE_PATH = "D:/cache/perf/huge.md";

/**
 * 读取演示文档：
 *  1) 先尝试 huge.md（仅开发服务器可用，Tauri 打包后不存在）；
 *  2) 失败则生成 30 万字中文演示文档（含全要素）。
 */
export async function loadDemoDoc(): Promise<DemoDoc> {
  const t0 = performance.now();

  // vite.config.ts 里的 demoFilePlugin 提供的只读通道（/@fs/ 会被 SPA fallback 拦成 index.html）
  // 第二个地址是 Tauri asset 协议下的备用尝试（W4 接 read_doc 后此段整体替换）
  const candidates = ["/__demo/huge.md", "/@fs/" + HUGE_PATH];
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) continue;
      const type = resp.headers.get("content-type") ?? "";
      // 命中 SPA fallback 时返回的是 HTML，必须排除
      if (type.includes("text/html")) continue;
      const text = await resp.text();
      if (text.length > 100_000) {
        return {
          text,
          source: "huge.md（千万字压测件）",
          chars: text.length,
          loadMs: performance.now() - t0,
        };
      }
    } catch {
      // 继续尝试下一个来源
    }
  }

  const text = generateDemoDoc(300_000);
  return {
    text,
    source: "内置 30 万字演示文档",
    chars: text.length,
    loadMs: performance.now() - t0,
  };
}

/**
 * 生成一份覆盖全部 GFM 要素的演示文档，约 targetChars 字。
 * 结构对齐 egui 版的功能清单：标题/粗斜删/行内码/链接/图片/列表/任务列表/
 * 表格/引用/代码块/水平线/脚注/公式/mermaid。
 */
export function generateDemoDoc(targetChars: number): string {
  const parts: string[] = [];

  parts.push(
    `# 墨卷 Tauri 版 · 渲染管线演示

这是 W3 阶段的渲染与虚拟滚动验证文档，覆盖 GFM 全集与扩展语法。

> 目标：千万字文档下滚动跟手、文本选择与复制可用、代码高亮不阻塞首屏。

## 一、基础排版

**加粗**、*斜体*、~~删除线~~、\`行内代码\`、[外部链接](https://example.com)、以及自动链接 https://tauri.app 。

### 三级标题
#### 四级标题
##### 五级标题
###### 六级标题

---

## 二、列表与任务列表

- 无序项一
- 无序项二
  - 嵌套项 2.1
  - 嵌套项 2.2
- 无序项三

1. 有序项一
2. 有序项二
3. 有序项三

- [x] 已完成的任务
- [ ] 未完成的任务
- [ ] 另一个待办

## 三、表格

| 功能 | 状态 | 备注 |
| --- | :---: | --- |
| 标题 | 完成 | h1-h6 |
| 表格 | 完成 | 支持对齐 |
| 任务列表 | 完成 | 只读复选框 |
| 代码高亮 | 完成 | Shiki 双主题 |
| 数学公式 | 完成 | KaTeX |
| 图表 | 完成 | mermaid |

## 四、代码块

\`\`\`rust
use std::collections::HashMap;

/// 计算词频（演示 Shiki 高亮）
fn word_count(text: &str) -> HashMap<&str, usize> {
    let mut map = HashMap::new();
    for word in text.split_whitespace() {
        *map.entry(word).or_insert(0) += 1;
    }
    map
}

fn main() {
    let m = word_count("a b a c b a");
    println!("{:?}", m);
}
\`\`\`

\`\`\`typescript
interface Block {
  id: string;
  index: number;
  html: string;
}

/** 按块渲染：只处理可见区间 */
export function renderVisible(blocks: Block[], start: number, end: number): string[] {
  return blocks.slice(start, end).map((b) => b.html);
}
\`\`\`

\`\`\`python
def fib(n: int) -> int:
    """斐波那契数列"""
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

print([fib(i) for i in range(10)])
\`\`\`

\`\`\`bash
# 启动开发服务器
npm run dev -- --host 127.0.0.1
\`\`\`

\`\`\`json
{
  "name": "mojuan-tauri",
  "version": "0.1.0",
  "private": true
}
\`\`\`

## 五、数学公式

行内公式 $E = mc^2$，以及 $\\int_0^1 x^2\\,dx = \\frac{1}{3}$。

块级公式：

$$
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
$$

矩阵：

$$
\\begin{pmatrix}
a & b \\\\
c & d
\\end{pmatrix}
\\cdot
\\begin{pmatrix}
x \\\\
y
\\end{pmatrix}
=
\\begin{pmatrix}
ax + by \\\\
cx + dy
\\end{pmatrix}
$$

## 六、Mermaid 图表

\`\`\`mermaid
graph LR
  A[Markdown 源文本] --> B[markdown-it 解析]
  B --> C[按顶级块切分]
  C --> D[虚拟滚动挂载]
  D --> E[可见块 Shiki 高亮]
  D --> F[可见块 mermaid 渲染]
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant U as 用户
  participant V as VirtualReader
  participant R as renderer
  U->>V: 滚动
  V->>R: enhanceBlockElement(可见块)
  R-->>V: 高亮 HTML
  V-->>U: 增量更新
\`\`\`

## 七、引用与脚注

> 阅读器不该让你意识到它的存在。
>
> —— 墨卷设计原则

脚注演示：Markdown 的块级切分需要处理引用块和脚注的交叉引用[^1]，以及脚注内的多段内容[^2]。

[^1]: 这是一个脚注。脚注在 markdown-it 里会被挪到文档末尾统一成块，切分时整块保留。

[^2]: 第二个脚注，用于验证多个脚注同块渲染。

## 八、长文压力区
`,
  );

  // 长文压力区：模拟真实文档结构（标题 + 段落 + 列表 + 引用 + 表格 + 代码 + 小节）
  let section = 1;
  let chars = parts.join("").length;
  while (chars < targetChars) {
    const chunk = `

## 第 ${section} 节 · 渲染压力测试

这是第 ${section} 节正文。墨卷的渲染管线在千万字文档里依然保持滚动丝滑，因为只有屏幕上看得见的块才会参与代码高亮与图表渲染；文本选择依赖真实 DOM 顺序，虚拟滚动不能打乱块序列。

- 第 ${section} 节要点一：块级虚拟滚动只挂载视口 ±5 屏
- 第 ${section} 节要点二：未测量块用估算高度，测量后校正不跳变
- 第 ${section} 节要点三：代码高亮结果按块缓存，滚动离开不丢弃

> 第 ${section} 节引用：性能不是靠优化出来的，是靠架构避免掉的。

| 指标 | 第 ${section} 节 | 说明 |
| --- | ---: | --- |
| 块数 | ${section * 7} | 累计估算 |
| 挂载数 | < 100 | DOM 节点目标 |

\`\`\`rust
fn section_${section}() -> usize {
    // 第 ${section} 节的示例函数
    ${section} * 42
}
\`\`\`
`;
    parts.push(chunk);
    chars += chunk.length;
    section++;
  }

  return parts.join("");
}
