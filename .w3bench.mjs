import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1280,860'],
  defaultViewport: { width: 1280, height: 760 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));

const t0 = Date.now();
await page.goto('http://localhost:1420/', { waitUntil: 'domcontentloaded' });
// 等块渲染完成
await page.waitForFunction(() => {
  const s = document.querySelector('.demo-stat');
  return s && s.textContent.includes('块');
}, { timeout: 60000 });
const tReady = Date.now() - t0;

const initial = await page.evaluate(() => {
  const stat = document.querySelector('.demo-stat')?.textContent ?? '';
  const blocks = document.querySelectorAll('.mj-block');
  const scroller = document.querySelector('.mj-reader');
  return {
    stat,
    mounted: blocks.length,
    domNodes: document.querySelectorAll('*').length,
    canvasH: scroller?.scrollHeight,
    clientH: scroller?.clientHeight,
  };
});
console.log('READY_MS', tReady);
console.log('INITIAL', JSON.stringify(initial));

// 首屏项：首块是否渲染
console.log('FIRST_TEXT', JSON.stringify(await page.evaluate(() => document.querySelector('.mj-block')?.textContent?.slice(0,40))));

await browser.close();
console.log('LOGS', JSON.stringify(logs.slice(0, 20), null, 1));
