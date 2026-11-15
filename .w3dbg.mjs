import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 760 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:1420/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (document.querySelector('.demo-stat')?.textContent ?? '').includes('块'), { timeout: 60000 });

async function jumpTo(blockNo) {
  const input = await page.$('.demo-statusbar input');
  await input.click({ clickCount: 3 });
  await input.type(String(blockNo));
  await input.press('Enter');
  await new Promise(r => setTimeout(r, 900));
  return page.evaluate(() => {
    const s = document.querySelector('.mj-reader');
    const idx = Array.from(document.querySelectorAll('.mj-block')).map((e) => Number(e.dataset.blockIndex));
    return {
      top: s.scrollTop, max: s.scrollHeight - s.clientHeight,
      count: idx.length, min: idx.length ? Math.min(...idx) : null, maxIdx: idx.length ? Math.max(...idx) : null,
      status: document.querySelector('.demo-statusbar')?.textContent,
      inputVal: document.querySelector('.demo-statusbar input')?.value,
    };
  });
}
console.log('A', JSON.stringify(await jumpTo(40000)));
console.log('B', JSON.stringify(await jumpTo(79000)));
console.log('C', JSON.stringify(await jumpTo(79663)));
console.log('D', JSON.stringify(await jumpTo(500)));
await browser.close();
