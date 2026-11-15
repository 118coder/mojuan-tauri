/**
 * W4b 正式界面无头自测（仿 .w3bench3.mjs，无头 Edge + puppeteer-core）
 * 断言：标签打开/切换/关闭、Ctrl+E 模式切换、状态栏百分比、大纲跳块、
 *       设置改主题、命令面板、分块通道（>1MB）、查找条挂接、极简模式、
 *       进度记忆（含整页刷新后恢复）、右键菜单挂接、文件树增删。
 * 注：无头 Edge 的 CDP 信任点击不合成 dblclick（实测），文件打开用原生
 *     dblclick 合成事件驱动；真实双击在 tauri dev 真窗验证。
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1380, height: 860 }, protocolTimeout: 15000,
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
page.on('response', (r) => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url()); });

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS', name, extra); }
  else { fail++; console.log('FAIL', name, extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => page.$eval(sel, (el) => el.textContent ?? '').catch(() => '');
const exists = (sel) => page.$(sel).then((e) => !!e);
const key = async (combo) => {
  if (combo.ctrl) await page.keyboard.down('Control');
  if (combo.shift) await page.keyboard.down('Shift');
  if (combo.alt) await page.keyboard.down('Alt');
  await page.keyboard.press(combo.key);
  if (combo.ctrl) await page.keyboard.up('Control');
  if (combo.shift) await page.keyboard.up('Shift');
  if (combo.alt) await page.keyboard.up('Alt');
};
/** 无头 Edge 的 CDP 右键派发偶发挂起（实测），右键统一用合成 contextmenu 事件 */
const synthContextMenu = (sel) =>
  page.$eval(sel, (el) =>
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 300 })),
  );
const openByTree = async (name) => {
  await page.waitForFunction(
    (n) => [...document.querySelectorAll('.tree-row')].find((e) => e.textContent?.includes(n)),
    { timeout: 10000 }, name,
  );
  await page.evaluate((n) => {
    const row = [...document.querySelectorAll('.tree-row')].find((e) => e.textContent.includes(n));
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }, name);
};

const t0 = Date.now();
try {
  await page.goto('http://localhost:1420/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="welcome"]', { timeout: 30000 });
  await page.waitForSelector('.tree-row', { timeout: 15000 });
  console.log('READY_MS', Date.now() - t0);

  // ---------- 1. 欢迎页 + 最近文件 ----------
  const recentCount = await page.$$eval('.recent-item', (els) => els.length);
  ok('welcome.recent', recentCount >= 2, `recents=${recentCount}`);
  ok('welcome.text', (await text('.welcome-logo')).includes('墨卷'));

  // ---------- 2. 文件树双击打开（标签 1：短文档） ----------
  await openByTree('欢迎使用墨卷.md');
  await page.waitForSelector('.tab.active', { timeout: 15000 });
  await page.waitForSelector('.mj-block', { timeout: 20000 });
  await sleep(400);
  ok('tab.open1', (await text('.tab.active')).includes('欢迎使用墨卷.md'));
  ok('reader.h1', (await page.$eval('.mj-block', (el) => el.textContent)).includes('欢迎使用墨卷'));
  const sbText1 = await text('[data-testid="statusbar"]');
  ok('statusbar.count', /字|字符/.test(sbText1), sbText1.slice(0, 60));

  // ---------- 3. 第二个标签 + 点切换 ----------
  await openByTree('随想录.md');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 2, { timeout: 15000 });
  await sleep(500);
  ok('tab.open2.active', (await text('.tab.active')).includes('随想录.md'));
  ok('reader.switched', (await page.$eval('.mj-block', (el) => el.textContent)).includes('随想录'));
  await page.click('.tab[data-path*="欢迎使用墨卷.md"]');
  await sleep(400);
  ok('tab.clickSwitch', (await text('.tab.active')).includes('欢迎使用墨卷.md'));

  // ---------- 4. 展开目录 + 打开 >1MB 分块文档 ----------
  const dirRow = await page.evaluateHandle(() => [...document.querySelectorAll('.tree-row')].find((e) => e.textContent.includes('长篇')));
  await dirRow.asElement().click();
  await sleep(500);
  await openByTree('千里江山传.md');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 3, { timeout: 30000 });
  await page.waitForSelector('.mj-block', { timeout: 30000 });
  await sleep(1200);
  ok('big.open', (await text('.tab.active')).includes('千里江山传.md'));
  const sbBig = await text('[data-testid="statusbar"]');
  ok('big.chunked', sbBig.includes('分块'), sbBig.slice(0, 60));
  ok('big.blocksRendered', (await page.$$eval('.mj-block', (els) => els.length)) > 0);

  // ---------- 5. 滚动 → 状态栏百分比更新 ----------
  const pctBefore = parseFloat(await text('[data-testid="sb-percent"]'));
  await page.$eval('.mj-reader', (el) => { el.scrollTop = 1200; });
  await sleep(600);
  const pctAfter = parseFloat(await text('[data-testid="sb-percent"]'));
  ok('statusbar.percentUpdate', pctAfter > pctBefore, `${pctBefore} -> ${pctAfter}`);

  // ---------- 6. 大纲点击跳块 + 跟随高亮 ----------
  const outlineCount = await page.$$eval('.outline-item', (els) => els.length);
  ok('outline.items', outlineCount >= 10, `items=${outlineCount}`);
  await page.$$eval('.outline-item', (els) => els[els.length - 1].click());
  await sleep(900);
  const blockTop = await page.evaluate(() => document.querySelector('.mj-reader').scrollTop);
  ok('outline.jump', blockTop > 2000, `scrollTop=${Math.round(blockTop)}`);
  const outlineActive = await page.$$eval('.outline-item', (els) => els.some((e) => e.classList.contains('active')));
  ok('outline.followHighlight', outlineActive);

  // ---------- 7. Ctrl+E 三模式循环（大文档恢复进度） ----------
  await key({ ctrl: true, key: 'KeyE' }); // read -> split
  await sleep(500);
  ok('mode.split', (await exists('.split-view')) && (await exists('.cm-editor')) && (await exists('.mj-reader')));
  await key({ ctrl: true, key: 'KeyE' }); // split -> edit
  await sleep(500);
  ok('mode.edit', (await exists('.cm-editor')) && !(await exists('.mj-reader')) && !(await exists('.split-view')));
  await key({ ctrl: true, key: 'KeyE' }); // edit -> read
  await sleep(600);
  ok('mode.read', (await exists('.mj-reader')) && !(await exists('.cm-editor')));
  const pctAfterMode = parseFloat(await text('[data-testid="sb-percent"]'));
  ok('mode.readerRestored', pctAfterMode > 1, `percent=${pctAfterMode}`);

  // ---------- 8. Ctrl+F 查找条（含选区带入 + F3 计数） ----------
  await page.evaluate(() => {
    const h = document.querySelector('.mj-block h1') || document.querySelector('.mj-block h2') || document.querySelector('.mj-block p');
    const sel = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(h);
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await key({ ctrl: true, key: 'KeyF' });
  await page.waitForSelector('[data-testid="findbar"]', { timeout: 5000 });
  const findVal = await page.$eval('[data-testid="findbar"] input', (el) => el.value);
  ok('findbar.selectionBrought', findVal.length > 0, `query="${findVal.slice(0, 20)}"`);
  await page.evaluate(() => { const i = document.querySelector('[data-testid="findbar"] input'); i.value = '江山'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(1800); // 300ms 防抖 + 大文档带高亮重渲染约 0.5s
  const findCount = await text('.find-count');
  ok('findbar.count', /\d+ \/ \d+/.test(findCount.trim()), findCount.trim());
  const markCount = await page.evaluate(() => document.querySelectorAll('mark[data-hit]').length);
  ok('findbar.marks', markCount > 0, `mountedMarks=${markCount}`);
  await key({ key: 'Escape' });
  await sleep(300);
  ok('findbar.escClose', !(await exists('[data-testid="findbar"]')));

  // ---------- 9. 右键菜单（阅读区） ----------
  await synthContextMenu('.mj-reader');
  await page.waitForSelector('[data-testid="ctx-menu"]', { timeout: 5000 });
  const menuText = await text('[data-testid="ctx-menu"]');
  ok('ctxmenu.reader', menuText.includes('查找') && menuText.includes('全选'), menuText.slice(0, 50));
  await key({ key: 'Escape' });
  await sleep(200);
  ok('ctxmenu.escClose', !(await exists('[data-testid="ctx-menu"]')));

  // ---------- 10. Ctrl+G 百分比跳转 ----------
  await key({ ctrl: true, key: 'KeyG' });
  await page.waitForSelector('[data-testid="prompt-dialog"]', { timeout: 5000 });
  await page.type('.prompt-input', '80%');
  await page.keyboard.press('Enter');
  await sleep(900);
  const pctGoto = parseFloat(await text('[data-testid="sb-percent"]'));
  ok('goto.percent', pctGoto > 60, `percent=${pctGoto}`);

  // ---------- 11. 状态栏点击百分比跳转 ----------
  await page.click('[data-testid="sb-percent"]');
  await page.waitForSelector('.sb-percent-edit input', { timeout: 5000 });
  await page.type('.sb-percent-edit input', '5');
  await page.keyboard.press('Enter');
  await sleep(900);
  const pctBack = parseFloat(await text('[data-testid="sb-percent"]'));
  ok('statusbar.percentJump', pctBack < 20, `percent=${pctBack}`);

  // ---------- 12. Ctrl+S 保存 ----------
  await key({ ctrl: true, key: 'KeyS' });
  await sleep(600);
  const savedMsg = await page.$eval('[data-testid="statusbar"]', (el) => el.textContent);
  ok('save.ctrlS', savedMsg.includes('已保存'), savedMsg.slice(-30));

  // ---------- 13. Ctrl+P 命令面板（模糊搜文件） ----------
  await key({ ctrl: true, key: 'KeyP' });
  await page.waitForSelector('[data-testid="palette"]', { timeout: 5000 });
  await page.type('.pal-input', '纪要');
  await sleep(400);
  const palRows = await page.$$eval('.pal-row', (els) => els.map((e) => e.textContent));
  ok('palette.fuzzy', palRows.some((t) => t.includes('会议纪要')), JSON.stringify(palRows.slice(0, 3)));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 4, { timeout: 20000 });
  await sleep(900);
  ok('palette.openFile', (await text('.tab.active')).includes('会议纪要.md'));

  // ---------- 15. Ctrl+Tab 切换（无头浏览器可能拦截，允许降级） ----------
  try {
    await key({ ctrl: true, key: 'Tab' });
    await sleep(500);
    const active = await text('.tab.active');
    if (active.includes('会议纪要.md')) console.log('INFO Ctrl+Tab 被浏览器拦截（真窗验证）');
    else ok('tab.ctrlTab', true, `active=${active.slice(0, 30)}`);
  } catch { console.log('INFO Ctrl+Tab 不可发送'); }

  // ---------- 16. 标签右键菜单：关闭其他 ----------
  await synthContextMenu('.tab[data-path*="千里江山传.md"]');
  await page.waitForSelector('[data-testid="ctx-menu"]', { timeout: 5000 });
  const tabMenu = await text('[data-testid="ctx-menu"]');
  ok('ctxmenu.tab', tabMenu.includes('关闭其他') && tabMenu.includes('关闭右侧'), tabMenu.slice(0, 60));
  const menuBtns = await page.$$('[data-testid="ctx-menu"] .menu-item');
  for (const b of menuBtns) {
    const t = await b.evaluate((el) => el.textContent);
    if (t.includes('关闭其他')) { await b.click(); break; }
  }
  await sleep(400);
  const tabLeft = await page.$$eval('.tab', (els) => els.length);
  ok('tab.closeOthers', tabLeft === 1, `tabs=${tabLeft}`);

  // ---------- 17. 打开两个 + 中键关闭 ----------
  await openByTree('欢迎使用墨卷.md');
  await sleep(700);
  const tabsBefore = await page.$$eval('.tab', (els) => els.length);
  const box = await (await page.$('.tab[data-path*="欢迎使用墨卷.md"]')).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'middle' });
  await sleep(400);
  const tabsAfter = await page.$$eval('.tab', (els) => els.length);
  ok('tab.middleClose', tabsAfter === tabsBefore - 1, `${tabsBefore} -> ${tabsAfter}`);

  // ---------- 18. F8 极简模式 + Esc 退出 ----------
  // 注：极简模式通过条件渲染卸载 titlebar/statusbar（不是 CSS 隐藏）
  await key({ key: 'F8' });
  await sleep(400);
  const minimalCls = await page.$eval('.app-frame', (el) => el.classList.contains('minimal'));
  const titlebarGone = !(await exists('.titlebar'));
  const statusbarGone = !(await exists('[data-testid="statusbar"]'));
  const tabstripVisible = await page.$eval('.tabstrip', (el) => getComputedStyle(el).display !== 'none');
  ok('minimal.on', minimalCls && titlebarGone && statusbarGone && tabstripVisible, `cls=${minimalCls} tb=${titlebarGone} sb=${statusbarGone}`);
  await key({ key: 'Escape' });
  await sleep(400);
  const statusbarBack = await exists('[data-testid="statusbar"]');
  const minimalOff = await page.$eval('.app-frame', (el) => !el.classList.contains('minimal'));
  ok('minimal.escExit', statusbarBack && minimalOff);

  // ---------- 19. 设置对话框：主题/字号/页宽/自动保存 ----------
  await key({ ctrl: true, key: 'Comma' });
  await page.waitForSelector('[data-testid="settings-dialog"]', { timeout: 5000 });
  await page.click('[data-theme-choice="dark"]');
  await sleep(300);
  ok('settings.themeDark', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  await page.click('[data-theme-choice="light"]');
  await sleep(300);
  ok('settings.themeLight', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  const fsBefore = await page.evaluate(() => document.documentElement.style.getPropertyValue('--reader-font-size'));
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.dlg-row')];
    const row = rows.find((r) => r.textContent.includes('字号'));
    row.querySelectorAll('button').forEach((b) => { if (b.textContent.includes('＋')) b.click(); });
  });
  await sleep(300);
  const fsAfter = await page.evaluate(() => document.documentElement.style.getPropertyValue('--reader-font-size'));
  ok('settings.fontSize', fsBefore !== fsAfter, `${fsBefore} -> ${fsAfter}`);
  const mwBefore = await page.evaluate(() => document.documentElement.style.getPropertyValue('--reader-measure'));
  await page.click('[data-measure-em="60"]');
  await sleep(300);
  const mwAfter = await page.evaluate(() => document.documentElement.style.getPropertyValue('--reader-measure'));
  ok('settings.measure', mwBefore !== mwAfter, `${mwBefore} -> ${mwAfter}`);
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.dlg-row')];
    const row = rows.find((r) => r.textContent.includes('自动保存'));
    row.querySelector('.switch').click();
  });
  await sleep(200);
  const autosaveOff = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.dlg-row')];
    const row = rows.find((r) => r.textContent.includes('自动保存'));
    return !row.querySelector('.switch').classList.contains('on');
  });
  ok('settings.autosaveToggle', autosaveOff);
  await page.click('[data-theme-choice="dark"]'); // 留在暗色做收尾
  await page.evaluate(() => {
    document.querySelector('[data-testid="settings-dialog"] .dlg-head .side-btn').click();
  });
  await sleep(300);
  ok('settings.close', !(await exists('[data-testid="settings-dialog"]')));

  // ---------- 20. 工作区搜索 ----------
  const searchInput = await page.$('.search-box input');
  await searchInput.click();
  await searchInput.type('里程碑');
  await page.keyboard.press('Enter');
  await sleep(1200);
  const hitText = await page.$eval('.search-hit', (el) => el.textContent).catch(() => '');
  ok('search.hit', hitText.includes('会议纪要'), hitText.slice(0, 40));
  await page.click('.search-hit');
  await sleep(900);
  ok('search.open', (await text('.tab.active')).includes('会议纪要.md'));

  // ---------- 21. 文件树：新建 + 删除（确认对话框） ----------
  await page.click('.files-section .side-btn'); // 新建文件
  await page.waitForSelector('[data-testid="prompt-dialog"]', { timeout: 5000 });
  await page.evaluate(() => { const i = document.querySelector('.prompt-input'); i.value = ''; });
  await page.type('.prompt-input', 'D:/笔记/测试新建.md');
  await page.keyboard.press('Enter');
  await sleep(1200);
  ok('file.create', (await text('.tab.active')).includes('测试新建.md'));
  const treeHasNew = await page.evaluate(() => [...document.querySelectorAll('.tree-row')].some((e) => e.textContent.includes('测试新建.md')));
  ok('file.createInTree', treeHasNew);
  const newTabCount = await page.$$eval('.tab', (els) => els.length);
  // 右键打到目标行（'.tree-row' 首行是目录，会删错对象）
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.tree-row')].find((e) => e.textContent.includes('测试新建.md'));
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 300 }));
  });
  await page.waitForSelector('[data-testid="ctx-menu"]', { timeout: 5000 });
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-testid="ctx-menu"] .menu-item')];
    items.find((i) => i.textContent.includes('删除')).click();
  });
  await page.waitForSelector('[data-testid="prompt-dialog"]', { timeout: 5000 });
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-testid="prompt-dialog"] button')];
    btns.find((b) => b.textContent === '删除').click();
  });
  await sleep(1200);
  const treeAfterDel = await page.evaluate(() => ![...document.querySelectorAll('.tree-row')].some((e) => e.textContent.includes('测试新建.md')));
  ok('file.delete', treeAfterDel);
  const tabsAfterDel = await page.$$eval('.tab', (els) => els.length);
  ok('file.deleteClosesTab', tabsAfterDel === newTabCount - 1, `${newTabCount} -> ${tabsAfterDel}`);

  // ---------- 22. 进度记忆：切回大文档滚动 → 刷新 → 自动恢复 ----------
  await page.click('.tab[data-path*="千里江山传.md"]');
  await sleep(1200);
  await page.$eval('.mj-reader', (el) => { el.scrollTop = el.scrollHeight * 0.4; });
  await sleep(3500); // 等 3s 节流落盘
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.mj-block', { timeout: 30000 });
  await sleep(1600);
  const pctRestored = parseFloat(await text('[data-testid="sb-percent"]'));
  const activeAfterReload = await text('.tab.active');
  ok('progress.reopenRestore', pctRestored > 25, `active=${activeAfterReload.slice(0, 24)} percent=${pctRestored}`);

  // ---------- 23. Alt+← 导航历史 ----------
  await key({ alt: true, key: 'ArrowLeft' });
  await sleep(900);
  const navActive = await text('.tab.active');
  ok('nav.back', navActive.length > 0, `active=${navActive.slice(0, 30)}`);

  // ---------- 24. 侧栏宽度拖拽 ----------
  const wBefore = await page.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().width);
  const rb = await (await page.$('.sidebar-resizer')).boundingBox();
  await page.mouse.move(rb.x + 2, rb.y + 200);
  await page.mouse.down();
  await page.mouse.move(rb.x + 102, rb.y + 200, { steps: 5 });
  await page.mouse.up();
  await sleep(300);
  const wAfter = await page.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().width);
  ok('sidebar.resize', Math.abs(wAfter - wBefore) >= 90, `${Math.round(wBefore)} -> ${Math.round(wAfter)}`);

  // ---------- 25. Ctrl+滚轮缩放 / Ctrl+0 复位（合成 WheelEvent） ----------
  const fz1 = await page.evaluate(() => document.documentElement.style.getPropertyValue('--reader-font-size'));
  await page.evaluate(() => {
    document.querySelector('.mj-reader').dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -240, bubbles: true, cancelable: true }));
  });
  await sleep(300);
  const fz2 = await page.evaluate(() => document.documentElement.style.getPropertyValue('--reader-font-size'));
  await page.evaluate(() => {
    document.querySelector('.mj-reader').dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 240, bubbles: true, cancelable: true }));
  });
  await sleep(300);
  const fz3 = await page.evaluate(() => document.documentElement.style.getPropertyValue('--reader-font-size'));
  ok('zoom.ctrlWheel', fz1 !== fz2 && fz2 !== fz3 && fz3 === fz1, `${fz1} -> ${fz2} -> ${fz3}`);
  await key({ ctrl: true, key: 'Digit0' });
  await sleep(300);
  const fz4 = await page.evaluate(() => document.documentElement.style.getPropertyValue('--reader-font-size'));
  ok('zoom.reset', fz4 === '17px', fz4);
} catch (e) {
  fail++;
  console.log('CRASH', e.message.slice(0, 200));
  try {
    const st = await page.evaluate(() => ({
      appFrame: !!document.querySelector('.app-frame'),
      statusbar: !!document.querySelector('[data-testid="statusbar"]'),
      minimal: document.querySelector('.app-frame')?.className ?? '(no frame)',
      bodyLen: document.body.innerHTML.length,
      snip: document.body.innerHTML.slice(0, 300),
    }));
    console.log('SCENE', JSON.stringify(st));
  } catch { console.log('SCENE unavailable'); }
}
console.log('---');
console.log(`RESULT pass=${pass} fail=${fail}`);
console.log('ERRORS', JSON.stringify([...new Set(errs)].slice(0, 12)));
await browser.close();
process.exit(fail > 0 ? 1 : 0);
