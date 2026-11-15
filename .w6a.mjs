/**
 * W6a 导出功能无头自测（仿 .w4b.mjs，无头 Edge + puppeteer-core）
 * ---------------------------------------------------------------------------
 * 断言：
 *  1. buildStandaloneHtml 纯函数：产物含 <html>、<title> 标题、正文标题文本、KaTeX CDN；
 *  2. exportHtml 浏览器分支：blob 下载产物（fetch 回读）含 <html> 和标题文本；
 *  3. exportPng 浏览器分支：离屏全量容器截图 → PNG 魔数；截完离屏根清理；
 *  4. exportPdf / installPrintPreview：@media print 规则注入（style 标签 + CSSOM）、
 *     window.print 被调用、afterprint/定时清理归零；
 *  5. ExportMenu 组件四项渲染（独立挂载）+ buildExportMenuItems 数据级四项；
 *  6. App 真实挂接：右键菜单导出分组四项、命令面板「导出」过滤四条并真正跑通 HTML 导出；
 *  7. docx：浏览器 mock 的两条错误语义（演示文档 / 需桌面应用）——真调用标「待真窗」。
 * 注：无头浏览器无 Tauri runtime，写盘路径（plugin-fs/save_doc/export_docx）在真窗验证。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';

const PORT = 1421;
const BASE = `http://localhost:${PORT}/`;

/* ------------------------------ 起 vite dev server ------------------------------ */
// 直接用 node 起 vite bin（Node 20+ spawn .cmd 必须 shell:true，绕开）
const vite = spawn(process.execPath,
  ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'],
  { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
let viteOut = '';
vite.stdout.on('data', (d) => { viteOut += d; });
vite.stderr.on('data', (d) => { viteOut += d; });
const waitVite = async () => {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return true;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
const up = await waitVite();
if (!up) {
  console.log('FAIL vite.boot', viteOut.slice(-600));
  vite.kill();
  process.exit(1);
}
console.log('VITE_READY', BASE);

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1380, height: 860 }, protocolTimeout: 60000,
});

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS', name, extra); }
  else { fail++; console.log('FAIL', name, extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
// 400+ 响应噪音单独记（vite 资源缺失等）
page.on('response', (r) => { if (r.status() >= 500) errs.push(r.status() + ' ' + r.url()); });

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="welcome"]', { timeout: 30000 });
  console.log('READY');

  // ---------- 0. 环境补丁：捕获下载 anchor + window.print 调用 ----------
  await page.evaluate(() => {
    const w = window;
    w.__mjCapture = [];
    w.__mjPrintCalled = 0;
    const origCreate = document.createElement.bind(document);
    document.createElement = function (tag, ...rest) {
      const el = origCreate(tag, ...rest);
      if (String(tag).toLowerCase() === 'a') {
        const origClick = el.click.bind(el);
        el.click = () => {
          w.__mjCapture.push({ name: el.download || '', href: el.href || '' });
          // 不真下载，只记录
        };
      }
      return el;
    };
    w.print = () => { w.__mjPrintCalled++; };
  });

  // mock 文档原文（导出源）
  const mdRaw = await page.evaluate(async () => {
    const { api } = await import('/src/lib/backend.ts');
    const doc = await api.readDoc('D:/笔记/欢迎使用墨卷.md');
    return doc.raw;
  });
  ok('mock.raw', mdRaw.includes('欢迎使用墨卷') && mdRaw.length > 100, `len=${mdRaw.length}`);

  // ---------- 1. buildStandaloneHtml 纯函数 ----------
  const html1 = await page.evaluate(async (md) => {
    const m = await import('/src/lib/exporters.ts');
    const tab = {
      path: 'D:/笔记/欢迎使用墨卷.md', name: '欢迎使用墨卷.md', title: '欢迎使用墨卷',
      content: md, blocks: null, isPlain: false, theme: 'light',
    };
    return m.buildStandaloneHtml(tab);
  }, mdRaw);
  ok('html.doctype', html1.includes('<html lang="zh-CN"') && html1.includes('<!doctype html>'));
  ok('html.title', html1.includes('<title>欢迎使用墨卷 · 墨卷导出</title>'), html1.match(/<title>[^<]*<\/title>/)?.[0] ?? '');
  ok('html.heading', html1.includes('欢迎使用墨卷'));
  ok('html.katexCdn', html1.includes('cdn.jsdelivr.net/npm/katex') && html1.includes('katex.min.css'));
  ok('html.theme', html1.includes('data-theme="light"'));
  ok('html.codeStatic', html1.includes('mj-code-block'), '代码块容器样式/结构在产物中');

  // ---------- 2. exportHtml 浏览器分支：blob 产物断言 ----------
  const capBefore = await page.evaluate(() => window.__mjCapture.length);
  await page.evaluate(async (md) => {
    const m = await import('/src/lib/exporters.ts');
    const tab = {
      path: 'D:/笔记/欢迎使用墨卷.md', name: '欢迎使用墨卷.md', title: '欢迎使用墨卷',
      content: md, blocks: null, isPlain: false, theme: 'light',
    };
    const r = await m.exportHtml(tab, {});
    window.__mjLastResult = r;
  }, mdRaw);
  const capAfter = await page.evaluate(() => window.__mjCapture.length);
  ok('exportHtml.download', capAfter === capBefore + 1, `capture=${capAfter}`);
  const blobHtml = await page.evaluate(async () => {
    const c = window.__mjCapture[window.__mjCapture.length - 1];
    const res = await fetch(c.href);
    return { name: c.name, text: await res.text() };
  });
  ok('exportHtml.name', blobHtml.name === '欢迎使用墨卷.html', blobHtml.name);
  ok('exportHtml.blobHtml', blobHtml.text.includes('<html') && blobHtml.text.includes('欢迎使用墨卷'),
    `len=${blobHtml.text.length}`);

  // ---------- 3. exportPng 浏览器分支：PNG 魔数 + 离屏清理 ----------
  const png = await page.evaluate(async (md) => {
    const m = await import('/src/lib/exporters.ts');
    const tab = {
      path: 'D:/笔记/欢迎使用墨卷.md', name: '欢迎使用墨卷.md', title: '欢迎使用墨卷',
      content: md, blocks: null, isPlain: false, theme: 'dark',
    };
    const r = await m.exportPng(tab, {});
    window.__mjLastPngResult = { ok: r.ok, message: r.message };
    const c = window.__mjCapture[window.__mjCapture.length - 1];
    const res = await fetch(c.href);
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      name: c.name,
      magic: [buf[0], buf[1], buf[2], buf[3]],
      offscreenLeft: document.querySelectorAll('[data-mj-export]').length,
    };
  }, mdRaw);
  ok('exportPng.magic', png.magic[0] === 0x89 && png.magic[1] === 0x50 && png.magic[2] === 0x4e && png.magic[3] === 0x47,
    `magic=${png.magic}`);
  ok('exportPng.name', png.name === '欢迎使用墨卷.png', png.name);
  ok('exportPng.cleanup', png.offscreenLeft === 0, `roots=${png.offscreenLeft}`);

  // ---------- 4. exportPdf：print CSS 注入 + window.print 调用 + 清理 ----------
  const pdf = await page.evaluate(async (md) => {
    const m = await import('/src/lib/exporters.ts');
    const tab = {
      path: 'D:/笔记/欢迎使用墨卷.md', name: '欢迎使用墨卷.md', title: '欢迎使用墨卷',
      content: md, blocks: null, isPlain: false, theme: 'dark',
    };
    const r = await m.exportPdf(tab, { confirm: async () => true, progress: () => {} });
    // print 调用后立即可观察（before 兜底定时 1.5s 清理）
    const style = document.querySelector('style[data-mj-print]');
    const root = document.querySelector('[data-mj-export]');
    let mediaRule = false;
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.media && rule.media.mediaText.includes('print')) { mediaRule = true; break; }
        }
      } catch { /* 跨域 sheet 跳过 */ }
      if (mediaRule) break;
    }
    return {
      ok: r.ok, message: r.message,
      styleExists: !!style, styleHasPrint: style ? style.textContent.includes('@media print') : false,
      styleHasHideShell: style ? style.textContent.includes('.app-frame') : false,
      rootExists: !!root, rootBlocks: root ? root.querySelectorAll('.mj-export-block').length : 0,
      mediaRule,
      printCalled: window.__mjPrintCalled,
    };
  }, mdRaw);
  ok('exportPdf.printCalled', pdf.printCalled >= 1, `called=${pdf.printCalled}`);
  ok('exportPdf.styleInjected', pdf.styleExists && pdf.styleHasPrint, 'style[data-mj-print] + @media print');
  ok('exportPdf.hideShell', pdf.styleHasHideShell, 'print CSS 隐藏 .app-frame');
  ok('exportPdf.cssomMediaRule', pdf.mediaRule, 'CSSOM 中存在 print media rule');
  ok('exportPdf.rootMounted', pdf.rootExists && pdf.rootBlocks > 0, `blocks=${pdf.rootBlocks}`);
  ok('exportPdf.message', /打印对话框|另存为 PDF/.test(pdf.message), pdf.message);
  await sleep(2000);
  const pdfClean = await page.evaluate(() => ({
    style: document.querySelectorAll('style[data-mj-print]').length,
    root: document.querySelectorAll('[data-mj-export]').length,
  }));
  ok('exportPdf.cleanup', pdfClean.style === 0 && pdfClean.root === 0, JSON.stringify(pdfClean));

  // ---------- 5. installPrintPreview 独立断言 + cleanup ----------
  const preview = await page.evaluate(async (md) => {
    const m = await import('/src/lib/exporters.ts');
    const tab = {
      path: null, name: '演示文档', title: '演示文档',
      content: '# 演示标题\n\n正文一段。\n', blocks: null, isPlain: false, theme: 'light',
    };
    const h = m.installPrintPreview(tab, { enhance: false });
    const state = {
      style: !!document.querySelector('style[data-mj-print]'),
      root: !!document.querySelector('[data-mj-export]'),
      blocks: h.root.querySelectorAll('.mj-export-block').length,
    };
    h.cleanup();
    state.afterStyle = document.querySelectorAll('style[data-mj-print]').length;
    state.afterRoot = document.querySelectorAll('[data-mj-export]').length;
    return state;
  }, mdRaw);
  ok('preview.mount', preview.style && preview.root && preview.blocks >= 2, JSON.stringify(preview));
  ok('preview.cleanup', preview.afterStyle === 0 && preview.afterRoot === 0);

  // ---------- 6. ExportMenu：数据级四项 + 组件渲染四项 ----------
  const menuData = await page.evaluate(async () => {
    const m = await import('/src/components/ExportMenu.tsx');
    const items = m.buildExportMenuItems(() => null, {});
    return {
      count: items.length,
      labels: items.map((i) => i.label),
      runnable: items.every((i) => typeof i.action === 'function'),
    };
  });
  ok('menu.data4', menuData.count === 4 && menuData.runnable, menuData.labels.join(' / '));
  ok('menu.labels', menuData.labels.join(',').includes('HTML') && menuData.labels.join(',').includes('Word')
    && menuData.labels.join(',').includes('PDF') && menuData.labels.join(',').includes('PNG'));

  // 组件渲染：必须用与 ExportMenu.tsx 同一个 preact 实例——
  // 从 dev server 转换产物里抓出它实际引用的 deps URL（含 ?v= hash）
  let compRender = null;
  try {
    compRender = await page.evaluate(async () => {
      const mod = await import('/src/components/ExportMenu.tsx');
      const src = await (await fetch('/src/components/ExportMenu.tsx')).text();
      // dev 模式 deps URL 统一带 ?v=hash；用同 hash 拼 preact.js 才是同一实例
      const vh = src.match(/\.vite\/deps\/[a-z_]+\.js\?v=([0-9a-f]+)/);
      const preactMod = await import(`/node_modules/.vite/deps/preact.js${vh ? `?v=${vh[1]}` : ''}`);
      const host = document.createElement('div');
      host.setAttribute('data-mj-test-host', '');
      document.body.appendChild(host);
      const getTab = () => ({ path: null, name: 'x.md', title: 'x', content: '# t', blocks: null, isPlain: false, theme: 'light' });
      preactMod.render(preactMod.h(mod.ExportMenu, { getTab }), host);
      const trigger = host.querySelector('[data-testid="export-menu-trigger"]');
      if (!trigger) return { ok: false, why: 'no trigger' };
      trigger.click();
      await new Promise((r) => setTimeout(r, 120));
      const menu = host.querySelector('[data-testid="export-menu"]');
      const kinds = [...(menu?.querySelectorAll('[data-export-kind]') ?? [])].map((e) => e.getAttribute('data-export-kind'));
      preactMod.render(null, host);
      host.remove();
      return { ok: kinds.length === 4, kinds };
    });
  } catch (e) {
    compRender = { ok: false, why: String(e).slice(0, 120) };
  }
  ok('menu.component4', !!compRender?.ok, JSON.stringify(compRender));

  // ---------- 7. App 真实挂接：右键菜单导出分组 + Palette 四条 + 真跑导出 ----------
  // 打开 mock 文档（文件树双击）
  await page.waitForSelector('.tree-row', { timeout: 15000 });
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.tree-row')].find((e) => e.textContent?.includes('欢迎使用墨卷.md'));
    row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await page.waitForSelector('.mj-block', { timeout: 20000 });
  await sleep(400);

  // 右键菜单（合成 contextmenu，参考 .w4b.mjs）
  await page.evaluate(() => {
    const wrap = document.querySelector('.reader-wrap') ?? document.querySelector('.mj-reader');
    wrap?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 300 }));
  });
  await page.waitForSelector('.ctx-menu', { timeout: 5000 });
  const ctxLabels = await page.$$eval('.ctx-menu .menu-item', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  const ctxExport = ctxLabels.filter((l) => l.includes('导出为'));
  ok('ctx.exportGroup', ctxExport.length === 4, ctxExport.join(' / '));
  await page.keyboard.press('Escape');
  await sleep(200);

  // Palette：Ctrl+P → 输入「导出」→ 四条命令
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyP');
  await page.keyboard.up('Control');
  await page.waitForSelector('.palette', { timeout: 5000 });
  await page.evaluate(() => {
    const input = document.querySelector('.pal-input');
    input.value = '导出';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  const palRows = await page.$$eval('.pal-row', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  const palExport = palRows.filter((l) => l.includes('导出'));
  ok('palette.export4', palExport.length === 4, palExport.join(' / '));

  // 点「导出为 HTML…」真跑一次（浏览器分支 → anchor 捕获 +1）
  const capBeforePal = await page.evaluate(() => window.__mjCapture.length);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.pal-row')].find((e) => e.textContent?.includes('导出为 HTML'));
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await sleep(1200);
  const capAfterPal = await page.evaluate(() => window.__mjCapture.length);
  ok('palette.runHtml', capAfterPal === capBeforePal + 1, `capture ${capBeforePal}->${capAfterPal}`);
  await page.keyboard.press('Escape');
  await sleep(200);

  // ---------- 8. docx 语义（浏览器 mock）：演示文档 / 需桌面应用 —— 真调用待真窗 ----------
  const docx = await page.evaluate(async () => {
    const m = await import('/src/lib/exporters.ts');
    const out = {};
    try {
      await m.exportDocx({ path: null, name: '演示文档', title: '演示文档', content: '# x', blocks: null, isPlain: false, theme: 'light' }, {});
      out.demo = 'no-error';
    } catch (e) {
      out.demo = e instanceof Error ? e.message : String(e);
    }
    try {
      await m.exportDocx({ path: 'D:/笔记/欢迎使用墨卷.md', name: '欢迎使用墨卷.md', title: '欢迎使用墨卷', content: '# x', blocks: null, isPlain: false, theme: 'light' }, { saveFile: async () => 'D:/out.docx' });
      out.saved = 'no-error';
    } catch (e) {
      out.saved = e instanceof Error ? e.message : String(e);
    }
    return out;
  });
  ok('docx.demoError', /演示文档无法导出/.test(docx.demo), docx.demo);
  ok('docx.needsTauri', /桌面应用/.test(docx.saved), `${docx.saved} —— 真调用「待真窗」`);

  // ---------- 9. 页面错误收集（导出管线不应产生未捕获异常） ----------
  ok('page.clean', errs.length === 0, errs.slice(0, 4).join(' | '));
} catch (e) {
  fail++;
  console.log('FAIL script.aborted', String(e).slice(0, 400));
}

await browser.close();
vite.kill();
console.log(`\nW6a RESULT pass=${pass} fail=${fail} (${Date.now() % 100000}ms)`);
process.exit(fail === 0 ? 0 : 1);
