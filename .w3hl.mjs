import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 760 },
});
const page = await browser.newPage();
page.on('console', (m) => console.log('CONSOLE', m.type(), m.text().slice(0, 500)));
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto('http://localhost:1420/?doc=builtin', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (document.querySelector('.demo-stat')?.textContent ?? '').includes('块'), { timeout: 60000 });
await new Promise((r) => setTimeout(r, 3000));

// 直接在页面里跑一遍 enhance 流程看结果
const out = await page.evaluate(async () => {
  try {
    const mod = await import('/src/lib/renderer.ts');
    const blocks = mod.renderBlocks('# t\n\n```rust\nfn main() { println!("x"); }\n```\n\n```typescript\nlet a: number = 1;\n```\n', {});
    const res = [];
    for (const b of blocks) {
      const el = document.createElement('div');
      el.innerHTML = b.html;
      document.body.appendChild(el);
      const changed = await mod.enhanceBlockElement(b, el);
      res.push({ kind: b.kind, changed, shiki: !!el.querySelector('pre.shiki'), html: b.html.slice(0, 120), rev: b.revision });
      el.remove();
    }
    return { res, highlighted: mod.highlightedBlockCount() };
  } catch (e) {
    return { error: String(e), stack: String(e?.stack ?? '').slice(0, 1200) };
  }
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
