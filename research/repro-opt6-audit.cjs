// 本轮优化回归（2026-09-07，六项优化拍板后）
// A. 订单列表 updatedAt + totalAmount（后端字段）
// D. 应收改在「订单确认」时生成（sourceType=order，携带 orderNo）
// E. 计划单驳回 → 撤销确认时开立的应收（voided），订单回草稿
// G. 出库不再生成应收；出库冲销按退回金额冲减订单应收
// F. 无订单手动入库：/receipts/manual → 确认入账 → 库存+（来源空=手动）
// UI1 订单列表渲染总额/更新时间列
// UI2 仓储 Tab 切换重挂（destroyOnHidden）→ 入库确认后切回库存列表显示新批次
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = [];
const fail = [];
const ok = (n, cond, extra = '') => { (cond ? pass : fail).push(`${n}${extra ? ' | ' + extra : ''}`); };
const norm = (s) => s.replace(/\s+/g, '');

(async () => {
  const base = (process.argv[2] || 'http://localhost/').replace(/\/$/, '');
  const outDir = process.argv[3] || 'shots-opt6';
  fs.mkdirSync(outDir, { recursive: true });
  const B = base + '/api';

  async function call(method, p, body) {
    const r = await fetch(B + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const txt = await r.text();
    let j = null;
    try { j = txt ? JSON.parse(txt) : null; } catch { j = txt; }
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${typeof j === 'string' ? j : JSON.stringify(j)}`);
    return j;
  }
  const get = (p) => call('GET', p);
  const post = (p, b) => call('POST', p, b || {});

  const P = await post('/products', { name: 'OPT6-回归产品', type: 'uk_acetylene', safetyStock: 0 });
  ok('P0 建测试产品', !!P.id, `product=${P.id}`);

  // ---------- F：无单手动入库 → 确认 → 库存+ ----------
  const R1 = await post('/receipts/manual', { productId: P.id, quantity: 10, batchNo: 'OPT6-MAN-1', note: 'opt6-manual' });
  ok('F1 手动入库生成草稿(planSheetId=null)', R1.id && R1.planSheetId == null, `GR=${R1.receiptNo}`);
  await post(`/receipts/${R1.id}/confirm`, {});
  let inv = await get('/inventory');
  let r1row = inv.find((x) => x.batchNo === 'OPT6-MAN-1');
  ok('F2 确认后库存出现手动批次 qty=10', r1row && r1row.quantity === 10, `qty=${r1row?.quantity}`);

  // ---------- D：订单确认即开应收 ----------
  const OA = await post('/orders', {
    customerId: (await get('/customers'))[0].id, poNo: 'OPT6-A', dueDate: '2026-12-31',
    lines: [{ productId: P.id, quantity: 10, unitPrice: 2 }],
  });
  ok('A0 订单含 totalAmount=20 & updatedAt', Math.abs((OA.totalAmount ?? -1) - 20) < 0.001 && !!OA.updatedAt, `total=${OA.totalAmount}`);
  await post(`/orders/${OA.id}/confirm`, {});
  let recvs = await get('/receivables');
  let recvA = recvs.find((x) => x.sourceType === 'order' && x.sourceId === OA.id);
  ok('D1 确认订单 → 生成订单级应收 amount=20', recvA && Math.abs(recvA.amount - 20) < 0.001, `REC=${recvA?.recvNo}`);
  ok('D2 应收携带 orderNo', recvA?.orderNo === OA.orderNo, `orderNo=${recvA?.orderNo}`);

  // ---------- G：出库只扣库存不新增应收；冲销冲减应收金额 ----------
  const ob = await post('/outbounds', { orderId: OA.id, oqc: 'exempt', lines: [{ orderLineId: OA.lines[0].id, quantity: 4 }] });
  await post(`/outbounds/${ob.id}/submit`, {});
  inv = await get('/inventory');
  r1row = inv.find((x) => x.batchNo === 'OPT6-MAN-1');
  ok('G1 出库4只 → 手动批次库存 10→6', r1row && r1row.quantity === 6, `qty=${r1row?.quantity}`);
  recvs = await get('/receivables');
  const recvACount = recvs.filter((x) => x.sourceType === 'order' && x.sourceId === OA.id && x.status !== 'voided').length;
  ok('G2 出货不再新增应收（仍 1 条 order 应收）', recvACount === 1, `count=${recvACount}`);
  await post(`/outbounds/${ob.id}/void`, {});
  inv = await get('/inventory');
  r1row = inv.find((x) => x.batchNo === 'OPT6-MAN-1');
  ok('G3 出库冲销 → 库存回补 6→10', r1row && r1row.quantity === 10, `qty=${r1row?.quantity}`);
  recvs = await get('/receivables');
  recvA = recvs.find((x) => x.sourceType === 'order' && x.sourceId === OA.id && x.status !== 'voided');
  ok('G4 冲销后应收金额冲减 20→12', recvA && Math.abs(recvA.amount - 12) < 0.001, `amount=${recvA?.amount}`);

  // ---------- E：驳回计划单 → 撤销应收 + 订单回草稿 ----------
  const OB = await post('/orders', {
    customerId: (await get('/customers'))[0].id, poNo: 'OPT6-B', dueDate: '2026-12-31',
    lines: [{ productId: P.id, quantity: 5, unitPrice: 1 }],
  });
  await post(`/orders/${OB.id}/confirm`, {});
  const planB = (await get('/plan-sheets')).find((x) => x.orderId === OB.id);
  const recvB0 = (await get('/receivables')).find((x) => x.sourceType === 'order' && x.sourceId === OB.id);
  ok('E1 确认订单 B → 应收生成', !!recvB0 && recvB0.status !== 'voided');
  await post(`/plan-sheets/${planB.id}/reject`, {});
  recvs = await get('/receivables');
  const recvB = recvs.find((x) => x.sourceType === 'order' && x.sourceId === OB.id);
  const orderB = await get(`/orders/${OB.id}`);
  ok('E2 驳回后应收作废 + 订单回草稿', recvB && recvB.status === 'voided' && orderB.status === 'draft', `recv=${recvB?.status} order=${orderB.status}`);

  // ---------- UI1：订单列表渲染（总额/更新时间列） ----------
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1100 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(600);
  await page.evaluate(() => {
    const n = (s) => s.replace(/\s+/g, '');
    const el = [...document.querySelectorAll('.ant-menu-item')].find((x) => n(x.textContent || '') === '订单');
    el?.click();
  });
  await sleep(900);
  await page.evaluate(() => {
    const n = (s) => s.replace(/\s+/g, '');
    const el = [...document.querySelectorAll('.ant-tabs-tab')].find((x) => n(x.textContent) === '订单列表');
    el?.click();
  });
  await sleep(1400);
  const headText = await page.evaluate(() => [...document.querySelectorAll('.ant-table-thead th')].map((x) => x.textContent.trim()));
  ok('UI1 订单列表含 总额/更新时间 表头', headText.includes('总额(元)') && headText.includes('更新时间'), headText.join('/'));
  await page.screenshot({ path: outDir + '/orders-list.png' });

  // ---------- UI2：仓储 Tab 重挂刷新（手动入库 → 切回库存可见） ----------
  const R2 = await post('/receipts/manual', { productId: P.id, quantity: 7, batchNo: 'OPT6-MAN-2', note: 'opt6-manual' });
  await page.evaluate(() => {
    const n = (s) => s.replace(/\s+/g, '');
    const el = [...document.querySelectorAll('.ant-menu-item')].find((x) => n(x.textContent || '') === '仓储');
    el?.click();
  });
  await sleep(900);
  // 当前在「库存列表」，切「入库确认」找到新草稿并确认
  await page.evaluate(() => {
    const n = (s) => s.replace(/\s+/g, '');
    const el = [...document.querySelectorAll('.ant-tabs-tab')].find((x) => n(x.textContent) === '入库确认');
    el?.click();
  });
  await sleep(1200);
  const confirmClicked = await page.evaluate(() => {
    const n = (s) => s.replace(/\s+/g, '');
    const row = [...document.querySelectorAll('.ant-table-tbody .ant-table-row')].find((r) => (r.textContent || '').includes('OPT6-MAN-2'));
    const btn = row && [...row.querySelectorAll('button')].find((b) => n(b.textContent || '') === '确认入库');
    btn?.click();
    return !!btn;
  });
  await sleep(1300);
  // 切回「库存列表」→ destroyOnHidden 强制重挂重拉 → 出现 OPT6-MAN-2
  await page.evaluate(() => {
    const n = (s) => s.replace(/\s+/g, '');
    const el = [...document.querySelectorAll('.ant-tabs-tab')].find((x) => n(x.textContent) === '库存列表');
    el?.click();
  });
  await sleep(1300);
  const ui2Seen = await page.evaluate(() => document.body.innerText.includes('OPT6-MAN-2'));
  ok('UI2 入库确认后切回库存列表显示新批次（destroyOnHidden 刷新）', ui2Seen, `确认按钮=${confirmClicked}`);
  await page.screenshot({ path: outDir + '/stock-after-confirm.png' });

  ok('UI 无 console/page error', errs.length === 0, errs.slice(0, 3).join(' || '));
  await browser.close();

  // ---------- 汇总 ----------
  console.log('==== 断言结果 ====');
  pass.forEach((x) => console.log('  PASS ' + x));
  fail.forEach((x) => console.log('  FAIL ' + x));
  console.log(`\n${pass.length} passed, ${fail.length} failed`);
  console.log(fail.length === 0 ? 'ALL-OK' : 'HAS-FAIL');
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => { console.error('脚本异常：', e.message); process.exit(2); });
