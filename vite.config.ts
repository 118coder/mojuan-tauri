import { defineConfig, searchForWorkspaceRoot } from "vite";
import type { Plugin } from "vite";
import preact from "@preact/preset-vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import fs from "node:fs";
const host = process.env.TAURI_DEV_HOST;

/**
 * 开发期只读演示文件路由（W3 演示页专用）。
 * 原因：/@fs/ 对 .md 这类非已知静态类型会被 SPA fallback 吃掉，返回 index.html。
 * 这里显式提供 /__demo/huge.md，只服务 D:\cache\perf 下一个固定文件，
 * 不暴露任意路径读取；仅 dev server 生效，打包后不存在。
 */
function demoFilePlugin(): Plugin {
  return {
    name: "mojuan-demo-file",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__demo/huge.md", (req, res) => {
        const file = "D:/cache/perf/huge.md";
        try {
          const stat = fs.statSync(file);
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Content-Length", String(stat.size));
          res.setHeader("Cache-Control", "no-store");
          fs.createReadStream(file).pipe(res);
        } catch {
          res.statusCode = 404;
          res.end("demo file not found");
        }
        // req 未用，避免 lint 抱怨
        void req;
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [preact(), demoFilePlugin()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    fs: {
      // W3 演示页需要读取压测件 D:\cache\perf\huge.md（浏览器模式走 /@fs/ 通道）。
      // 只放行该目录，不放开全盘。
      allow: [searchForWorkspaceRoot(process.cwd()), "D:/cache/perf"],
    },
  },
}));
