import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 760 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
page.on('response', (r) => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url()); });

const t0 = Date.now();
await page.goto('http://localhost:1420/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (document.querySelector('.demo-stat')?.textContent ?? '').includes('块'), { timeout: 60000 });
const readyMs = Date.now() - t0;

const initial = await page.evaluate(() => {
  const scroller = document.querySelector('.mj-reader');
  return {
    stat: document.querySelector('.demo-stat')?.textContent,
    mounted: document.querySelectorAll('.mj-block').length,
    domNodes: document.querySelectorAll('*').length,
    canvasH: scroller.scrollHeight,
    clientH: scroller.clientHeight,
  };
});
console.log('READY_MS', readyMs);
console.log('INITIAL', JSON.stringify(initial));

async function jumpTo(blockNo) {
  const input = await page.$('.demo-statusbar input');
  await input.evaluate((el) => { el.value = ''; });
  await input.focus();
  await input.type(String(blockNo));
  const t = Date.now();
  await input.press('Enter');
  await page.waitForFunction((n) => {
    const idx = Array.from(document.querySelectorAll('.mj-block')).map((e) => Number(e.dataset.blockIndex));
    return idx.length > 0 && Math.min(...idx) <= n - 1 && Math.max(...idx) >= n - 1;
  }, { timeout: 20000 }, blockNo);
  const ms = Date.now() - t;
  // 等高度测量/稳定两帧
  await new Promise((r) => setTimeout(r, 400));
  const st = await page.evaluate(() => {
    const idx = Array.from(document.querySelectorAll('.mj-block')).map((e) => Number(e.dataset.blockIndex));
    return {
      count: idx.length, min: Math.min(...idx), max: Math.max(...idx),
      status: document.querySelector('.demo-statusbar')?.textContent?.replace('跳到块跳转', ' | '),
    };
  });
  return { ms, ...st };
}

for (const n of [40000, 79000, 500, 66666]) {
  console.log('JUMP', n, JSON.stringify(await jumpTo(n)));
}

// 滚动性能（滚动到顶部后连续滚动 150 次，每次同步测量布局耗时）
await page.evaluate(() => { document.querySelector('.mj-reader').scrollTop = 0; });
await new Promise((r) => setTimeout(r, 600));
const perf = await page.evaluate(async () => {
  const s = document.querySelector('.mj-reader');
  const frames = [];
  const step = Math.round((s.scrollHeight - s.clientHeight) / 200);
  for (let i = 0; i < 150; i++) {
    const t = performance.now();
    s.scrollTop += step;
    void s.offsetHeight;
    frames.push(performance.now() - t);
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 8));
  }
  const sorted = [...frames].sort((a, b) => a - b);
  return {
    median: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
    p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
    max: +sorted[sorted.length - 1].toFixed(2),
    mounted: document.querySelectorAll('.mj-block').length,
    domNodes: document.querySelectorAll('*').length,
  };
});
console.log('SCROLL', JSON.stringify(perf));

// 回到顶部看高亮与 mermaid
await page.evaluate(() => { document.querySelector('.mj-reader').scrollTop = 0; });
await new Promise((r) => setTimeout(r, 3500));
const visual = await page.evaluate(() => ({
  shiki: document.querySelectorAll('pre.shiki').length,
  plain: document.querySelectorAll('pre.mj-code-plain').length,
  mermaidDone: document.querySelectorAll('.mj-mermaid[data-state="done"]').length,
  katex: document.querySelectorAll('.katex').length,
  taskCheckbox: document.querySelectorAll('.task-list-item-checkbox').length,
  table: document.querySelectorAll('table').length,
  footnote: document.querySelectorAll('.footnotes').length,
  status: document.querySelector('.demo-statusbar')?.textContent?.replace('跳到块跳转', ' | '),
}));
console.log('VISUAL', JSON.stringify(visual));

// 高亮后的颜色对比（确认双主题变量生效）
const theme = await page.evaluate(() => {
  const spans = Array.from(document.querySelectorAll('pre.shiki span')).slice(0, 6);
  const root = getComputedStyle(document.documentElement).getPropertyValue('--shiki-dark').trim();
  return { count: spans.length, firstColors: spans.map((s) => getComputedStyle(s).color).slice(0, 4), theme: document.documentElement.dataset.theme };
});
console.log('THEME', JSON.stringify(theme));

console.log('ERRORS', JSON.stringify([...new Set(errs)].slice(0, 12), null, 1));
await browser.close();
