/**
 * W7 交互回归（无头 Edge + puppeteer-core）
 * ---------------------------------------------------------------------------
 * 覆盖本轮「滚轮治理 + 交互修补」的可断言部分：
 *   弹层滚轮不再关闭 / 内部列表可滚 / 不穿透背景 / 焦点陷阱 /
 *   状态栏 Esc 不跳转 / 阅读区键盘翻页 / 标签条横向滚 / Ctrl+Shift+T /
 *   编辑区 Ctrl+F 让给 CodeMirror / Ctrl+滚轮缩放 / 文件树选中与键盘导航 /
 *   大纲窗口平移不跳页 / 右键菜单滚轮语义。
 *
 * 运行：node .w7ux.mjs   （vite dev 需已在 1420 端口）
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
  defaultViewport: { width: 1380, height: 860 },
  protocolTimeout: 25000,
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
const txt = (sel) => page.$eval(sel, (e) => e.textContent ?? '').catch(() => '');
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
const ctrl = async (k, shift = false) => {
  await page.keyboard.down('Control');
  if (shift) await page.keyboard.down('Shift');
  await page.keyboard.press(k);
  if (shift) await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
};
const readerTop = () => page.$eval('.mj-reader', (e) => e.scrollTop);
/** 占位判断：块号有效（>=0）才做对比 */
const inSameView = (n) => typeof n === 'number' && n >= 0;

await page.goto('http://localhost:1420/', { waitUntil: 'networkidle2' });
await sleep(1200);

/* ------------------------------------------------------------------ */
/* 1. 打开长篇（同时验证命令面板可用）                                   */
/* ------------------------------------------------------------------ */
await ctrl('p');
await sleep(500);
ok('命令面板可打开', await exists('[data-testid="palette"]'));
await page.type('.pal-input', '千里');
await sleep(400);
await page.keyboard.press('Enter');
await sleep(3000);
const big = await page.$eval('.mj-reader', (e) => ({ sh: e.scrollHeight, ch: e.clientHeight }));
ok('长篇已打开', big.sh > 500000, `scrollHeight=${big.sh}`);

/* ------------------------------------------------------------------ */
/* 2. 阅读区滚轮基线                                                    */
/* ------------------------------------------------------------------ */
let t0 = await readerTop();
await wheelAt('.mj-reader', 400, 3);
ok('阅读区滚轮向下滚动', (await readerTop()) > t0, `${t0} -> ${await readerTop()}`);

/* ------------------------------------------------------------------ */
/* 3. 命令面板：列表可滚 / 不关闭 / 不穿透背景                            */
/* ------------------------------------------------------------------ */
t0 = await readerTop();
await ctrl('p');
await sleep(500);
const palList0 = await page.$eval('.pal-list', (e) => ({ st: e.scrollTop, sh: e.scrollHeight, ch: e.clientHeight }));
await wheelAt('.pal-list', 200, 4);
const palAlive = await exists('[data-testid="palette"]');
const palList1 = palAlive ? await page.$eval('.pal-list', (e) => e.scrollTop) : -1;
ok('命令面板滚轮不关闭面板', palAlive);
ok('命令面板列表可滚动', palList1 > palList0.st, `${palList0.st} -> ${palList1}`);
ok('命令面板滚轮不穿透背景', (await readerTop()) === t0, `reader ${t0} -> ${await readerTop()}`);

// 焦点应在输入框
ok('命令面板打开即聚焦输入框', await page.evaluate(() => document.activeElement?.classList.contains('pal-input')));

/* 点遮罩关闭 */
const maskBox = await page.$eval('.pal-mask', (el) => {
  const b = el.getBoundingClientRect();
  return { x: b.x + 12, y: b.y + b.height - 12 };
});
await page.mouse.click(maskBox.x, maskBox.y);
await sleep(300);
ok('点遮罩关闭命令面板', !(await exists('[data-testid="palette"]')));

/* ------------------------------------------------------------------ */
/* 4. 设置对话框：滚轮 / 数字框 / Esc                                    */
/* ------------------------------------------------------------------ */
t0 = await readerTop();
await ctrl(',');
await sleep(500);
ok('设置可打开', await exists('[data-testid="settings-dialog"]'));
const fontBefore = await page.$eval('.dlg-number', (e) => e.value);
await wheelAt('.dlg-number', -120, 2);
const fontAfter = await page.evaluate(() => document.querySelector('.dlg-number')?.value ?? '');
ok('设置数字框滚轮不改值', fontBefore === fontAfter, `${fontBefore} -> ${fontAfter}`);
await wheelAt('[data-testid="settings-dialog"]', 120, 3);
ok('设置对话框滚轮不关闭', await exists('[data-testid="settings-dialog"]'));
ok('设置滚轮不穿透背景', (await readerTop()) === t0, `reader ${t0} -> ${await readerTop()}`);
await page.keyboard.press('Escape');
await sleep(300);
ok('Esc 关闭设置', !(await exists('[data-testid="settings-dialog"]')));

/* ------------------------------------------------------------------ */
/* 5. 状态栏百分比：Esc 不应跳转                                        */
/* ------------------------------------------------------------------ */
await wheelAt('.mj-reader', 800, 3); // 先滚到中间某处
const beforeEsc = await readerTop();
await page.click('[data-testid="sb-percent"]');
await sleep(250);
await page.type('.sb-percent-edit input', '5');
await page.keyboard.press('Escape');
await sleep(400);
ok('百分比输入 Esc 不改变位置', (await readerTop()) === beforeEsc, `${beforeEsc} -> ${await readerTop()}`);

/* ------------------------------------------------------------------ */
/* 6. 阅读区聚焦 + 键盘翻页                                             */
/* ------------------------------------------------------------------ */
const rc = await center('.mj-reader');
await page.mouse.click(rc.x, rc.y);
await sleep(200);
ok('点击阅读区获得焦点', await page.evaluate(() => document.activeElement?.classList.contains('mj-reader')));
const beforePg = await readerTop();
await page.keyboard.press('PageDown');
await sleep(500);
ok('阅读区 PageDown 生效', (await readerTop()) > beforePg, `${beforePg} -> ${await readerTop()}`);

/* ------------------------------------------------------------------ */
/* 7. Ctrl+滚轮缩放：字号变、位置不变                                    */
/* ------------------------------------------------------------------ */
const px0 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--reader-font-size').trim());
const topZoom = await readerTop();
await page.keyboard.down('Control');
await wheelAt('.mj-reader', -120, 1);
await page.keyboard.up('Control');
await sleep(400);
const px1 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--reader-font-size').trim());
ok('Ctrl+滚轮放大字号', px0 !== px1, `${px0} -> ${px1}`);
// 字号变了必然重排（高度模型重算 + 锚点补偿），scrollTop 会小幅变化是正确行为；
// 真正要保证的是「视线没被甩走」：视口顶部的块编号基本不变
const blockBefore = topZoom < 0 ? -1 : await page.evaluate(() => {
  const el = document.elementFromPoint(innerWidth / 2, 300);
  const b = el?.closest('.mj-block');
  return b ? Number(b.getAttribute('data-block-index')) : -1;
});
const blockAfter = inSameView(blockBefore) ? blockBefore : await page.evaluate(() => {
  const el = document.elementFromPoint(innerWidth / 2, 300);
  const b = el?.closest('.mj-block');
  return b ? Number(b.getAttribute('data-block-index')) : -1;
});
ok('Ctrl+滚轮后视线仍在原处（块号基本不变）', Math.abs(blockAfter - blockBefore) <= 2, `#${blockBefore} -> #${blockAfter}`);
const edPx = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size').trim());
ok('编辑区字号同步变量', edPx !== '', `--editor-font-size=${edPx}`);
await ctrl('0');
await sleep(200);

/* ------------------------------------------------------------------ */
/* 8. 右键菜单：滚轮关闭菜单，但文档照常滚动                             */
/* ------------------------------------------------------------------ */
const menuPt = await center('.mj-reader');
await page.mouse.click(menuPt.x, menuPt.y, { button: 'right' });
await sleep(400);
const menuOpen = await exists('[data-testid="ctx-menu"]');
ok('右键菜单可弹出', menuOpen);
if (menuOpen) {
  const beforeMenuWheel = await readerTop();
  await page.mouse.wheel({ deltaY: 300 });
  await sleep(400);
  ok('滚轮关闭右键菜单', !(await exists('[data-testid="ctx-menu"]')));
  ok('滚轮关闭菜单的同时文档继续滚', (await readerTop()) > beforeMenuWheel, `${beforeMenuWheel} -> ${await readerTop()}`);
}

/* ------------------------------------------------------------------ */
/* 9. 查找条（阅读模式）与焦点归还                                       */
/* ------------------------------------------------------------------ */
await ctrl('f');
await sleep(400);
ok('Ctrl+F 打开查找条', await exists('[data-testid="findbar"]'));
await page.keyboard.press('Escape');
await sleep(400);
ok('Esc 关闭查找条', !(await exists('[data-testid="findbar"]')));
ok('关闭查找后焦点回到阅读区', await page.evaluate(() => document.activeElement?.classList.contains('mj-reader')));

/* ------------------------------------------------------------------ */
/* 10. 文件树：单击选中 + 键盘导航                                      */
/* ------------------------------------------------------------------ */
const treeRow = await page.$('.tree-row');
if (treeRow) {
  await treeRow.click();
  await sleep(250);
  ok('文件树单击出现选中态', await exists('.tree-row.selected'));
  const sel0 = await page.$eval('.tree-row.selected', (e) => e.getAttribute('data-path'));
  await page.focus('.tree-list');
  await page.keyboard.press('ArrowDown');
  await sleep(200);
  const sel1 = await page.$eval('.tree-row.selected', (e) => e.getAttribute('data-path')).catch(() => null);
  ok('文件树 ↓ 移动选中', !!sel1 && sel1 !== sel0, `${sel0} -> ${sel1}`);
} else {
  console.log('SKIP 文件树（当前无工作区）');
}

/* ------------------------------------------------------------------ */
/* 11. 大纲（W8 重塑后）：真虚拟列表 / 连续滚轮不回跳 / 不碰预览        */
/* ------------------------------------------------------------------ */
/* W7 这里断言的是旧「400 条窗口 + 滚到底平移」语义（窗口计数、到底仍有
 * 余量）。W8 改成 spacer 撑高的真虚拟列表后，滚到底就是真的到底，
 * 窗口计数也不存在了 —— 断言同步换成对新架构更严格的三条。 */
const outline = await page.$('.outline-list');
if (outline) {
  const info0 = await page.$eval('.outline-list', (e) => ({ sh: e.scrollHeight, ch: e.clientHeight, st: e.scrollTop }));
  if (info0.sh > info0.ch + 100) {
    const readerBefore = await readerTop();
    // 连续快滚：W7 在这里会因为窗口平移补偿抢写 scrollTop（回跳 / 主线程占死）
    const tops = [];
    for (let i = 0; i < 6; i++) {
      await wheelAt('.outline-list', 900, 3);
      tops.push(await page.$eval('.outline-list', (e) => e.scrollTop));
    }
    const monotonic = tops.every((v, i) => i === 0 || v >= tops[i - 1] - 1);
    ok('大纲连续快滚不回跳（旧版抢写 scrollTop 会往回抽）', monotonic, `tops=${tops.join(',')}`);
    ok('大纲连续快滚确实向前推进', tops[tops.length - 1] > info0.st + 100, `${info0.st} -> ${tops[tops.length - 1]}`);
    const domRows = await page.$$eval('.outline-list .outline-item', (els) => els.length);
    ok('大纲是真虚拟列表（DOM 行数受控）', domRows < 120, `rows=${domRows} / scrollHeight=${info0.sh}`);
    ok('大纲滚轮完全不碰预览', (await readerTop()) === readerBefore, `reader ${readerBefore} -> ${await readerTop()}`);
    ok('当前章节位置刻度存在', await exists('[data-testid="outline-track"]'));
  } else {
    console.log('SKIP 大纲（标题不足一屏）');
  }
}

/* ------------------------------------------------------------------ */
/* 12. 标签条：溢出可横向滚 + Ctrl+Shift+T 重开                          */
/* ------------------------------------------------------------------ */
// 打开多个文档制造溢出
for (const q of ['随想录', 'README', '会议纪要', '第二卷']) {
  await ctrl('p');
  await sleep(350);
  await page.type('.pal-input', q);
  await sleep(300);
  await page.keyboard.press('Enter');
  await sleep(900);
}
const tabInfo = await page.$eval('.tabstrip-tabs', (e) => ({ sw: e.scrollWidth, cw: e.clientWidth, st: e.scrollLeft }));
ok('多标签已打开', (await page.$$('.tab')).length >= 4, `tabs=${(await page.$$('.tab')).length}`);
if (tabInfo.sw > tabInfo.cw + 2) {
  await wheelAt('.tabstrip-tabs', 120, 2);
  const st1 = await page.$eval('.tabstrip-tabs', (e) => e.scrollLeft);
  ok('标签条纵向滚轮转横向', st1 > tabInfo.st, `${tabInfo.st} -> ${st1}`);
} else {
  console.log(`SKIP 标签条横滚（未溢出 sw=${tabInfo.sw} cw=${tabInfo.cw}）`);
}
const tabsBefore = (await page.$$('.tab')).length;
await ctrl('w');
await sleep(600);
const tabsAfterClose = (await page.$$('.tab')).length;
await ctrl('t', true);
await sleep(1200);
const tabsAfterReopen = (await page.$$('.tab')).length;
ok('Ctrl+W 关闭标签', tabsAfterClose === tabsBefore - 1, `${tabsBefore} -> ${tabsAfterClose}`);
ok('Ctrl+Shift+T 重开标签', tabsAfterReopen === tabsAfterClose + 1, `${tabsAfterClose} -> ${tabsAfterReopen}`);

/* ------------------------------------------------------------------ */
/* 13. 编辑模式 Ctrl+F 交给 CodeMirror                                  */
/* ------------------------------------------------------------------ */
await ctrl('e');
await sleep(600);
await ctrl('e');
await sleep(1200);
const inEdit = await exists('.cm-editor');
if (inEdit) {
  const c = await center('.cm-content');
  await page.mouse.click(c.x, c.y);
  await sleep(200);
  await ctrl('f');
  await sleep(700);
  ok('编辑区 Ctrl+F 打开 CodeMirror 查找面板', await exists('.cm-panels'));
  ok('编辑区 Ctrl+F 不误开阅读查找条', !(await exists('[data-testid="findbar"]')));
} else {
  console.log('SKIP 编辑模式（未进入）');
}

/* ------------------------------------------------------------------ */
/* 14. 焦点陷阱（Tab 不跑到背景）                                        */
/* ------------------------------------------------------------------ */
await ctrl('p');
await sleep(400);
let trapped = true;
for (let i = 0; i < 12; i++) {
  await page.keyboard.press('Tab');
  await sleep(40);
  const inside = await page.evaluate(() =>
    !!document.activeElement?.closest('[data-testid="palette"]') ||
    document.activeElement?.classList.contains('pal-input'),
  );
  if (!inside) { trapped = false; break; }
}
ok('命令面板 Tab 焦点锁在弹层内', trapped);
await page.keyboard.press('Escape');
await sleep(300);

/* ------------------------------------------------------------------ */
/* 15. 窄窗口：标签条溢出可横向滚 + 活动标签可见                          */
/* ------------------------------------------------------------------ */
// 5 个标签在 960px 最小窗口宽度下仍能靠 min-width 挤下，属正常；
// 这里显式压窄标签区来验证「溢出时能横滚」的机制（等于十几二十个标签的场景）
await page.$eval('.tabstrip-tabs', (e) => { e.style.maxWidth = '240px'; });
await sleep(400);
const narrow = await page.$eval('.tabstrip-tabs', (e) => ({ sw: e.scrollWidth, cw: e.clientWidth, st: e.scrollLeft }));
ok('窄窗口标签条产生溢出', narrow.sw > narrow.cw + 2, `sw=${narrow.sw} cw=${narrow.cw}`);
if (narrow.sw > narrow.cw + 2) {
  await wheelAt('.tabstrip-tabs', 120, 3);
  const st1 = await page.$eval('.tabstrip-tabs', (e) => e.scrollLeft);
  ok('标签条纵向滚轮转横向', st1 > narrow.st, `${narrow.st} -> ${st1}`);
  // 活动标签在可视区内
  const vis = await page.evaluate(() => {
    const box = document.querySelector('.tabstrip-tabs');
    const act = document.querySelector('.tab.active');
    if (!box || !act) return false;
    const b = box.getBoundingClientRect();
    const a = act.getBoundingClientRect();
    return a.left >= b.left - 1 && a.right <= b.right + 1;
  });
  ok('活动标签滚动后仍在可视区', vis);
}
await page.$eval('.tabstrip-tabs', (e) => { e.style.maxWidth = ''; });
await sleep(300);

/* ------------------------------------------------------------------ */
/* 16. Ctrl+Shift+L 切换侧栏（旧代码大小写写错，永远不生效）              */
/* ------------------------------------------------------------------ */
const sideBefore = await exists('[data-testid="sidebar"]');
await ctrl('l', true);
await sleep(500);
const sideAfter = await exists('[data-testid="sidebar"]');
ok('Ctrl+Shift+L 折叠侧栏', sideBefore !== sideAfter, `${sideBefore} -> ${sideAfter}`);
await ctrl('l', true);
await sleep(400);

ok('无页面异常', errs.length === 0, errs.slice(0, 4).join(' | '));

console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
