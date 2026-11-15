import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 760 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() !== 'debug') errs.push(m.type() + ': ' + m.text()); });

await page.goto('http://localhost:1420/?doc=builtin', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (document.querySelector('.demo-stat')?.textContent ?? '').includes('块'), { timeout: 60000 });
await new Promise((r) => setTimeout(r, 3500));

const res = await page.evaluate(() => {
  const theme = document.documentElement.dataset.theme;
  const span = document.querySelector('pre.shiki span');
  const pre = document.querySelector('pre.shiki');
  const cs = span ? getComputedStyle(span) : null;
  const pcs = pre ? getComputedStyle(pre) : null;
  return {
    theme,
    hasSpan: !!span,
    spanColor: cs?.color,
    preBg: pcs?.backgroundColor,
    shikiCount: document.querySelectorAll('pre.shiki').length,
    mermaidDone: document.querySelectorAll('.mj-mermaid[data-state="done"]').length,
    mermaidPending: document.querySelectorAll('.mj-mermaid[data-state="pending"]').length,
    mermaidError: document.querySelectorAll('.mj-mermaid[data-state="error"]').length,
    katex: document.querySelectorAll('.katex').length,
    task: document.querySelectorAll('.task-list-item-checkbox').length,
    table: document.querySelectorAll('table').length,
    footnote: document.querySelectorAll('.footnotes').length,
    stat: document.querySelector('.demo-stat')?.textContent,
  };
});
console.log('DARK', JSON.stringify(res, null, 1));

// 切浅色
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('.demo-toolbar button.ghost'));
  const b = btns.find((x) => x.textContent?.includes('浅色') || x.textContent?.includes('深色'));
  b?.click();
});
await new Promise((r) => setTimeout(r, 2800));
const res2 = await page.evaluate(() => {
  const span = document.querySelector('pre.shiki span');
  const pre = document.querySelector('pre.shiki');
  return {
    theme: document.documentElement.dataset.theme,
    spanColor: span ? getComputedStyle(span).color : null,
    preBg: pre ? getComputedStyle(pre).backgroundColor : null,
    mermaidDone: document.querySelectorAll('.mj-mermaid[data-state="done"]').length,
  };
});
console.log('LIGHT', JSON.stringify(res2, null, 1));
console.log('ERRS', JSON.stringify([...new Set(errs)].slice(0, 10), null, 1));
await browser.close();
