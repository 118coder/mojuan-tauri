/**
 * 第三方 markdown-it 插件的类型补充声明。
 * markdown-it-footnote / markdown-it-task-lists 自身不带 TypeScript 类型，
 * 这里按实际导出签名补最小声明，供严格模式使用。
 */

declare module "markdown-it-footnote" {
  import type { MarkdownIt } from "markdown-it";
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module "markdown-it-task-lists" {
  import type { MarkdownIt } from "markdown-it";

  interface TaskListOptions {
    /** true = 复选框可点击（会写回源码），默认 false 只读 */
    enabled?: boolean;
    /** 是否包 <label>，默认 false */
    label?: boolean;
    /** label 是否放在文字之后，默认 false */
    labelAfter?: boolean;
  }

  const plugin: (md: MarkdownIt, options?: TaskListOptions) => void;
  export default plugin;
}
