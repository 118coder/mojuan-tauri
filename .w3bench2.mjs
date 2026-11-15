import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 1280, height: 760 },
});
const page = await browser.newPage();
const failed = [];
page.on('requestfailed', (r) => failed.push(r.url() + ' :: ' + r.failure()?.errorText));
page.on('response', (r) => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url()); });
page.on('pageerror', (e) => failed.push('pageerror: ' + e.message));

await page.goto('http://localhost:1420/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (document.querySelector('.demo-stat')?.textContent ?? '').includes('块'), { timeout: 60000 });

// 关闭大纲，避免干扰（更接近阅读器）
await page.evaluate(() => document.querySelectorAll('.demo-toolbar .ghost').forEach(() => {}));

// 1. 滚动性能：程序化连续滚动，记每帧耗时
const scrollPerf = await page.evaluate(async () => {
  const s = document.querySelector('.mj-reader');
  const frames = [];
  const N = 120;
  const step = Math.round((s.scrollHeight - s.clientHeight) / 60); // 滚到约 1/60 处
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    s.scrollTop = s.scrollTop + step;
    // 强制同步布局，模拟浏览器绘制前必须完成的排版
    void s.offsetHeight;
    frames.push(performance.now() - t);
    if (i % 10 === 9) await new Promise((r) => setTimeout(r, 16));
  }
  frames.sort((a, b) => a - b);
  return {
    median: frames[Math.floor(frames.length / 2)],
    p95: frames[Math.floor(frames.length * 0.95)],
    max: frames[frames.length - 1],
    finalTop: s.scrollTop,
    mounted: document.querySelectorAll('.mj-block').length,
  };
});
console.log('SCROLL_PERF', JSON.stringify(scrollPerf));

// 2. 大跨度跳块（模拟大纲跳转）：基准 1 -> 40000 -> 79000
const jump = await page.evaluate(async () => {
  const reader = document.querySelector('.mj-reader');
  // 通过公开句柄跳块：直接派发输入框不好做，这里用 scrollToBlock 的等价路径
  return null;
});

// 用 UI 输入框跳块
async function jumpTo(blockNo) {
  const input = await page.$('.demo-statusbar input');
  await input.click({ clickCount: 3 });
  await input.type(String(blockNo));
  await input.press('Enter');
  const t0 = Date.now();
  await page.waitForFunction((n) => {
    const idx = Array.from(document.querySelectorAll('.mj-block')).map((e) => Number(e.dataset.blockIndex));
    return idx.length > 0 && Math.min(...idx) <= n - 1 && Math.max(...idx) >= n - 1;
  }, { timeout: 30000 }, blockNo);
  return Date.now() - t0;
}

const j1 = await jumpTo(40000);
const state1 = await page.evaluate(() => {
  const idx = Array.from(document.querySelectorAll('.mj-block')).map((e) => Number(e.dataset.blockIndex));
  return { min: Math.min(...idx), max: Math.max(...idx), count: idx.length, status: document.querySelector('.demo-statusbar')?.textContent };
});
console.log('JUMP_40000_MS', j1, JSON.stringify(state1));

const j2 = await jumpTo(79000);
const state2 = await page.evaluate(() => {
  const idx = Array.from(document.querySelectorAll('.mj-block')).map((e) => Number(e.dataset.blockIndex));
  return { min: Math.min(...idx), max: Math.max(...idx), count: idx.length, status: document.querySelector('.demo-statusbar')?.textContent };
});
console.log('JUMP_79000_MS', j2, JSON.stringify(state2));

const j3 = await jumpTo(500);
const state3 = await page.evaluate(() => {
  const idx = Array.from(document.querySelectorAll('.mj-block')).map((e) => Number(e.dataset.blockIndex));
  return { min: Math.min(...idx), max: Math.max(...idx), count: idx.length, status: document.querySelector('.demo-statusbar')?.textContent };
});
console.log('JUMP_500_MS', j3, JSON.stringify(state3));

// 3. 高亮是否生效（滚到第 0 块附近的代码块）
const highlight = await page.evaluate(() => {
  const s = document.querySelector('.mj-reader');
  s.scrollTop = 0;
  return null;
});
await new Promise(r => setTimeout(r, 2500));
const hl = await page.evaluate(() => ({
  shikiCount: document.querySelectorAll('pre.shiki').length,
  plainCount: document.querySelectorAll('pre.mj-code-plain').length,
  mermaidDone: document.querySelectorAll('.mj-mermaid[data-state="done"]').length,
  mermaidPending: document.querySelectorAll('.mj-mermaid[data-state="pending"]').length,
  status: document.querySelector('.demo-statusbar')?.textContent,
}));
console.log('HIGHLIGHT', JSON.stringify(hl));

console.log('FAILED', JSON.stringify([...new Set(failed)].slice(0, 10), null, 1));
await browser.close();
