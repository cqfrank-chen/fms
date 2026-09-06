// I14 回归：AI 导入草稿单槽持久化（横幅→恢复→编辑自动保存→取消再恢复→放弃清除）
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = process.argv[2] || 'http://localhost/';
const outDir = process.argv[3] || './shots-i14';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });

const seed = {
  result: {
    customerId: 1, customerName: '', customerMatch: 'exact',
    poNo: 'PO-DRAFT-001', dueDate: '2026-09-30', note: 'I14 回归草稿',
    lines: [{ productName: '', productId: 1, match: 'exact', quantity: 1200, unitPrice: 4.2, currency: 'RMB', engraving: 'LOGO-D', packaging: null, issues: [] }],
    issues: [], confidence: 'high', notes: [], directPass: true,
  },
  draft: {
    customerId: 1, poNo: 'PO-DRAFT-001', dueDate: '2026-09-30', note: 'I14 回归草稿',
    lines: [{ productId: 1, productName: '', quantity: 1200, unitPrice: 4.2, currency: 'RMB', engraving: 'LOGO-D', packaging: undefined, _badProduct: false }],
  },
};

async function apiSeed(page, body) {
  return page.evaluate(async (body) => {
    const res = await fetch('/api/ai/orders/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  }, body);
}
async function apiGet(page) {
  return page.evaluate(async () => (await fetch('/api/ai/orders/draft')).json());
}
async function apiClear(page) {
  return page.evaluate(async () => (await fetch('/api/ai/orders/draft', { method: 'DELETE' })).json());
}
async function hasText(page, needle) {
  return page.evaluate((needle) => document.body.innerText.includes(needle), needle);
}
async function clickBtn(page, label) {
  return page.evaluate((label) => {
    const norm = (s) => s.replace(/\s+/g, '');
    const b = [...document.querySelectorAll('button')].find(
      (x) => norm(x.textContent).trim() === norm(label) && x.offsetParent !== null,
    );
    b?.click();
    return !!b;
  }, label);
}
async function closeModalX(page) {
  return page.evaluate(() => {
    const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
    const x = m?.querySelector('.ant-modal-close');
    x?.click();
    return !!x;
  });
}
async function modalInfo(page) {
  return page.evaluate(() => {
    const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
    if (!m) return null;
    const rows = [...m.querySelectorAll('table .ant-table-row')].map((r) => {
      const nums = [...r.querySelectorAll('.ant-input-number-input')].map((x) => x.value);
      const engr = [...r.querySelectorAll('input')].find((x) => x.placeholder?.includes('LOGO'));
      return { quantity: nums[0] ?? '', unitPrice: nums[1] ?? '', engraving: engr?.value ?? '' };
    });
    return { title: m.querySelector('.ant-modal-title')?.textContent.trim() ?? '', rows, hasTable: !!m.querySelector('table') };
  });
}
async function typeNthQuantity(page, rowIdx, value) {
  const ok = await page.evaluate((rowIdx) => {
    const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
    const rows = m ? m.querySelectorAll('table .ant-table-row') : [];
    const el = rows[rowIdx]?.querySelector('.ant-input-number-input');
    if (!el) return false;
    el.focus(); el.setSelectionRange?.(0, el.value?.length ?? 0);
    return true;
  }, rowIdx);
  if (!ok) return false;
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.type(String(value), { delay: 20 });
  return true;
}

async function main() {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('deprecated')) pageErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  // 0. 清场
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await apiClear(page);
  await sleep(300);

  // 1. 导航订单页：横幅应不出现
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.ant-menu-item, .ant-menu-title-content, [class*=menu] span')].find((x) => x.textContent.trim() === '订单');
    el?.click();
  });
  await page.waitForFunction(() => document.body.innerText.includes('📷 AI 导入订单'), { timeout: 20000 });
  await sleep(600);
  const b1 = await hasText(page, '有未提交的 AI 订单草稿');
  console.log('STEP1 无草稿时无横幅:', b1 ? 'FAIL(出现)' : 'OK(不出现)');
  await page.screenshot({ path: `${outDir}/i14-1-clean.png` });

  // 2. 种入草稿 + 刷新页面 → 横幅出现
  await apiSeed(page, seed);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.ant-menu-item, .ant-menu-title-content, [class*=menu] span')].find((x) => x.textContent.trim() === '订单');
    el?.click();
  });
  await page.waitForFunction(() => document.body.innerText.includes('📷 AI 导入订单'), { timeout: 20000 });
  await page.waitForFunction(() => document.body.innerText.includes('有未提交的 AI 订单草稿'), { timeout: 20000 });
  console.log('STEP2 刷新后横幅出现: OK');
  await page.screenshot({ path: `${outDir}/i14-2-banner.png` });

  // 3. 恢复草稿 → 复核弹窗打开且行值还原
  await clickBtn(page, '恢复草稿');
  await page.waitForFunction(() => [...document.querySelectorAll('.ant-modal')].some((x) => x.offsetParent !== null), { timeout: 10000 });
  await sleep(500);
  const m3 = await modalInfo(page);
  console.log('STEP3 恢复弹窗:', JSON.stringify(m3));
  await page.screenshot({ path: `${outDir}/i14-3-restored.png` });

  // 4. 编辑数量 1200→800 → 防抖自动保存 → 后端 draft.lines[0].quantity=800
  await typeNthQuantity(page, 0, 800);
  await sleep(1600);
  const g4 = await apiGet(page);
  const q4 = g4.draft?.draft?.lines?.[0]?.quantity;
  console.log('STEP4 自动保存后后端数量:', q4, q4 === 800 ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/i14-4-edit.png` });

  // 5. 关闭弹窗（不建单）→ 横幅复现，后端草稿仍在
  const x5 = await closeModalX(page);
  await page.waitForFunction(() => [...document.querySelectorAll('.ant-modal')].every((x) => x.offsetParent === null || getComputedStyle(x).visibility === 'hidden'), { timeout: 8000 });
  await sleep(400);
  const b5 = await hasText(page, '有未提交的 AI 订单草稿');
  const g5 = await apiGet(page);
  console.log('STEP5 X关闭(close', x5, ')', '| 横幅:', b5 ? 'OK' : 'FAIL', '| 后端仍有草稿:', !!g5.draft ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/i14-5-after-cancel.png` });

  // 6. 再次恢复 → 改备注后直接放弃 → 横幅消失 + 后端清除
  await clickBtn(page, '恢复草稿');
  await page.waitForFunction(() => [...document.querySelectorAll('.ant-modal')].some((x) => x.offsetParent !== null), { timeout: 10000 });
  await sleep(400);
  await closeModalX(page);
  // 等横幅复现（更长 timeout）
  await page.waitForFunction(() => document.body.innerText.includes('有未提交的 AI 订单草稿'), { timeout: 8000 });
  await sleep(400);
  await page.screenshot({ path: `${outDir}/i14-6a-pre-discard.png` });
  const discarded = await clickBtn(page, '放弃');
  await page.waitForFunction(() => !document.body.innerText.includes('有未提交的 AI 订单草稿'), { timeout: 6000 }).catch(() => {});
  await sleep(400);
  const b6 = await hasText(page, '有未提交的 AI 订单草稿');
  const g6 = await apiGet(page);
  console.log('STEP6 放弃 clicked=', discarded, '| 横幅:', b6 ? 'FAIL(仍在)' : 'OK(消失)', '| 后端清除:', g6.draft === null ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/i14-6-discarded.png` });

  console.log('=== PAGE ERRORS ===', pageErrors.length ? pageErrors.join('\n') : '(none)');
  await browser.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
