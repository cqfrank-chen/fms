// I13 回归：产品工序路线配置 UI（套用模板/部分勾选/保存往返/清空）
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = process.argv[2] || 'http://localhost/';
const outDir = process.argv[3] || './shots-i13';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });

const PRODUCT_ID = 1;
const SEED = { items: [
  { processId: 3, unitSeconds: 18, changeoverMinutes: 5 },  // turn 车削
  { processId: 4, unitSeconds: 30, changeoverMinutes: 0 },  // drill_c 钻中心孔
  { processId: 6, unitSeconds: 22, changeoverMinutes: 10 }, // thread 攻丝
] };

async function apiGet(p) { return p.evaluate(async (path) => (await fetch(path)).json(), arguments[1]); }
async function apiPut(p, path, body) {
  return p.evaluate(async ({ path, body }) => {
    const r = await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { path, body });
}
async function clickText(page, text) {
  return page.evaluate((t) => {
    const norm = (s) => s.replace(/\s+/g, '');
    const b = [...document.querySelectorAll('button')].find(
      (x) => norm(x.textContent).trim() === norm(t) && x.offsetParent !== null,
    );
    if (!b) return false;
    for (const e of ['mousedown', 'mouseup', 'click']) {
      b.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, button: 0 }));
    }
    return true;
  }, text);
}
async function pickProduct(page) {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll('*')].filter((e) => e.textContent === '选择产品以编辑路线' && e.children.length === 0);
    const ph = all[0];
    const sel = ph?.closest('.ant-select-selector') || ph?.parentElement?.parentElement;
    if (!sel) return false;
    // AntD 6 Select 用 mousedown 而非 click 触发开闭；统一派发三事件冒泡到 React 监听
    for (const t of ['mousedown', 'mouseup', 'click']) {
      sel.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0 }));
    }
    return true;
  });
}
async function chooseFirstProductOption(page, expected) {
  return page.evaluate((expected) => {
    const norm = (s) => s.replace(/\s+/g, '');
    const dds = [...document.querySelectorAll('.ant-select-dropdown')].filter((d) => !d.classList.contains('ant-select-dropdown-hidden'));
    const opts = [...dds[0]?.querySelectorAll('.ant-select-item-option') ?? []];
    const o = opts.find((x) => norm(x.textContent).includes(norm(expected)));
    if (o) {
      for (const t of ['mousedown', 'mouseup', 'click']) {
        o.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0 }));
      }
      return (o.textContent || '').trim();
    }
    return null;
  }, expected);
}
async function snapshotEditor(page) {
  return page.evaluate(() => {
    const card = [...document.querySelectorAll('.ant-card')].find((c) => c.textContent?.includes('单件耗时(秒)'));
    if (!card) return null;
    const rows = [...card.querySelectorAll('table tbody tr.ant-table-row')].map((r) => {
      const checks = r.querySelectorAll('.ant-checkbox-input');
      const nums = [...r.querySelectorAll('.ant-input-number-input')].map((x) => x.value);
      return { checked: checks[0]?.checked || false, seconds: nums[0] ?? '', changeover: nums[1] ?? '' };
    });
    return { rows };
  });
}
async function toggleRow(page, idx) {
  return page.evaluate((idx) => {
    const card = [...document.querySelectorAll('.ant-card')].find((c) => c.textContent?.includes('单件耗时(秒)'));
    const r = card?.querySelectorAll('table tbody tr.ant-table-row')[idx];
    const cb = r?.querySelector('.ant-checkbox');
    cb?.click();
    return !!cb;
  }, idx);
}

async function main() {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('deprecated')) pageErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  // 0. 通过 API 重置产品 1 的路线为种子（3 道 turn/drill_c/thread）
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  const put0 = await apiPut(page, `/api/products/${PRODUCT_ID}/process-routes`, SEED);
  console.log('STEP0 seed PUT status=', put0.status);

  // 1. 导航设置·主数据
  await page.evaluate(() => {
    const norm = (s) => s.replace(/\s+/g, '');
    const el = [...document.querySelectorAll('.ant-menu-item, .ant-menu-title-content, [class*=menu] span')].find((x) => norm(x.textContent) === norm('设置·主数据'));
    el?.click();
  });
  await page.waitForFunction(
    () => document.body.innerText.includes('产品工序路线（决定排期工期）'),
    { timeout: 20000 },
  );
  await page.waitForFunction(
    () => document.body.innerText.includes('产品目录') && document.body.innerText.includes('AI 服务配置'),
    { timeout: 10000 },
  );
  await sleep(500);
  await page.screenshot({ path: `${outDir}/i13-1-setup.png`, fullPage: true });

  // 2. 打开产品下拉并选「ANM 1/32" 乙炔」第一条
  const opened = await pickProduct(page);
  console.log('STEP2 open select:', opened);
  await sleep(900);
  const dbg = await page.evaluate(() => {
    const dds = [...document.querySelectorAll('.ant-select-dropdown')];
    return dds.map((d) => ({
      hidden: d.classList.contains('ant-select-dropdown-hidden'),
      opts: d.querySelectorAll('.ant-select-item-option').length,
    }));
  });
  console.log('STEP2 dropdowns:', JSON.stringify(dbg));
  const opt = await chooseFirstProductOption(page, 'ANM 1/32" 乙炔');
  console.log('STEP2 chose option:', opt);
  await page.waitForFunction(
    () => {
      const cards = [...document.querySelectorAll('.ant-card')];
      return cards.some((c) => c.textContent?.includes('单件耗时(秒)')
        && c.querySelectorAll('table tbody tr.ant-table-row').length > 0);
    },
    { timeout: 10000 },
  );
  await sleep(500);
  const s2 = await snapshotEditor(page);
  const checkedCount2 = s2.rows.filter((r) => r.checked).length;
  console.log('STEP2 editor rows=', s2.rows.length, '| checked=', checkedCount2);
  await page.screenshot({ path: `${outDir}/i13-2-loaded.png`, fullPage: true });

  // 3. 套用字典模板 → 全勾选 → 保存
  const t3 = await clickText(page, '套用字典模板（全勾选）');
  console.log('STEP3 套用模板 clicked=', t3);
  await sleep(500);
  const s3a = await snapshotEditor(page);
  const checkedAll = s3a.rows.every((r) => r.checked);
  console.log('STEP3 套用模板全勾:', checkedAll ? 'OK' : 'FAIL', `(rows=${s3a.rows.length}, checked=${s3a.rows.filter(r=>r.checked).length})`);
  const t3b = await clickText(page, '保存路线');
  console.log('STEP3 保存 clicked=', t3b);
  await page.waitForFunction(
    () => document.body.innerText.includes('已保存') && /已保存 \d+ 道工序路线/.test(document.body.innerText),
    { timeout: 10000 },
  ).catch(() => {});
  await sleep(500);
  const g3 = await apiGet(page, `/api/products/${PRODUCT_ID}/process-routes`);
  console.log('STEP3 保存后端条数:', g3.length, g3.length === s3a.rows.length ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/i13-3-template-saved.png`, fullPage: true });

  // 4. 刷新页面 → 再次选同一产品 → 全部仍勾选
  await page.reload({ waitUntil: 'networkidle2' });
  // reload 后若不在设置页（AntD 默认记忆路由），点回菜单
  const stillSetup = await page.evaluate(() => document.body.innerText.includes('产品工序路线（决定排期工期）'));
  if (!stillSetup) {
    await page.evaluate(() => {
      const norm = (s) => s.replace(/\s+/g, '');
      const el = [...document.querySelectorAll('.ant-menu-item, .ant-menu-title-content, [class*=menu] span')].find((x) => norm(x.textContent) === norm('设置·主数据'));
      el?.click();
    });
  }
  await page.waitForFunction(
    () => document.body.innerText.includes('产品工序路线（决定排期工期）'),
    { timeout: 20000 },
  );
  await sleep(400);
  await pickProduct(page);
  await sleep(900);
  await chooseFirstProductOption(page, 'ANM 1/32" 乙炔');
  await page.waitForFunction(
    () => {
      const cards = [...document.querySelectorAll('.ant-card')];
      return cards.some((c) => c.textContent?.includes('单件耗时(秒)')
        && c.querySelectorAll('table tbody tr.ant-table-row').length > 0);
    },
    { timeout: 10000 },
  );
  await sleep(600);
  const s4 = await snapshotEditor(page);
  const checkedCount4 = s4.rows.filter((r) => r.checked).length;
  console.log('STEP4 刷新后仍全勾:', checkedCount4 === s4.rows.length ? 'OK' : `FAIL(${checkedCount4}/${s4.rows.length})`);
  await page.screenshot({ path: `${outDir}/i13-4-reload.png`, fullPage: true });

  // 5. 全部清空 → 保存 → 后端条数 0
  await clickText(page, '全部清空');
  await sleep(400);
  await clickText(page, '保存路线');
  await sleep(900);
  const g5 = await apiGet(page, `/api/products/${PRODUCT_ID}/process-routes`);
  console.log('STEP5 清空保存:', g5.length === 0 ? 'OK' : `FAIL(${g5.length})`);

  // 6. 还原为种子便于后续回归
  await apiPut(page, `/api/products/${PRODUCT_ID}/process-routes`, SEED);

  console.log('=== PAGE ERRORS ===', pageErrors.length ? pageErrors.join('\n') : '(none)');
  await browser.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });