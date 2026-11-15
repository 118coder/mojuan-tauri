import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 760 },
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() !== 'debug') console.log('CONSOLE', m.type(), m.text().slice(0, 600)); });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto('http://localhost:1420/?doc=builtin', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (document.querySelector('.demo-stat')?.textContent ?? '').includes('块'), { timeout: 60000 });

const out = await page.evaluate(async () => {
  const mod = await import('/src/lib/renderer.ts');
  const blocks = mod.renderBlocks('```rust\nfn main() { println!("x"); }\n```\n', {});
  const b = blocks[0];
  const el = document.createElement('div');
  el.innerHTML = b.html;
  document.body.appendChild(el);
  const before = el.innerHTML.slice(0, 300);
  await mod.enhanceBlockElement(b, el);
  const after = el.innerHTML.slice(0, 600);
  el.remove();
  return { before, after };
});
console.log('BEFORE', out.before);
console.log('AFTER', out.after);
await browser.close();
