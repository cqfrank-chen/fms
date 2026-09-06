/**
 * 回归：报工按工序推进（I06 整批逐道）
 *   计划单页：confirmed 行「报工」→ 弹窗显示当前工序 + 整批数量固定 →
 *   提交后推进到下一道（消息提示）；计划单转生产中
 *   排程看板：任务随推进换到下一道泳道（wcKey），颜色转黄，简介显示工序
 * 用法：node repro-i06-route-report.cjs <baseUrl> <outDir>
 * 前置：存在一张 confirmed 计划单（默认 PS-20260906-05，可 env PLAN_NO 覆盖），其行已预排期到当前工序泳道
 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const [, , baseUrl = 'http://localhost/', outDir = __dirname + '/shots-i06-route'] = process.argv;
const planNo = process.env.PLAN_NO || 'PS-20260906-05';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickMenu(page, text) {
  return page.evaluate((t) => {
    const norm = (s) => s.replace(/\s+/g, '');
    const el = [...document.querySelectorAll('.ant-menu-item, .ant-menu-title-content, [class*=menu] span')]
      .find((x) => norm(x.textContent || '') === norm(t) && x.offsetParent !== null);
    el?.click();
    return !!el;
  }, text);
}
async function clickBtn(page, label) {
  return page.evaluate((label) => {
    const norm = (s) => s.replace(/\s+/g, '');
    const b = [...document.querySelectorAll('button')].find((x) => norm(x.textContent) === norm(label) && x.offsetParent !== null);
    b?.click();
    return !!b;
  }, label);
}
const hasText = (page, t) => page.evaluate((t) => document.body.innerText.includes(t), t);

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1560, height: 1100 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  // 1. 计划单页 → 目标行「报工」
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(600);
  await clickMenu(page, '计划单');
  await sleep(900);
  const s1a = await hasText(page, planNo);
  await page.evaluate((planNo) => {
    const norm = (s) => s.replace(/\s+/g, '');
    const row = [...document.querySelectorAll('.ant-table-tbody .ant-table-row')]
      .find((r) => r.textContent.includes(planNo));
    const btn = [...row.querySelectorAll('button')].find((b) => norm(b.textContent) === '报工');
    btn?.click();
  }, planNo);
  await sleep(700);
  // 弹窗默认选第一行？—— 手动选择该行（options 里含 工序 车削外形（1/3））
  const opt = await page.evaluate(() => {
    const sel = document.querySelector('.ant-modal .ant-select');
    sel?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return !!sel;
  });
  await sleep(500);
  const optClick = await page.evaluate(() => {
    const norm = (s) => s.replace(/\s+/g, '');
    const it = [...document.querySelectorAll('.ant-select-item-option')]
      .find((x) => norm(x.textContent || '').includes('车削外形') || norm(x.textContent || '').includes('成品直报'));
    if (!it) return false;
    it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    it.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    it.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  });
  await sleep(600);
  const s1b = await hasText(page, '当前工序「车削外形」（1/3）');
  const qtyDisabled = await page.evaluate(() => {
    const n = document.querySelector('.ant-modal .ant-input-number-input');
    return !!(n && n.disabled);
  });
  const qtyVal = await page.evaluate(() => {
    const n = document.querySelector('.ant-modal .ant-input-number-input');
    return n?.value ?? null;
  });
  console.log('STEP1 报工弹窗: 单存在:', s1a ? 'OK' : 'FAIL', '| 选择行含工序:', opt && optClick ? 'OK' : 'FAIL',
    '| 当前工序提示:', s1b ? 'OK' : 'FAIL', '| 数量整批固定:', qtyDisabled ? 'OK' : 'FAIL', '| 值=', qtyVal);
  await page.screenshot({ path: `${outDir}/r1-modal.png`, fullPage: true });

  // 2. 提交报工 → 推进到下一道
  await clickBtn(page, '提交报工');
  await page.waitForFunction(() => document.body.innerText.includes('已推进到下一道工序'), { timeout: 10000 }).catch(() => {});
  await sleep(900);
  const s2a = await hasText(page, '已推进到下一道工序');
  const s2b = await hasText(page, '钻中心孔');
  const s2c = await hasText(page, '2/3');
  console.log('STEP2 报工推进: 消息:', s2a ? 'OK' : 'FAIL', '| 出现下一道钻中心孔:', s2b ? 'OK' : 'FAIL', '| 进度 2/3:', s2c ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/r2-advanced.png`, fullPage: true });

  // 3. 排程看板：任务仍在池（生产中被保留）且随推进换泳道（barLabel 显示 [钻中心孔 2/3]）
  await clickMenu(page, '排程');
  await sleep(1200);
  const s3a = await hasText(page, planNo); // 甘特块或待排
  const s3b = await hasText(page, '[钻中心孔 2/3]'); // 甘特块 label：已推进到第 2 道
  console.log('STEP3 看板推进: 任务可见:', s3a ? 'OK' : 'FAIL', '| 块工序标注[钻中心孔 2/3]:', s3b ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/r3-board.png`, fullPage: true });

  console.log('=== PAGE ERRORS ===', pageErrors.length ? pageErrors.join('\n') : '(none)');
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
