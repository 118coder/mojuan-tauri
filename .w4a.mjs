/**
 * W4a 验收测试（右键菜单 + 查找 + 缩放 + 复制映射）
 * 结构仿 .w3bench3.mjs：无头 Edge + puppeteer-core，连 vite dev server（1420）。
 * 断言清单（任务要求）：
 *  1. 右键 → 菜单 DOM 出现且含「复制为 Markdown」；
 *  2. 选中文本后右键 → window.getSelection() 仍非空（铁律 2.1-1）；
 *  3. 点击菜单「复制」后选区仍非空（铁律 2.1-4）；
 *  4. 查找输入「章节」→ 页面 .mj-block 里 mark 数>0 且计数显示 N。
 * 另覆盖：无选区菜单与清选区、边缘钳位、图片/链接/代码块菜单、浮层、
 *          srcMd 精确切片、currentHit/applyCurrentHit、大小写开关、字号缩放、favicon。
 * 说明：App.tsx（W4b）里已有 ContextMenuStub——本测试把正式组件动态挂到
 *       #w4a-mount，所有菜单断言限定作用域，不受 Stub 影响；菜单项用真实鼠标点击
 *       （走 pointerdown preventDefault 路径，真实验证铁律 4）。
 */
import puppeteer from 'puppeteer-core';

const ORIGIN = 'http://localhost:1420';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 760 },
  protocolTimeout: 90000, // App 主线程偶发忙（并行开发 + 22MB 演示件解析），放宽 CDP 超时
});
// 剪贴板读写权限（复制/复制为 Markdown 的实际内容验证用）
await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);

const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('__demo')) errs.push(r.status() + ' ' + r.url()); });

const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail: String(detail).slice(0, 200) });
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t0 = Date.now();
await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
// 等应用可交互：W4b 新 UI 默认欢迎页，需要点「加载演示文档」打开阅读区
let appReady = true;
try {
  await page.waitForSelector('.mj-reader', { timeout: 6000 });
} catch {
  try {
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, .ghost, [class*="btn"]')).find((el) =>
        (el.textContent ?? '').includes('加载演示文档'),
      );
      if (btn) btn.click();
      return !!btn;
    });
    await page.waitForSelector('.mj-reader', { timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll('.mj-block').length > 0, { timeout: 30000 });
  } catch {
    appReady = false;
  }
}
const readyMs = Date.now() - t0;
console.log('READY_MS', readyMs, 'appReady=' + appReady);

/* ------------------------------------------------------------------ */
/* 挂载正式 ContextMenu（W4b 未换 import 前，动态挂载验证组件本身）        */
/* ------------------------------------------------------------------ */
await page.evaluate(async () => {
  window.__w4aMount = async () => {
  // 幂等：清掉旧挂载
  for (const id of ['w4a-mount', 'w4a-fixture0', 'w4a-fixture1', 'w4a-media', 'w4a-blank', 'w4a-blank-right']) {
    document.getElementById(id)?.remove();
  }
  const mainSrc = await (await fetch('/src/main.tsx')).text();
  const m = mainSrc.match(/from\s*"([^"]+\/preact\.js[^"]*)"/);
  const preactUrl = m ? m[1] : '/node_modules/.vite/deps/preact.js';
  const P = await import(preactUrl);
  const { ContextMenu } = await import('/src/components/ContextMenu.tsx');
  // 关键：从组件的转换后源码里提取它们实际 import 的 renderer URL（vite HMR 会给
  // 失效模块加 ?t= 时间戳，直接 import 裸路径可能拿到另一个实例，WeakMap 互不相通）
  const modUrlOf = async (srcPath) => {
    const src = await (await fetch(srcPath)).text();
    const mm = src.match(/from\s*"([^"]*lib\/renderer[^"]*)"/);
    return mm ? mm[1] : '/src/lib/renderer.ts';
  };
  const cmRUrl = await modUrlOf('/src/components/ContextMenu.tsx');
  const fbRUrl = await modUrlOf('/src/components/FindBar.tsx');
  const Rcm = await import(cmRUrl);
  const Rfb = cmRUrl === fbRUrl ? Rcm : await import(fbRUrl);
  console.info('[w4a] renderer 实例 URL 相同 =', cmRUrl === fbRUrl);
  window.__P = P;
  window.__R = Rfb;
  window.__Rcm = Rcm;
  window.__cm = { findCalls: [] };
  // 给渲染器灌一份已知源码（复制为 Markdown 的块源，独立于 App 状态）
  const md = [
    '# 章节一',
    '这一段介绍章节概要。',
    '',
    '## 章节二',
    '这一段讲章节查找。',
    '',
    '普通段落没有关键词。',
    'Find me FIND me find me.',
    '',
    '```js',
    'const 章节 = 1;',
    '```',
    '',
  ].join('\n');
  window.__seedMd = md;
  window.__seedBlocks = Rcm.renderBlocks(md, {});
  const host = document.createElement('div');
  host.id = 'w4a-mount';
  document.body.appendChild(host);
  P.render(P.h(ContextMenu, {
    onFind: (q) => window.__cm.findCalls.push(q ?? ''),
    getFilePath: () => null, // 浏览器演示模式拿不到路径：应置灰
    blocks: window.__seedBlocks, // 显式传块源：App 的 renderBlocks 会随时覆盖全局最近渲染缓存
  }), host);
  // 可选文本 fixture（块 0 / 块 1，带 data-block-index 以打通 srcMd 查找）
  const mkFixture = (idx, top, html) => {
    const f = document.createElement('div');
    f.className = 'mj-block';
    f.setAttribute('data-block-index', String(idx));
    f.id = 'w4a-fixture' + idx;
    f.style.cssText = `position:fixed;left:60px;top:${top}px;width:640px;z-index:500;background:#f3f3f3;color:#111;padding:12px;font-size:16px;`;
    f.innerHTML = html;
    document.body.appendChild(f);
    return f;
  };
  mkFixture(0, 180, '<div class="mj-block-inner"><p>墨卷右键验证段落甲：请在此选中文本后右键。</p></div>');
  mkFixture(1, 300, '<div class="mj-block-inner"><p>墨卷右键验证段落乙：跨块选择的目标文本。</p></div>');
  // 空白 fixture（无文本/图片/链接/代码块 → 无选区菜单）。
  // 注意：所有右键都落在 body 级 fixture 上，事件不冒泡经过 .reader-wrap，
  // 避开 W4b App 当前的 readerMenu 死循环 bug（详见报告）。
  const blank = document.createElement('div');
  blank.id = 'w4a-blank';
  blank.style.cssText = 'position:fixed;left:820px;top:640px;width:260px;height:70px;z-index:500;background:#ddd;';
  document.body.appendChild(blank);
  const blankRight = document.createElement('div');
  blankRight.id = 'w4a-blank-right';
  blankRight.style.cssText = 'position:fixed;left:1220px;top:330px;width:52px;height:70px;z-index:500;background:#ddd;';
  document.body.appendChild(blankRight);
  // 图片 / 链接 / 代码块 fixture
  const media = document.createElement('div');
  media.id = 'w4a-media';
  media.style.cssText = 'position:fixed;left:60px;top:420px;z-index:500;background:#f3f3f3;padding:12px;';
  media.innerHTML =
    '<img id="w4a-img" width="36" height="36" alt="测试图" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" />' +
    ' <a id="w4a-link" href="https://example.com/mojuan">测试链接</a>' +
    '<div class="mj-code-block" id="w4a-code"><div class="mj-code-head"><span class="mj-code-lang">js</span></div>' +
    '<pre class="mj-code-plain"><code>const mojuanMenu = true;</code></pre></div>';
  document.body.appendChild(media);
  };
  await window.__w4aMount();
});
/** HMR 整页刷新会清掉动态挂载：每个测试段前确保挂载存在 */
const ensureMounted = async () => {
  const alive = await page.evaluate(() => !!document.getElementById('w4a-mount') && !!window.__seedBlocks);
  if (!alive) await page.evaluate(() => window.__w4aMount());
};

const seeds = await page.evaluate(() => ({
  md0: window.__seedBlocks[0].srcMd,
  md1: window.__seedBlocks[1].srcMd,
  mdCount: window.__seedBlocks.length,
}));

/* --- 作用域限定到我的挂载点（页面上另有 W4b 的 Stub 菜单） --- */
const menuOpen = async () => page.waitForSelector('#w4a-mount .ctx-menu', { timeout: 3000 });
const menuGone = async () => page.waitForFunction(() => !document.querySelector('#w4a-mount .ctx-menu'), { timeout: 3000 });
const menuText = () => page.evaluate(() => document.querySelector('#w4a-mount .ctx-menu')?.textContent ?? '');
const menuLabels = () => page.evaluate(() =>
  Array.from(document.querySelectorAll('#w4a-mount .ctx-menu .menu-item > span:first-child')).map((s) => s.textContent));
/** 真实鼠标点击我的菜单项（走完整 pointerdown→click 事件流） */
const clickMyItem = async (labelPart, exact = false) => {
  const pt = await page.evaluate((lbl, ex) => {
    const items = Array.from(document.querySelectorAll('#w4a-mount .ctx-menu .menu-item'));
    const el = items.find((e) => {
      const t = (e.querySelector('span')?.textContent ?? '').trim();
      return ex ? t === lbl : t.includes(lbl);
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, labelPart, exact);
  if (!pt) throw new Error('menu item not found: ' + labelPart);
  await page.mouse.click(pt.x, pt.y);
  await sleep(150);
};
const selText = () => page.evaluate(() => window.getSelection()?.toString() ?? '');
// Windows 剪贴板读回时 Chromium 会把 \n 规范成 \r\n（读侧行为，写入侧是 \n）：
// 断言统一归一化
const clip = () => page.evaluate(async () => ((await navigator.clipboard.readText()) ?? '').replace(/\r\n/g, '\n'));
const clearClip = () => page.evaluate(() => navigator.clipboard.writeText(''));

await ensureMounted();
/* ---------------- T1 无选区右键：无选区菜单 ---------------- */
await clearClip();
await page.mouse.click(940, 680, { button: 'right' }); // w4a-blank（body 级，不经 reader-wrap）
await menuOpen();
ok('T1 右键出现自定义菜单（.ctx-menu DOM）', true);
{
  const labels = await menuLabels();
  ok('T1 无选区菜单含 查找/打开所在文件夹/重新加载', ['查找', '打开所在文件夹', '重新加载'].every((l) => labels.includes(l)), labels.join(','));
}
ok('T1 无选区菜单不含「复制为 Markdown」', !(await menuText()).includes('复制为 Markdown'));
ok('T1 打开所在文件夹 置灰（无路径）', await page.evaluate(() => {
  const it = Array.from(document.querySelectorAll('#w4a-mount .ctx-menu .menu-item')).find((el) => el.textContent.includes('打开所在文件夹'));
  return !!it && it.classList.contains('disabled');
}));
ok('T1 菜单 user-select:none（铁律：菜单文字不可选中）', await page.evaluate(() => {
  const m = document.querySelector('#w4a-mount .ctx-menu');
  return m && getComputedStyle(m).userSelect === 'none';
}));
await clickMyItem('查找', true);
ok('T1 点查找回调 onFind 且菜单关闭', await page.evaluate(() => window.__cm.findCalls.length === 1) && (await menuGone().then(() => true).catch(() => false)), JSON.stringify(await page.evaluate(() => window.__cm.findCalls)));

await ensureMounted();
/* ---------------- T2 选区内右键：选区保留（铁律 1） ---------------- */
await page.evaluate(() => {
  const p = document.querySelector('#w4a-fixture0 p').firstChild;
  const sel = document.getSelection();
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(p, 4); r.setEnd(p, 16); // 「右键验证段落甲」一段
  sel.addRange(r);
});
const t2sel = await selText();
const pt = await page.evaluate(() => {
  const rect = document.getSelection().getRangeAt(0).getBoundingClientRect();
  return { x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) };
});
await page.mouse.click(pt.x, pt.y, { button: 'right' });
await menuOpen();
ok('T2 有选区菜单含「复制为 Markdown」', (await menuText()).includes('复制为 Markdown'));
const labels2 = await menuLabels();
ok('T2 菜单顺序=复制/复制为Markdown/页内搜索/全选', labels2.slice(0, 4).join('|') === '复制|复制为 Markdown|在页内搜索所选文字|全选', labels2.join(','));
ok('T2 菜单项标注快捷键（Ctrl+C / Ctrl+Shift+C / Ctrl+A）', await page.evaluate(() => {
  const sc = Array.from(document.querySelectorAll('#w4a-mount .ctx-menu .menu-item .shortcut')).map((s) => s.textContent);
  return sc.includes('Ctrl+C') && sc.includes('Ctrl+Shift+C') && sc.includes('Ctrl+A');
}), JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('#w4a-mount .ctx-menu .menu-item .shortcut')).map((s) => s.textContent))));
ok('T2 选区内右键选区保留（铁律 2.1-1）', (await selText()) === t2sel && t2sel.length > 0, JSON.stringify(await selText()));

/* ---------------- T2b 点「在页内搜索所选文字」→ onFind(选中文本) ---------------- */
await clickMyItem('在页内搜索所选文字');
ok('T2b 页内搜索把选中文本带给 onFind', await page.evaluate((t) => window.__cm.findCalls[window.__cm.findCalls.length - 1] === t, t2sel), JSON.stringify(await page.evaluate(() => window.__cm.findCalls)));
ok('T2b 点菜单后选区仍保留', (await selText()) === t2sel);

await ensureMounted();
/* ---------------- T3 点「复制」→ 选区保留 + 剪贴板=选中文本（铁律 4） ---------------- */
await page.mouse.click(pt.x, pt.y, { button: 'right' });
await menuOpen();
await clearClip();
await clickMyItem('复制', true);
ok('T3 点「复制」后选区仍非空（铁律 2.1-4）', (await selText()) === t2sel, JSON.stringify(await selText()));
const copied = await clip();
ok('T3 剪贴板=选中文本', copied === t2sel, JSON.stringify(copied));

await ensureMounted();
/* ---------------- T4 复制为 Markdown：单块与跨块 ---------------- */
await page.mouse.click(pt.x, pt.y, { button: 'right' });
await menuOpen();
await clearClip();
await clickMyItem('复制为 Markdown');
ok('T4 复制为 Markdown=块0 srcMd（单块）', (await clip()) === seeds.md0, JSON.stringify(await clip()));

// 跨块：锚点在块0、焦点在块1
await page.evaluate(() => {
  const a = document.querySelector('#w4a-fixture0 p').firstChild;
  const b = document.querySelector('#w4a-fixture1 p').firstChild;
  const sel = document.getSelection();
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(a, 4); r.setEnd(b, 10);
  sel.addRange(r);
});
const crossPt = await page.evaluate(() => {
  const rects = document.getSelection().getRangeAt(0).getClientRects();
  const first = rects[0];
  return { x: Math.round((first.left + first.right) / 2), y: Math.round((first.top + first.bottom) / 2) };
});
await page.mouse.click(crossPt.x, crossPt.y, { button: 'right' });
await menuOpen();
await clearClip();
await clickMyItem('复制为 Markdown');
ok('T4 跨块复制为 Markdown=块0+块1 按序拼接', (await clip()) === seeds.md0 + '\n\n' + seeds.md1, JSON.stringify(await clip()));

await ensureMounted();
/* ---------------- T5 选区外右键：清选区 + 无选区菜单（铁律 2） ---------------- */
await page.mouse.click(1000, 685, { button: 'right' });
await menuOpen();
ok('T5 选区外右键清除选区（铁律 2.1-2）', (await selText()) === '', JSON.stringify(await selText()));
{
  const labels5 = await menuLabels();
  ok('T5 出无选区菜单（查找/打开所在文件夹/重新加载）', ['查找', '打开所在文件夹', '重新加载'].every((l) => labels5.includes(l)), labels5.join(','));
}

await ensureMounted();
/* ---------------- T6 出屏钳位（边缘翻转） ---------------- */
await page.keyboard.press('Escape');
await sleep(120);
await page.mouse.click(1264, 360, { button: 'right' }); // w4a-blank-right，贴近视口右缘
await menuOpen();
const rightEdge = await page.evaluate(() => {
  const r = document.querySelector('#w4a-mount .ctx-menu').getBoundingClientRect();
  return { right: r.right, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight };
});
ok('T6 靠右边缘菜单不出屏', rightEdge.right <= rightEdge.vw, JSON.stringify(rightEdge));
await page.keyboard.press('Escape');
await sleep(120);
await page.mouse.click(640, 745, { button: 'right' }); // 状态栏区域（无 handler），贴近视口下缘
await menuOpen();
const bottomEdge = await page.evaluate(() => {
  const r = document.querySelector('#w4a-mount .ctx-menu').getBoundingClientRect();
  return { bottom: r.bottom, vh: window.innerHeight };
});
ok('T6 靠下边缘菜单向上翻不出屏', bottomEdge.bottom <= bottomEdge.vh, JSON.stringify(bottomEdge));

await ensureMounted();
/* ---------------- T7 图片 / 链接 / 代码块菜单 + 放大浮层 ---------------- */
await page.keyboard.press('Escape');
await sleep(120);
const imgPt = await page.evaluate(() => {
  const r = document.querySelector('#w4a-img').getBoundingClientRect();
  return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
});
await page.mouse.click(imgPt.x, imgPt.y, { button: 'right' });
await menuOpen();
{
  const l7 = await menuLabels();
  ok('T7 图片菜单=复制图片/复制图片地址/在新浮层放大', l7.join(',') === '复制图片,复制图片地址,在新浮层放大', l7.join(','));
}
await clickMyItem('在新浮层放大');
ok('T7 在新浮层放大出现 .mj-lightbox', await page.evaluate(() => !!document.querySelector('.mj-lightbox img')));
await page.keyboard.press('Escape');
await sleep(150);
ok('T7 Esc 关闭放大浮层', await page.evaluate(() => !document.querySelector('.mj-lightbox')));

const linkPt = await page.evaluate(() => {
  const r = document.querySelector('#w4a-link').getBoundingClientRect();
  return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
});
await page.mouse.click(linkPt.x, linkPt.y, { button: 'right' });
await menuOpen();
{
  const l8 = await menuLabels();
  ok('T7 链接菜单=打开/复制链接地址', l8.join(',') === '打开,复制链接地址', l8.join(','));
}
await clearClip();
await clickMyItem('复制链接地址');
ok('T7 复制链接地址=绝对地址', (await clip()) === 'https://example.com/mojuan', await clip());

const codePt = await page.evaluate(() => {
  const r = document.querySelector('#w4a-code').getBoundingClientRect();
  return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
});
await page.mouse.click(codePt.x, codePt.y, { button: 'right' });
await menuOpen();
{
  const l9 = await menuLabels();
  ok('T7 代码块菜单=复制代码内容', l9.join(',') === '复制代码内容', l9.join(','));
}
await clearClip();
await clickMyItem('复制代码内容');
ok('T7 复制代码内容=代码文本', (await clip()) === 'const mojuanMenu = true;', await clip());

await ensureMounted();
/* ---------------- T8 查找条：输入「章节」→ mark 高亮 + 计数 ---------------- */
await page.evaluate(async () => {
  const P = window.__P;
  const { FindBar } = await import('/src/components/FindBar.tsx');
  const R = window.__R;
  window.__fb = { query: [], jump: [], close: [], cs: [], blocks: null, navTick: 0, open: undefined };
  const host = document.createElement('div');
  host.id = 'w4a-findbar';
  host.style.cssText = 'position:fixed;left:0;top:0;z-index:1200;';
  document.body.appendChild(host);
  // 模拟 W4b 接线（blocks 兼容路径）：onQueryChange → renderBlocks({query}) → 注入 .mj-block → blocks 回传计数
  window.__fbRender = () => {
    P.render(P.h(FindBar, {
      onQueryChange: (q) => {
        window.__fb.query.push(q);
        const blocks = R.renderBlocks(window.__seedMd, { query: q || undefined, currentHit: 0 });
        window.__fb.blocks = blocks;
        let box = document.getElementById('w4a-find');
        if (!box) {
          box = document.createElement('div');
          box.id = 'w4a-find';
          box.style.cssText = 'position:fixed;left:60px;top:540px;width:640px;z-index:500;background:#f3f3f3;color:#111;padding:12px;';
          document.body.appendChild(box);
        }
        box.innerHTML = blocks.map((b) => `<div class="mj-block"><div class="mj-block-inner">${b.html}</div></div>`).join('');
        window.__fbRender();
      },
      onJump: (d) => window.__fb.jump.push(d),
      onClose: () => {
        window.__fb.close.push(1);
        window.__fb.open = false; // 真实 W4b 接线：关闭即 setFindOpen(false) → 卸载
        window.__fbRender();
      },
      onCaseSensitiveChange: (v) => window.__fb.cs.push(v),
      open: window.__fb.open,
      blocks: window.__fb.blocks,
      navTick: window.__fb.navTick,
    }), host);
  };
  window.__fbSetNav = (t) => { window.__fb.navTick = t; window.__fbRender(); };
  window.__fbSetOpen = (v) => { window.__fb.open = v; window.__fbRender(); };
  window.__fbRender();
});
await sleep(200);
const input = await page.$('#w4a-findbar input');
await input.click();
await page.keyboard.type('章节', { delay: 40 });
await sleep(250);
const markCount = await page.evaluate(() => document.querySelectorAll('.mj-block mark[data-hit]').length);
ok('T8 查找「章节」→ .mj-block 内 mark 数>0', markCount > 0, 'markCount=' + markCount);
ok('T8 计数显示 1 / 4（blocks 统计路径）', (await page.evaluate(() => document.querySelector('#w4a-findbar .find-count')?.textContent)) === '1 / 4', await page.evaluate(() => document.querySelector('#w4a-findbar .find-count')?.textContent));
ok('T8 当前命中强色 class=current', await page.evaluate(() => !!document.querySelector('.mj-block mark[data-hit].current')));
// Enter / Shift+Enter / ↑ / ↓
await input.press('Enter');
await page.keyboard.down('Shift');
await input.press('Enter');
await page.keyboard.up('Shift');
await page.click('#w4a-findbar .find-prev');
await page.click('#w4a-findbar .find-next');
await sleep(150);
ok('T8 Enter/Shift+Enter/↑/↓ → onJump(±1)', await page.evaluate(() => JSON.stringify(window.__fb.jump)) === JSON.stringify([1, -1, -1, 1]), JSON.stringify(await page.evaluate(() => window.__fb.jump)));
// navTick 兼容（W4b 的 F3/Shift+F3 通道）
await page.evaluate(() => window.__fbSetNav(5));
await page.evaluate(() => window.__fbSetNav(2));
await sleep(150);
ok('T8 navTick 变化 → onJump(±1)（Stub 兼容）', await page.evaluate(() => window.__fb.jump.slice(4).join(',')) === '1,-1', JSON.stringify(await page.evaluate(() => window.__fb.jump)));
// Aa 开关
await page.click('#w4a-findbar .find-case');
await sleep(150);
ok('T8 Aa 开关→onCaseSensitiveChange(true)+同词重发', await page.evaluate(() => window.__fb.cs.length === 1 && window.__fb.cs[0] === true && window.__fb.query[window.__fb.query.length - 1] === '章节'), JSON.stringify(await page.evaluate(() => ({ cs: window.__fb.cs, last: window.__fb.query[window.__fb.query.length - 1] }))));
ok('T8 Aa 按下态样式', await page.evaluate(() => document.querySelector('#w4a-findbar .find-case').classList.contains('active')));
// 大小写敏感生效（英文样例：cs 后 find 命中 1 个）
const csTotal = await page.evaluate(() => {
  const R = window.__R;
  const b = R.renderBlocks(window.__seedMd, { query: 'find', caseSensitive: true });
  return R.getBlockHitCounts(b).reduce((a, c) => a + c, 0);
});
ok('T8 大小写敏感 find 只命中 1 处（忽略大小写 3 处）', csTotal === 1, 'csTotal=' + csTotal);
// Esc 关闭
await input.press('Escape');
await sleep(150);
ok('T8 Esc→onClose', await page.evaluate(() => window.__fb.close.length === 1), JSON.stringify(await page.evaluate(() => window.__fb.close)));
ok('T8 Esc 关闭后 FindBar 卸载（open=false 路径）', await page.evaluate(() => !document.querySelector('#w4a-findbar .mj-findbar')));
// 重开（模拟 W4b setFindOpen(true)）后点 × 关闭
await page.evaluate(() => window.__fbSetOpen(true));
await sleep(200);
await page.click('#w4a-findbar .find-close');
await sleep(150);
ok('T8 ×→onClose', await page.evaluate(() => window.__fb.close.length === 2));
ok('T8 × 关闭后 FindBar 卸载', await page.evaluate(() => !document.querySelector('#w4a-findbar .mj-findbar')));
// open=false 兼容（W4b 常驻挂载）
await page.evaluate(async () => {
  const P = window.__P;
  const { FindBar } = await import('/src/components/FindBar.tsx');
  const host = document.createElement('div');
  host.id = 'w4a-fb2';
  document.body.appendChild(host);
  P.render(P.h(FindBar, { open: false, onQueryChange: () => {}, onJump: () => {}, onClose: () => {} }), host);
});
ok('T8 open=false 不渲染（Stub 兼容）', await page.evaluate(() => !document.querySelector('#w4a-fb2 .mj-findbar')));

await ensureMounted();
/* ---------------- T9 渲染器单元：srcMd / currentHit / applyCurrentHit / 字号 ---------------- */
const unit = await page.evaluate(async () => {
  const R = window.__R;
  const md = window.__seedMd;
  const blocks = R.renderBlocks(md, { query: '章节' });
  const out = {};
  out.srcMd0 = blocks[0].srcMd === '# 章节一';
  out.srcMd1 = blocks[1].srcMd === '这一段介绍章节概要。';
  out.srcMd5 = blocks[5].srcMd === '```js\nconst 章节 = 1;\n```';
  out.marks = R.getBlockHitCounts(blocks).reduce((a, b) => a + b, 0);
  out.codeSkipped = !blocks[5].html.includes('mark');
  const withCur = R.renderBlocks(md, { query: '章节', currentHit: 1 });
  out.currentAt1 = withCur[1].html.includes('data-hit="1" class="current"');
  // applyCurrentHit：不重渲染切当前
  const el = document.createElement('div');
  el.innerHTML = withCur[1].html + withCur[2].html;
  document.body.appendChild(el);
  out.before = !!el.querySelector('mark[data-hit="1"].current');
  R.applyCurrentHit(el, 2);
  out.afterMove = !el.querySelector('mark[data-hit="1"].current') && !!el.querySelector('mark[data-hit="2"].current');
  el.remove();
  // 字号缩放（W4b 已把默认字号设为 17px，基线先记录）
  const inner = document.querySelector('.mj-block-inner');
  out.baseline = getComputedStyle(inner).fontSize;
  R.setReaderFontSize(20);
  out.fontSet = getComputedStyle(inner).fontSize === '20px';
  out.fontClamp = R.setReaderFontSize(999) === 32 && R.setReaderFontSize(5) === 12 && getComputedStyle(inner).fontSize === '12px';
  out.fontGet = R.getReaderFontSize() === 12;
  document.documentElement.style.removeProperty('--reader-font-size');
  out.fontRestore = getComputedStyle(inner).fontSize === out.baseline;
  out.favicon = !!document.querySelector('link[rel="icon"][href^="data:image/svg+xml"]');
  return out;
});
ok('T9 srcMd 标题块精确', unit.srcMd0);
ok('T9 srcMd 段落块精确', unit.srcMd1);
ok('T9 srcMd 代码块精确（含围栏）', unit.srcMd5);
ok('T9 查询「章节」共 4 命中（代码块跳过）', unit.marks === 4, 'marks=' + unit.marks);
ok('T9 代码块内容不注入 mark', unit.codeSkipped);
ok('T9 currentHit=1 渲染时强色', unit.currentAt1);
ok('T9 applyCurrentHit 就地切换强色', unit.before && unit.afterMove);
ok('T9 setReaderFontSize(20) 实时生效', unit.fontSet, 'baseline=' + unit.baseline);
ok('T9 字号范围钳取 32/12 并生效', unit.fontClamp);
ok('T9 getReaderFontSize=12', unit.fontGet);
ok('T9 清除变量后回落基线', unit.fontRestore, 'baseline=' + unit.baseline);
ok('T9 index.html 内联 SVG favicon', unit.favicon);

/* ---------------- 汇总 ---------------- */
const favicon404 = errs.filter((e) => e.includes('favicon'));
ok('favicon 无 404', favicon404.length === 0, favicon404.join(';'));
const fails = results.filter((r) => !r.pass);
console.log('----');
console.log('TOTAL', results.length, 'PASS', results.length - fails.length, 'FAIL', fails.length);
console.log('ERRORS', JSON.stringify(errs.slice(0, 10)));
await browser.close();
process.exit(fails.length === 0 ? 0 : 1);
