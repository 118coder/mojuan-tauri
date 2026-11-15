/** 进度记忆专项：大文档滚动 → 刷新 → 恢复百分比 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
  defaultViewport: { width: 1380, height: 860 },
  protocolTimeout: 120000,
});
const page = await browser.newPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = () => page.$eval('[data-testid="sb-percent"]', (e) => e.textContent).catch(() => 'n/a');

page.on('pageerror', (e) => console.log('pageerror:', e.message));
page.on('console', (m) => { if (m.text().includes('[DBG')) console.log(m.text()); });
await page.goto('http://localhost:1420/', { waitUntil: 'domcontentloaded' });
await sleep(1500);
// 冷启动是欢迎页：用命令面板打开长篇
await page.keyboard.down('Control');
await page.keyboard.press('p');
await page.keyboard.up('Control');
await sleep(600);
await page.type('.pal-input', '千里');
await sleep(500);
await page.keyboard.press('Enter');
await page.waitForSelector('.mj-reader', { timeout: 90000 });
await sleep(3000);
console.log('loaded active =', (await page.$eval('.tab.active', (e) => e.textContent)).slice(0, 20));
await page.$eval('.mj-reader', (el) => { el.scrollTop = el.scrollHeight * 0.4; });
for (let i = 1; i <= 6; i++) {
  await sleep(1000);
  const s = await page.evaluate(() => {
    try {
      const j = JSON.parse(localStorage.getItem('mojuan.mock.state.v1') || '{}');
      return { keys: Object.keys(j.scroll_top || {}).length, top: Object.values(j.scroll_top || {})[0] };
    } catch (e) { return String(e); }
  });
  console.log(`+${i}s before reload pct=`, await pct(), 'persisted=', JSON.stringify(s));
}

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.mj-block', { timeout: 60000 });
const st = await page.evaluate(() => {
  try {
    const j = JSON.parse(localStorage.getItem('mojuan.mock.state.v1') || '{}');
    return { last_file: j.last_file, scroll_top: j.scroll_top };
  } catch (e) { return String(e); }
});
console.log('state after reload:', JSON.stringify(st).slice(0, 300));
for (let i = 1; i <= 12; i++) {
  await sleep(1000);
  console.log(`after reload +${i}s pct =`, await pct(), 'scrollTop =', await page.$eval('.mj-reader', (e) => Math.round(e.scrollTop)).catch(() => -1));
}
await browser.close();
