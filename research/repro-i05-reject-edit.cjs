/**
 * 回归：计划单「审核不通过」闭环（I05 补）
 *   计划单草稿「不通过」→ Popconfirm 驳回 → 计划单作废 + 订单退回草稿
 *   → 订单列表草稿行「编辑」→ 跳编辑模式表单预填 → 改数量/清刻字备注 → 保存修改
 *   → 自动回列表 → 重新「确认」→ 生成新计划单草稿
 * 用法：node repro-i05-reject-edit.cjs <baseUrl> <outDir>
 * 前置：存在一张草稿计划单（脚本以 PS-20260906-02 为目标，可传环境变量 PLAN_NO 覆盖）
 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const [, , baseUrl = 'http://localhost/', outDir = __dirname + '/shots-i05-reject'] = process.argv;
const targetPlan = process.env.PLAN_NO || 'PS-20260906-02';
const targetOrder = process.env.ORDER_NO || 'SO-20260906-01';
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
async function clickTab(page, label) {
  return page.evaluate((label) => {
    const norm = (s) => s.replace(/\s+/g, '');
    const el = [...document.querySelectorAll('.ant-tabs-tab')].find((x) => norm(x.textContent) === norm(label) && x.offsetParent !== null);
    el?.click();
    return !!el;
  }, label);
}
const hasText = (page, t) => page.evaluate((t) => document.body.innerText.includes(t), t);
const rowHasText = (page, rowKeyText, t) => page.evaluate(({ rowKeyText, t }) => {
  const norm = (s) => s.replace(/\s+/g, '');
  const row = [...document.querySelectorAll('.ant-table-tbody .ant-table-row')]
    .find((r) => r.textContent.includes(rowKeyText));
  return row ? norm(row.textContent).includes(norm(t)) : false;
}, { rowKeyText, t });
const formVal = (page) => page.evaluate(() => window.__orderForm?.getFieldsValue?.());

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1560, height: 1100 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  // 1. 计划单页：确认目标草稿存在 + 「不通过」按钮可见
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(600);
  await clickMenu(page, '计划单');
  await sleep(800);
  const s1a = await hasText(page, targetPlan);
  const s1b = await rowHasText(page, targetPlan, '不通过');
  const s1c = await rowHasText(page, targetPlan, '审核');
  console.log('STEP1 计划单草稿行:', targetPlan, '| 存在:', s1a ? 'OK' : 'FAIL', '| 不通过按钮:', s1b ? 'OK' : 'FAIL', '| 审核按钮:', s1c ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/s1-plans.png`, fullPage: true });

  // 2. 点「不通过」→ Popconfirm 出现 → 确认「驳回」
  await page.evaluate((planNo) => {
    const norm = (s) => s.replace(/\s+/g, '');
    const row = [...document.querySelectorAll('.ant-table-tbody .ant-table-row')]
      .find((r) => r.textContent.includes(planNo));
    const btn = [...row.querySelectorAll('button')].find((b) => norm(b.textContent) === '不通过');
    btn?.click();
  }, targetPlan);
  await sleep(600);
  const popOk = await hasText(page, '审核不通过？');
  const popDesc = await hasText(page, '退回草稿');
  await page.screenshot({ path: `${outDir}/s2-popconfirm.png` });
  await clickBtn(page, '驳回');
  await page.waitForFunction(() => document.body.innerText.includes('已驳回'), { timeout: 8000 }).catch(() => {});
  await sleep(600);
  const s2a = await hasText(page, '已驳回');
  // 计划单仍在列表（状态筛选=全部）但状态已变「已作废」、操作按钮消失——驳回轨迹可见
  const s2b = await rowHasText(page, targetPlan, '已作废');
  const s2c = !(await rowHasText(page, targetPlan, '不通过'));
  console.log('STEP2 驳回:', 'Popconfirm:', popOk && popDesc ? 'OK' : 'FAIL', '| 驳回消息:', s2a ? 'OK' : 'FAIL',
    '| 状态已作废可见:', s2b ? 'OK' : 'FAIL', '| 不再可驳回:', s2c ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/s3-rejected.png`, fullPage: true });

  // 3. 订单列表：退回草稿行出现「编辑」
  await clickMenu(page, '订单');
  await sleep(600);
  await clickTab(page, '订单列表');
  await sleep(900);
  const s3a = await rowHasText(page, targetOrder, '草稿');
  const s3b = await rowHasText(page, targetOrder, '编辑');
  console.log('STEP3 订单退回草稿:', targetOrder, '| 状态草稿:', s3a ? 'OK' : 'FAIL', '| 编辑按钮:', s3b ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/s4-order-draft.png`, fullPage: true });

  // 4. 点「编辑」→ 跳新建 Tab 进入编辑模式：标题 + 表单预填
  await page.evaluate((orderNo) => {
    const norm = (s) => s.replace(/\s+/g, '');
    const row = [...document.querySelectorAll('.ant-table-tbody .ant-table-row')]
      .find((r) => r.textContent.includes(orderNo));
    const btn = [...row.querySelectorAll('button')].find((b) => norm(b.textContent) === '编辑');
    btn?.click();
  }, targetOrder);
  await sleep(1000);
  const v4 = await formVal(page);
  const f4 = v4 && { customerId: v4.customerId ?? null, qty: v4.lines?.[0]?.quantity, eng: v4.lines?.[0]?.engraving, note: v4.note };
  const s4a = await hasText(page, `编辑订单 ${targetOrder}`);
  const s4b = await hasText(page, '保存修改');
  const s4c = !!v4?.customerId && v4.lines?.length === 1;
  console.log('STEP4 编辑预填:', '标题:', s4a ? 'OK' : 'FAIL', '| 保存修改按钮:', s4b ? 'OK' : 'FAIL', '| 预填数据:', f4 ? JSON.stringify(f4) : 'EMPTY', '| 预填有效:', s4c ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/s5-edit-mode.png`, fullPage: true });

  // 5. 修改：数量改回 100、清空刻字与备注 → 保存修改（PATCH）
  await page.evaluate(() => {
    const form = window.__orderForm;
    if (!form) return false;
    form.setFieldValue(['lines', 0, 'quantity'], 100);
    form.setFieldValue(['lines', 0, 'engraving'], '');
    form.setFieldValue('note', '');
    return true;
  });
  await sleep(400);
  await clickBtn(page, '保存修改');
  await page.waitForFunction(() => document.body.innerText.includes('已更新'), { timeout: 10000 }).catch(() => {});
  await sleep(900);
  const s5a = await hasText(page, '已更新');
  const s5b = await rowHasText(page, targetOrder, '× 100');
  console.log('STEP5 保存修改:', s5a ? 'OK' : 'FAIL', '| 回列表且数量 100:', s5b ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/s6-saved.png`, fullPage: true });

  // 6. 重新「确认」→ 生成新计划单草稿（旧作废单不挡）
  await page.evaluate((orderNo) => {
    const norm = (s) => s.replace(/\s+/g, '');
    const row = [...document.querySelectorAll('.ant-table-tbody .ant-table-row')]
      .find((r) => r.textContent.includes(orderNo));
    const btn = [...row.querySelectorAll('button')].find((b) => norm(b.textContent) === '确认');
    btn?.click();
  }, targetOrder);
  await page.waitForFunction(() => document.body.innerText.includes('已确认并生成计划单'), { timeout: 10000 }).catch(() => {});
  await sleep(800);
  const s6a = await hasText(page, '已确认并生成计划单');
  await clickMenu(page, '计划单');
  await sleep(900);
  const s6b = await hasText(page, 'PS-20260906-03');
  const s6c = await rowHasText(page, 'PS-20260906-03', '草稿');
  console.log('STEP6 重新确认:', s6a ? 'OK' : 'FAIL', '| 新计划单 PS-20260906-03 出现:', s6b ? 'OK' : 'FAIL', '| 状态草稿:', s6c ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/s7-new-plan.png`, fullPage: true });

  console.log('=== PAGE ERRORS ===', pageErrors.length ? pageErrors.join('\n') : '(none)');
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
