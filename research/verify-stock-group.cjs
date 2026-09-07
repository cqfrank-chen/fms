/* 验证库存列表按产品合并展开：组行聚合 + 展开看批次 + 展开/收起按钮 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.replace(/\s+/g, '');

(async () => {
  const baseUrl = process.argv[2] || 'http://localhost/';
  const outDir = process.argv[3] || 'shots-stock-group';
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const p = await b.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.setViewport({ width: 1560, height: 1100 });
  await p.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(800);
  // 进仓储页
  await p.evaluate(() => {
    const n = (s) => s.replace(/\s+/g, '');
    const el = [...document.querySelectorAll('.ant-menu-item, .ant-menu-title-content')]
      .find((x) => n(x.textContent || '') === '仓储' && x.offsetParent !== null);
    el?.click();
  });
  await sleep(1200);

  const snap = () => p.evaluate(() => {
    const rows = [...document.querySelectorAll('.ant-table-tbody > tr.ant-table-row, .ant-table-tbody > tr.ant-table-row-level-0, .ant-table-tbody > tr.ant-table-row-level-1')];
    const level0 = [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row-level-0')];
    const expandIcons = [...document.querySelectorAll('.ant-table-row-expand-icon')].filter((i) => !i.className.includes('spaced'));
    return {
      rowCount: rows.length,
      level0: level0.map((r) => ({ text: r.innerText.slice(0, 90), exp: (r.querySelector('.ant-table-row-expand-icon')?.className || '').includes('expanded') })),
      level1: [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row-level-1')].map((r) => r.innerText.slice(0, 80)),
      expandIcons: expandIcons.length,
      bodyHasBatch: document.body.innerText.includes('FG-20260903-01'),
    };
  });

  // 折叠态快照
  const c0 = await snap();
  const groupRows = c0.level0.length;
  console.log(`折叠态: 组行=${groupRows} 展开箭头=${c0.expandIcons} 批次可见=${c0.bodyHasBatch}`);
  await p.screenshot({ path: `${outDir}/1-collapsed.png`, fullPage: false });

  // 展开第一组（点击行内展开图标）
  const clicked = await p.evaluate(() => {
    const icon = document.querySelector('.ant-table-tbody tr.ant-table-row-level-0 .ant-table-row-expand-icon');
    icon?.click();
    return !!icon;
  });
  await sleep(1100);
  const c1 = await snap();
  console.log(`展开后: 点击图标=${clicked} 子行批次数=${c1.level1.length} 展开标记=${c1.level0[0]?.exp}`);
  console.log(`  子行: ${JSON.stringify(c1.level1)}`);
  await p.screenshot({ path: `${outDir}/2-expanded.png`, fullPage: false });

  // 展开全部
  await p.evaluate(() => {
    const n = (s) => s.replace(/\s+/g, '');
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find((x) => n(x.textContent || '') === '展开全部');
    b?.click();
  });
  await sleep(900);
  const c2 = await snap();
  console.log(`展开全部: 全部展开=${c2.level0.every((r) => r.exp)} 子行总=${c2.level1.length}`);

  // 收起全部
  await p.evaluate(() => {
    const n = (s) => s.replace(/\s+/g, '');
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find((x) => n(x.textContent || '') === '收起全部');
    b?.click();
  });
  await sleep(900);
  const c3 = await snap();
  console.log(`收起全部: 全部收起=${c3.level0.every((r) => !r.exp)} 子行总=${c3.level1.length}`);

  const err = errors.filter((e) => !e.includes('favicon'));
  console.log('console errors:', err.length ? err : '(none)');
  const ok = groupRows === 2 && c1.level1.length >= 1 && c2.level1.length === 4 && c2.level0.every((r) => r.exp) && c3.level0.every((r) => !r.exp) && c3.level1.length === 0 && !err.length;
  console.log(`判定: ${ok ? 'ALL-OK' : 'FAIL'}`);
  await b.close();
})().catch((e) => { console.error('SCRIPT ERROR:', e.message); process.exit(1); });
