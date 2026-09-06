// 修复后回归 v4：多字段顺序输入应保留之前的值；同时读真实 store 校验
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = process.argv[2] || 'http://localhost/';
const outDir = process.argv[3] || './shots-repro';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snapshot(page, tag) {
  const s = await page.evaluate(() => {
    const fi = (labelSub) => {
      const it = [...document.querySelectorAll('.ant-form-item')].find((x) => x.querySelector('label')?.textContent.includes(labelSub));
      if (!it) return null;
      const inp = it.querySelector('input');
      const sel = it.querySelector('.ant-select-selection-item');
      return { input: inp?.value ?? '', select: sel?.textContent.trim() ?? '' };
    };
    const rows = [...document.querySelectorAll('table .ant-table-row')].filter((r) => r.querySelector('input, .ant-select'))
      .map((r, i) => {
        const prod = r.querySelector('.ant-select-selection-item')?.textContent.trim() ?? '';
        const nums = [...r.querySelectorAll('.ant-input-number-input')].map((x) => x.value);
        const checked = [...r.querySelectorAll('.ant-checkbox-input:checked')].length;
        const engr = [...r.querySelectorAll('input')].find((x) => x.placeholder?.includes('LOGO'));
        return { i, prod, quantity: nums[0] ?? '', unitPrice: nums[1] ?? '', engraving: engr?.value ?? '', checkedBoxes: checked };
      });
    // 真实 store
    const f = window.__orderForm;
    let store = null;
    if (f && typeof f.getFieldsValue === 'function') {
      try { store = f.getFieldsValue(true); } catch (e) { store = '(getFieldsValue err: ' + e.message + ')'; }
    }
    return { header: { customer: fi('客户档案')?.select, po: fi('PO')?.input, due: fi('交期')?.input, note: fi('备注')?.input }, rows, store };
  });
  console.log(`\n=== [${tag}] ===\n${JSON.stringify(s, null, 1)}`);
}

async function pickVisible(page, idx = 0) {
  return page.evaluate((idx) => {
    const dd = [...document.querySelectorAll('.ant-select-dropdown')].find((x) => getComputedStyle(x).display !== 'none' && getComputedStyle(x).visibility !== 'hidden');
    if (!dd) return null;
    const opt = dd.querySelectorAll('.ant-select-item-option')[idx];
    if (!opt) return null;
    const txt = opt.textContent.trim();
    opt.click();
    return txt;
  }, idx);
}
async function focusNthNumInput(page, rowIdx, n) {
  return page.evaluate((rowIdx, n) => {
    const rows = document.querySelectorAll('table .ant-table-row');
    const row = rows[rowIdx];
    const nums = row?.querySelectorAll('.ant-input-number-input');
    const el = nums?.[n];
    if (!el) return false;
    el.focus();
    el.setSelectionRange?.(0, el.value?.length ?? 0);
    return true;
  }, rowIdx, n);
}
async function focusEngraving(page) {
  return page.evaluate(() => {
    const row = document.querySelectorAll('table .ant-table-row')[0];
    const inp = [...row.querySelectorAll('input')].find((x) => x.placeholder?.includes('LOGO'));
    if (!inp) return false;
    inp.focus();
    return true;
  });
}

async function main() {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1560, height: 1000, deviceScaleFactor: 1.25 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('deprecated')) pageErrors.push(m.text()); });
  fs.mkdirSync(outDir, { recursive: true });

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.ant-menu-item, .ant-menu-title-content, [class*=menu] span')].find((x) => x.textContent.trim() === '订单');
    el?.click();
  });
  await sleep(1200);

  // 等 form 实例挂到 window
  await page.waitForFunction(() => !!window.__orderForm, { timeout: 10000 }).catch(() => {});
  await snapshot(page, '进入页面(应见默认 quantity=1000 unitPrice=3.5 currency=RMB)');

  // ---- 单头：客户 + PO + 交期 ----
  await page.evaluate(() => {
    const it = [...document.querySelectorAll('.ant-form-item')].find((x) => x.querySelector('label')?.textContent.includes('客户档案'));
    it?.querySelector('.ant-select-selector')?.click();
  });
  await sleep(900);
  const custOpts = await page.evaluate(() => {
    const dd = [...document.querySelectorAll('.ant-select-dropdown')].find((x) => getComputedStyle(x).display !== 'none');
    return dd ? [...dd.querySelectorAll('.ant-select-item-option')].slice(0, 3).map((x) => x.textContent.trim()) : null;
  });
  console.log('客户下拉前3项:', custOpts);
  await pickVisible(page, 0);
  await sleep(500);
  await snapshot(page, '选完客户');

  await page.evaluate(() => {
    const it = [...document.querySelectorAll('.ant-form-item')].find((x) => x.querySelector('label')?.textContent.includes('PO'));
    it?.querySelector('input')?.focus();
  });
  await page.keyboard.type('PO-TEST-001', { delay: 25 });
  await sleep(300);

  await page.evaluate(() => {
    const it = [...document.querySelectorAll('.ant-form-item')].find((x) => x.querySelector('label')?.textContent.includes('交期'));
    it?.querySelector('input')?.click();
  });
  await sleep(500);
  await page.evaluate(() => {
    const p = [...document.querySelectorAll('.ant-picker-dropdown')].find((x) => getComputedStyle(x).display !== 'none');
    p?.querySelector('.ant-picker-cell-today')?.click();
  });
  await sleep(400);
  await snapshot(page, '单头全部填完');
  await page.screenshot({ path: `${outDir}/r4-header.png` });

  // ---- 关键回归：1 行多字段顺序输入 ----
  // 步骤 A：在第 1 行 选择产品
  await page.evaluate(() => {
    const row = document.querySelectorAll('table .ant-table-row')[0];
    row?.querySelector('.ant-select-selector')?.click();
  });
  await sleep(900);
  const prodOpts = await page.evaluate(() => {
    const dd = [...document.querySelectorAll('.ant-select-dropdown')].find((x) => getComputedStyle(x).display !== 'none');
    return dd ? [...dd.querySelectorAll('.ant-select-item-option')].slice(0, 3).map((x) => x.textContent.trim()) : null;
  });
  console.log('产品下拉前3项:', prodOpts);
  await pickVisible(page, 0);
  await sleep(500);
  await snapshot(page, 'A. 第1行已选产品');
  await page.screenshot({ path: `${outDir}/r4-A.png` });

  // 步骤 B：在第 1 行 数量 输入 "200"
  await focusNthNumInput(page, 0, 0);
  await sleep(150);
  await page.keyboard.type('200', { delay: 25 });
  await sleep(400);
  await snapshot(page, 'B. 数量=200');
  await page.screenshot({ path: `${outDir}/r4-B.png` });

  // 步骤 C：在第 1 行 刻字 输入 "LOGO-A"
  await focusEngraving(page);
  await sleep(150);
  await page.keyboard.type('LOGO-A', { delay: 25 });
  await sleep(400);
  await snapshot(page, 'C. 刻字=LOGO-A');
  await page.screenshot({ path: `${outDir}/r4-C.png` });

  // 步骤 D：在第 1 行 单价 输入 "4.20"
  await focusNthNumInput(page, 0, 1);
  await sleep(150);
  await page.keyboard.type('4.20', { delay: 25 });
  await sleep(400);
  await snapshot(page, 'D. 单价=4.20');
  await page.screenshot({ path: `${outDir}/r4-D.png` });

  // 步骤 E：勾第 1 行 包装"包装盒"
  await page.evaluate(() => {
    const row = document.querySelectorAll('table .ant-table-row')[0];
    const cb = [...row.querySelectorAll('.ant-checkbox-input')][0];
    cb?.click();
  });
  await sleep(400);
  await snapshot(page, 'E. 包装勾盒');
  await page.screenshot({ path: `${outDir}/r4-E.png` });

  // 步骤 F：再点单价（不输入），确认 engrave/quantity/prod/customer 都还在
  await focusNthNumInput(page, 0, 1);
  await sleep(300);
  await snapshot(page, 'F. 重新聚焦单价(纯切焦点,不变)');
  await page.screenshot({ path: `${outDir}/r4-F.png` });

  // 步骤 G：加第 2 行
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('加一行'));
    b?.click();
  });
  await sleep(500);
  await snapshot(page, 'G. 加第2行(第1行应全保留)');
  await page.screenshot({ path: `${outDir}/r4-G.png` });

  // 步骤 H：在第 2 行 输入数量 500（应不影响第 1 行）
  await focusNthNumInput(page, 1, 0); // 第2行第1个 InputNumber (quantity)
  await sleep(200);
  await page.keyboard.type('500', { delay: 25 });
  await sleep(400);
  await snapshot(page, 'H. 第2行数量=500(第1行应保留)');
  await page.screenshot({ path: `${outDir}/r4-H.png` });

  console.log('=== PAGE ERRORS ===', pageErrors.length ? pageErrors.join('\n') : '(none)');
  await browser.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });