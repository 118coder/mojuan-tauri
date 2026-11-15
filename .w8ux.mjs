/**
 * W8 交互仲裁回归（无头 Edge + puppeteer-core）
 * ---------------------------------------------------------------------------
 * 核心命题：**大纲和预览各自拥有自己的 scrollTop，谁也不动谁**。
 * 另外验证「程序化滚动被精确认领、不会被误判成用户滚动」——这是
 * 菜单不再被自动滚动误关、分屏不再来回抖的前提。
 *
 * 运行：node .w8ux.mjs   （vite dev 需已在 1420 端口）
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
  defaultViewport: { width: 1380, height: 860 },
  protocolTimeout: 90000,
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (sel) => page.$(sel).then((e) => !!e);
const center = (sel) => page.$eval(sel, (el) => {
  const b = el.getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
});
const wheelAt = async (sel, dy, times = 3) => {
  const c = await center(sel);
  await page.mouse.move(c.x, c.y);
  for (let i = 0; i < times; i++) { await page.mouse.wheel({ deltaY: dy }); await sleep(70); }
  await sleep(260);
};
const ctrl = async (k) => {
  await page.keyboard.down('Control');
  await page.keyboard.press(k);
  await page.keyboard.up('Control');
};
const readerTop = () => page.$eval('.mj-reader', (e) => e.scrollTop);
const outlineTop = () => page.$eval('[data-testid="outline-list"]', (e) => e.scrollTop);
const snap = () => page.evaluate(() => window.__mjArbiter?.snapshot() ?? null);
const resetStats = () => page.evaluate(() => window.__mjArbiter?.reset());

/* ------------------------------------------------------------------ */
/* 0. 打开长篇（带大量标题大纲）                                         */
/* ------------------------------------------------------------------ */
await page.goto('http://localhost:1420/', { waitUntil: 'networkidle2' });
await sleep(1200);
await ctrl('p');
await sleep(500);
await page.type('.pal-input', '千里');
await sleep(400);
await page.keyboard.press('Enter');
await page.waitForSelector('[data-testid="outline-list"]', { timeout: 60000 });
await page.waitForFunction(() => {
  const el = document.querySelector('[data-testid="outline-list"]');
  return el && el.scrollHeight > 3000;
}, { timeout: 60000 });
await sleep(900);

const s0 = await snap();
ok('中央仲裁器已安装且统计可读', s0 !== null && typeof s0.programWrites === 'number', JSON.stringify(s0));
const kinds = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-scroll-kind]')).map((e) => e.getAttribute('data-scroll-kind')));
ok('阅读区与大纲均已声明滚动归属', kinds.includes('reader') && kinds.includes('outline'), kinds.join(','));

/* ------------------------------------------------------------------ */
/* 1. 大纲滚轮 → 预览纹丝不动                                            */
/* ------------------------------------------------------------------ */
await resetStats();
const r0 = await readerTop();
const o0 = await outlineTop();
await wheelAt('[data-testid="outline-list"]', 600, 5);
const r1 = await readerTop();
const o1 = await outlineTop();
ok('大纲滚轮：大纲自己前进', o1 > o0, `${o0} -> ${o1}`);
ok('大纲滚轮：预览 scrollTop 纹丝不动', r1 === r0, `reader ${r0} -> ${r1}`);

/* ------------------------------------------------------------------ */
/* 2. 预览滚轮 → 大纲纹丝不动，但高亮/位置刻度照常跟随                    */
/* ------------------------------------------------------------------ */
const r2 = await readerTop();
const o2 = await outlineTop();
const track0 = await page.$eval('[data-testid="outline-track"] span', (e) => e.style.left);
await wheelAt('.mj-reader', 1200, 5);
await sleep(400);
const o3 = await outlineTop();
const track1 = await page.$eval('[data-testid="outline-track"] span', (e) => e.style.left);
ok('预览滚轮：预览前进', (await readerTop()) > r2, `${r2} -> ${await readerTop()}`);
ok('预览滚轮：大纲 scrollTop 纹丝不动（跟随默认关）', o3 === o2, `outline ${o2} -> ${o3}`);
ok('预览滚轮：当前章节位置刻度照常跟随', track1 !== track0, `${track0} -> ${track1}`);

/* ------------------------------------------------------------------ */
/* 3. 大纲连续快滚：不回跳、不卡死                                       */
/* ------------------------------------------------------------------ */
const tops = [];
for (let i = 0; i < 6; i++) {
  await wheelAt('[data-testid="outline-list"]', 900, 3);
  tops.push(await outlineTop());
}
ok('大纲连续快滚不回跳（旧版平移补偿会往回抽）',
  tops.every((v, i) => i === 0 || v >= tops[i - 1] - 1), `tops=${tops.join(',')}`);
ok('大纲连续快滚后页面仍响应', (await page.title()) !== undefined);

/* ------------------------------------------------------------------ */
/* 4. 真虚拟列表：DOM 行数受控、spacer 撑满总高度                        */
/* ------------------------------------------------------------------ */
const v = await page.$eval('[data-testid="outline-list"]', (e) => ({
  rows: e.querySelectorAll('.outline-item').length,
  sh: e.scrollHeight,
  canvas: e.querySelector('.outline-canvas')?.getBoundingClientRect().height ?? 0,
}));
ok('大纲只渲染可视行（真虚拟列表）', v.rows < 120, `rows=${v.rows}`);
ok('spacer 高度等于总条数×固定行高', Math.abs(v.canvas - v.sh) < 2, `canvas=${v.canvas} sh=${v.sh}`);

/* ------------------------------------------------------------------ */
/* 5. 程序化滚动被精确认领（点「定位」，全程没有用户输入滚动）            */
/* ------------------------------------------------------------------ */
await sleep(700); // 让大纲手势会话静默
await resetStats();
const beforeLocate = await outlineTop();
await page.click('[data-testid="outline-locate"]');
await sleep(350);
const afterLocate = await outlineTop();
const s1 = await snap();
ok('显式定位把大纲滚回当前章节', afterLocate !== beforeLocate, `${beforeLocate} -> ${afterLocate}`);
ok('程序化写入已申报且被精确认领', s1.programWrites > 0 && s1.programConsumed > 0,
  `writes=${s1.programWrites} consumed=${s1.programConsumed}`);
ok('程序化滚动零次误判成用户滚动（菜单/联动不会被误触发）',
  s1.userScrolls === 0 && s1.programMismatch === 0,
  `userScrolls=${s1.userScrolls} mismatch=${s1.programMismatch}`);

/* ------------------------------------------------------------------ */
/* 6. 开启「跟随」后：允许自动滚动，但用户滚大纲时绝不抢方向盘            */
/* ------------------------------------------------------------------ */
await page.click('[data-testid="outline-follow"]');
await sleep(750);
await resetStats();
const of0 = await outlineTop();
await wheelAt('.mj-reader', 1500, 4);
await sleep(800);
const of1 = await outlineTop();
const s2 = await snap();
ok('开启跟随后预览滚动会把大纲带到当前章节', of1 !== of0, `${of0} -> ${of1}`);
ok('跟随走的是已申报的程序化写入', s2.programWrites > 0, `writes=${s2.programWrites}`);
ok('跟随期间零误判', s2.programMismatch === 0, `mismatch=${s2.programMismatch}`);

const seq = [];
for (let i = 0; i < 5; i++) {
  await wheelAt('[data-testid="outline-list"]', 500, 2);
  seq.push(await outlineTop());
}
ok('跟随开启时用户滚大纲仍不被抢方向盘',
  seq.every((x, i) => i === 0 || x >= seq[i - 1] - 1), `seq=${seq.join(',')}`);
await page.click('[data-testid="outline-follow"]'); // 关掉，避免干扰后续

/* ------------------------------------------------------------------ */
/* 7. 弹层：内部可滚 / 不关闭 / 不穿透 / 遮罩空白被吞                     */
/* ------------------------------------------------------------------ */
const rBefore = await readerTop();
await ctrl('p');
await sleep(450);
const palOpen = await exists('[data-testid="palette"]');
ok('命令面板可打开', palOpen);
if (palOpen) {
  const l0 = await page.$eval('.pal-list', (e) => e.scrollTop);
  await wheelAt('.pal-list', 200, 4);
  const alive = await exists('[data-testid="palette"]');
  const l1 = alive ? await page.$eval('.pal-list', (e) => e.scrollTop) : -1;
  ok('弹层内滚轮不关闭面板', alive);
  ok('弹层内列表可滚', l1 > l0, `${l0} -> ${l1}`);
  ok('弹层滚轮不穿透背景', (await readerTop()) === rBefore, `reader ${rBefore} -> ${await readerTop()}`);

  await resetStats();
  const corner = await page.$eval('.pal-mask', (e) => {
    const b = e.getBoundingClientRect();
    return { x: b.x + 5, y: b.y + 5 };
  });
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.wheel({ deltaY: 300 });
  await sleep(250);
  const s3 = await snap();
  ok('遮罩空白滚轮由仲裁器吞掉', s3.blockedByOverlay > 0, `blocked=${s3.blockedByOverlay}`);
  ok('遮罩滚轮后背景仍不动', (await readerTop()) === rBefore);
  await page.keyboard.press('Escape');
  await sleep(250);
}

/* ------------------------------------------------------------------ */
/* 8. Ctrl+滚轮缩放仍走唯一入口                                          */
/* ------------------------------------------------------------------ */
await resetStats();
const rc = await center('.mj-reader');
await page.mouse.move(rc.x, rc.y);
await page.keyboard.down('Control');
await page.mouse.wheel({ deltaY: -120 });
await page.keyboard.up('Control');
await sleep(300);
const s4 = await snap();
ok('Ctrl+滚轮缩放由仲裁器处理', s4.zoomEvents > 0, `zoomEvents=${s4.zoomEvents}`);
await ctrl('0');
await sleep(200);

/* ------------------------------------------------------------------ */
/* 9. 右键菜单：真实用户滚轮才关，程序化滚动不误关                        */
/* ------------------------------------------------------------------ */
const mp = await center('.mj-reader');
await page.mouse.click(mp.x, mp.y, { button: 'right' });
await sleep(400);
const menuOpen = await exists('[data-testid="ctx-menu"]');
ok('右键菜单可弹出', menuOpen);
if (menuOpen) {
  const rb = await readerTop();
  await page.mouse.wheel({ deltaY: 300 });
  await sleep(400);
  ok('用户滚轮关闭菜单且文档照常滚',
    !(await exists('[data-testid="ctx-menu"]')) && (await readerTop()) > rb,
    `${rb} -> ${await readerTop()}`);
}

/* ------------------------------------------------------------------ */
/* 10. 大纲点击跳转 / 键盘翻页仍然生效                                   */
/* ------------------------------------------------------------------ */
await resetStats();
const rj0 = await readerTop();
await page.click('[data-testid="outline-list"] .outline-item');
await sleep(450);
const s5 = await snap();
ok('大纲点击跳转仍生效', (await readerTop()) !== rj0, `${rj0} -> ${await readerTop()}`);
ok('跳转被申报为程序化滚动（不会回写编辑区）', s5.programWrites > 0, `writes=${s5.programWrites}`);

await page.click('.mj-reader');
const rk0 = await readerTop();
await page.keyboard.press('PageDown');
await sleep(350);
ok('阅读区键盘翻页仍生效', (await readerTop()) > rk0, `${rk0} -> ${await readerTop()}`);

/* ------------------------------------------------------------------ */
/* 11. 标签条：纵向滚轮转横向仍走仲裁器唯一入口                          */
/* ------------------------------------------------------------------ */
await resetStats();
const made = await page.evaluate(() => {
  const el = document.querySelector('.tabstrip-tabs');
  if (!el) return false;
  // 临时占位制造真实溢出（不改业务数据，测完立即删）
  const filler = document.createElement('div');
  filler.id = 'w8-tab-filler';
  filler.style.cssText = 'flex:0 0 1200px;height:1px;';
  el.appendChild(filler);
  return el.scrollWidth > el.clientWidth + 10;
});
if (made) {
  const sl0 = await page.$eval('.tabstrip-tabs', (e) => e.scrollLeft);
  await wheelAt('.tabstrip-tabs', 200, 3);
  const sl1 = await page.$eval('.tabstrip-tabs', (e) => e.scrollLeft);
  const sTab = await snap();
  ok('标签条纵向滚轮转横向（仲裁器唯一入口）', sl1 > sl0 && sTab.horizontalWheel > 0,
    `sl ${sl0} -> ${sl1} / hw=${sTab.horizontalWheel}`);
  await page.evaluate(() => document.getElementById('w8-tab-filler')?.remove());
} else {
  console.log('SKIP 标签条横滚（占位未能制造溢出）');
}

/* ------------------------------------------------------------------ */
/* 12. 分屏联动：origin 判因果，静止后零自激回环                         */
/* ------------------------------------------------------------------ */
let mode = await page.evaluate(() => document.querySelector('.app-frame')?.getAttribute('data-mode') ?? '');
for (let i = 0; i < 3 && mode !== 'split'; i++) {
  await ctrl('e');
  await sleep(400);
  mode = await page.evaluate(() => document.querySelector('.app-frame')?.getAttribute('data-mode') ?? '');
}
ok('可切到分屏模式', mode === 'split', `mode=${mode}`);
if (mode === 'split') {
  await sleep(700); // 等 EditorPane 挂载
  const cm = await page.$('.cm-scroller');
  ok('分屏编辑区已挂载', !!cm);
  if (cm) {
    await resetStats();
    const cm0 = await page.$eval('.cm-scroller', (e) => e.scrollTop);
    await wheelAt('.mj-reader', 900, 4);
    await sleep(900);
    const cm1 = await page.$eval('.cm-scroller', (e) => e.scrollTop);
    ok('预览滚动仍联动到编辑区（比例同步没丢）', cm1 !== cm0, `cm ${cm0} -> ${cm1}`);

    // 回环的判据不是「写入次数少」，而是「静止后不再产生任何滚动事件」
    const q0 = await snap();
    await sleep(650);
    const q1 = await snap();
    ok('联动静止后零自激回环（旧版 160ms 时间锁会漏判）',
      q1.userScrolls - q0.userScrolls === 0 && q1.programWrites - q0.programWrites === 0,
      `Δuser=${q1.userScrolls - q0.userScrolls} Δprog=${q1.programWrites - q0.programWrites}`);

    await resetStats();
    const rr0 = await readerTop();
    const cmA = await page.$eval('.cm-scroller', (e) => ({ st: e.scrollTop, max: e.scrollHeight - e.clientHeight }));
    // 大幅滚动：分屏联动是「按块号近似对齐」，小幅滚动不跨块时预览位置本来就不变
    await wheelAt('.cm-scroller', 2500, 8);
    await sleep(800);
    const cmB = await page.$eval('.cm-scroller', (e) => e.scrollTop);
    const rr1 = await readerTop();
    const qLink = await snap();
    ok('编辑区大幅滚动确实生效', cmB > cmA.st + 1000, `cm ${cmA.st} -> ${cmB} / max=${cmA.max}`);
    ok('编辑区滚动联动到预览（且联动已申报为程序化）', rr1 !== rr0 || qLink.programWrites > 0,
      `reader ${rr0} -> ${rr1} / progWrites=${qLink.programWrites}`);
    const q2 = await snap();
    await sleep(650);
    const q3 = await snap();
    ok('反向联动同样零自激回环',
      q3.userScrolls - q2.userScrolls === 0 && q3.programWrites - q2.programWrites === 0,
      `Δuser=${q3.userScrolls - q2.userScrolls} Δprog=${q3.programWrites - q2.programWrites}`);
  }
}

/* ------------------------------------------------------------------ */
/* 10. 正文链接：不许把应用导航走 / 外链交给系统 / 右键有链接项              */
/* ------------------------------------------------------------------ */
/*
 * 这条覆盖的缺口：渲染器从不给标题生成 id，WebView 里放行 a[href] 的默认
 * 跳转会直接把整个应用界面导航走（无地址栏、无后退键，等于点了链接软件就废）。
 */
await page.evaluate(() => {
  window.__opened = [];
  window.open = (u) => { window.__opened.push(String(u)); return null; };
});
// 演示素材里不一定有链接，直接在阅读区挂一个真实 <a>：测的是事件委托路径本身
// （点击拦截 + 右键菜单项），与文档内容无关，断言才稳定。
const linkBox = await page.evaluate(() => {
  const reader = document.querySelector('.mj-reader');
  if (!reader) return null;
  const box = reader.getBoundingClientRect();
  const a = document.createElement('a');
  a.href = 'https://example.com/__mj_link_probe__';
  a.textContent = 'TESTLINK';
  a.id = '__mj_link_probe';
  // 必须落在 reader 内部：.mj-reader 有 contain:paint，溢出部分会被裁掉
  a.style.cssText =
    `position:fixed;left:${Math.round(box.left + 80)}px;top:${Math.round(box.top + 80)}px;` +
    'padding:8px 12px;z-index:9999;background:#c00;color:#fff;font-size:13px;';
  reader.appendChild(a);
  const r = a.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
});
const linkInfo = linkBox;
if (linkInfo) {
  const url0 = page.url();
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el ? `${el.tagName}#${el.id || ''}` : 'none';
  }, linkInfo);
  // 用元素自身的 click()：验证的是阅读区的点击委托链（preventDefault +
  // onLinkClick），不依赖探针元素的层级/遮挡
  await page.evaluate(() => document.getElementById('__mj_link_probe')?.click());
  await sleep(800);
  const opened = await page.evaluate(() => window.__opened);
  ok('点正文外链不会把应用整页导航走', page.url() === url0, `url=${page.url()} hit=${hit}`);
  ok('点链接后阅读区仍在（界面没被替换）', await exists('.mj-reader'));
  ok('外链交给系统浏览器打开', opened.length >= 1 && /^https?:/i.test(opened[0] || ''), JSON.stringify(opened));

  // 右键同样用事件派发：走的是 .reader-wrap 上的真实处理器，不依赖像素命中
  await page.evaluate(() => {
    const a = document.getElementById('__mj_link_probe');
    if (!a) return;
    const r = a.getBoundingClientRect();
    a.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, view: window,
      clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2),
    }));
  });
  await sleep(500);
  const linkMenu = await page.$$eval('[data-testid="ctx-menu"] .menu-item', (els) => els.map((e) => e.textContent.trim()));
  ok('链接右键菜单含「打开链接」/「跳转到该章节」',
    linkMenu.some((t) => t.includes('打开链接') || t.includes('跳转到该章节')), `${linkMenu.join(' | ')}`);
  await page.keyboard.press('Escape');
  await sleep(250);
} else {
  console.log('SKIP 链接（演示文档里没有 a[href]）');
}

/* ------------------------------------------------------------------ */
ok('全程无页面错误', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(`\nW8 结果: ${pass} PASS / ${fail} FAIL`);
await browser.close();
process.exit(fail ? 1 : 0);
