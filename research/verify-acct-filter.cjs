/* 验证账目筛选 + 应收倒序：应收首行=最新 / 客户筛选生效 / 清空 / 各 Tab 筛选条存在 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.replace(/\s+/g, '');

(async () => {
  const baseUrl = process.argv[2] || 'http://localhost/';
  const outDir = process.argv[3] || 'shots-acct-filter';
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const p = await b.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.setViewport({ width: 1600, height: 1100 });
  await p.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(800);
  // 进账目页
  await p.evaluate(() => {
    const n = (s) => s.replace(/\s+/g, '');
    const el = [...document.querySelectorAll('.ant-menu-item, .ant-menu-title-content')]
      .find((x) => n(x.textContent || '') === '账目' && x.offsetParent !== null);
    el?.click();
  });
  await sleep(1200);

  const rowsText = () => p.evaluate(() =>
    [...document.querySelectorAll('.ant-table-tbody .ant-table-row')].map((r) => r.innerText.replace(/\s+/g, ' ')));

  // STEP1 应收默认 Tab：首行应为最新应收 REC-20260907-01（后端 desc）
  const r1 = await rowsText();
  const firstHasLatest = r1[0]?.includes('REC-20260907-01');
  const sortOk = r1.length >= 2 && r1[0]?.includes('REC-20260907-01') && r1[1]?.includes('REC-DEMO-OVERDUE');
  console.log(`STEP1 应收倒序: 行数=${r1.length} 首行=最新${firstHasLatest ? 'OK' : 'FAIL'} 整体降序=${sortOk ? 'OK' : 'FAIL'}`);
  await p.screenshot({ path: `${outDir}/1-receivable.png`, fullPage: false });

  // STEP2 客户筛选：真实鼠标点击「按客户筛选」→ 下拉选「宁波安宝」→ 仅剩其 1 行
  const boxOf = (ph) => p.evaluate((ph2) => {
    const s = [...document.querySelectorAll('.ant-select')].find((x) => (x.textContent || '').includes(ph2));
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, ph);
  const optBoxOf = (name) => p.evaluate((nm) => {
    const dd = [...document.querySelectorAll('.ant-select-dropdown')].find((d) => !d.className.includes('hidden'));
    const opt = dd && [...dd.querySelectorAll('.ant-select-item-option')]
      .find((o) => (o.textContent || '').replace(/\s+/g, '').includes(nm));
    if (!opt) return null;
    const r = opt.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, name);

  const cBox = await boxOf('按客户筛选');
  if (cBox) await p.mouse.click(cBox.x, cBox.y);
  await sleep(700);
  const optName = '宁波安宝国际贸易有限公司';
  const oBox = await optBoxOf(optName);
  if (oBox) await p.mouse.click(oBox.x, oBox.y);
  await sleep(900);
  const r2 = await rowsText();
  const custFilterOk = !!cBox && !!oBox && r2.length === 1 && r2[0].includes('宁波安宝');
  const meta2 = await p.evaluate(() => {
    const t = [...document.querySelectorAll('.ant-typography')].map((x) => x.textContent).find((x) => /^\d+\s*\/\s*\d+\s*条$/.test(x || ''));
    return t || '';
  });
  console.log(`STEP2 客户筛选: 打开=${!!cBox} 选中=${!!oBox} 剩${r2.length}行=${r2.length === 1 ? 'OK' : 'FAIL'} 计数=${meta2 || '(未找到)'}`);
  await p.screenshot({ path: `${outDir}/2-filtered.png`, fullPage: false });

  // STEP3 清空筛选 → 恢复全部
  await p.evaluate(() => {
    const n = (s) => s.replace(/\s+/g, '');
    const btn = [...document.querySelectorAll('button')].find((x) => n(x.textContent || '') === '清空筛选');
    btn?.click();
  });
  await sleep(900);
  const r3 = await rowsText();
  console.log(`STEP3 清空筛选: 恢复 ${r3.length} 行 = ${r3.length === 4 ? 'OK' : 'FAIL'}`);

  // STEP4 状态筛选「逾期」→ REC-DEMO-OVERDUE 单行
  const stBox = await p.evaluate(() => {
    const s = [...document.querySelectorAll('.ant-select')].find((x) => (x.textContent || '').includes('按状态筛选'));
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (stBox) await p.mouse.click(stBox.x, stBox.y);
  await sleep(700);
  const oBox2 = await optBoxOf('逾期');
  if (oBox2) await p.mouse.click(oBox2.x, oBox2.y);
  await sleep(900);
  const r4 = await rowsText();
  const stFilterOk = !!stBox && !!oBox2 && r4.length === 1 && r4[0].includes('REC-DEMO-OVERDUE');
  console.log(`STEP4 状态筛选(逾期): 剩${r4.length}行=${stFilterOk ? 'OK' : 'FAIL'}`);

  // STEP5 其余 Tab 筛选条存在（收款/应付/付款）
  const tabs = [
    ['收款单', '按客户筛选', '按模式筛选'],
    ['应付记录', '按供应商筛选', '按状态筛选'],
    ['付款单', '按供应商筛选', '按模式筛选'],
  ];
  for (const [tab, ...ph] of tabs) {
    await p.evaluate((t) => {
      const n = (s) => s.replace(/\s+/g, '');
      const el = [...document.querySelectorAll('.ant-tabs-tab')].find((x) => n(x.textContent || '') === t);
      el?.click();
    }, tab);
    await sleep(900);
    const found = await p.evaluate((phs) => {
      const all = [...document.querySelectorAll('.ant-select')].map((x) => x.textContent || '');
      return phs.every((x) => all.some((t) => t.includes(x)));
    }, ph);
    console.log(`STEP5 ${tab} 筛选条: ${found ? 'OK' : 'FAIL'}`);
  }

  const err = errors.filter((e) => !e.includes('favicon'));
  console.log('console errors:', err.length ? err : '(none)');
  const ok = sortOk && custFilterOk && r3.length === 4 && stFilterOk && !err.length;
  console.log(`判定: ${ok ? 'ALL-OK' : 'FAIL'}`);
  await b.close();
})().catch((e) => { console.error('SCRIPT ERROR:', e.message); process.exit(1); });
