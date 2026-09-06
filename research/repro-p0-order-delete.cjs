/**
 * 回归：P0 修复验证（API 级全链路 + UI 按钮渲染检查）
 *   A1 后端：草稿订单 DELETE 200 + 随后 GET 404（api() 空 body 修复后 UI 删除链路同样受益）
 *   A2 后端：驳回（带 voided 计划单）的订单 DELETE 200 + voided 计划单级联清理（不再 FK 报错）
 *   UI :   draft 行「删除」按钮渲染（PoPconfirm 防呆入口就位）
 *   C :    AI 学习反馈积压：localStorage 预置 → 进入订单页自动补传 → /ai/feedback 新增记录
 * 用法：node repro-p0-order-delete.cjs <baseUrl> <outDir>
 * 说明：每次跑新建并删除测试单，无残留；C 的 selftest 记录需事后 SQL 清理（脚本会打印命令）。
 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const [, , baseUrl = 'http://localhost/', outDir = __dirname + '/shots-p0'] = process.argv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickMenu(page, text) {
  return page.evaluate((t) => {
    const n = (s) => s.replace(/\s+/g, '');
    const el = [...document.querySelectorAll('.ant-menu-item, .ant-menu-title-content, [class*=menu] span')]
      .find((x) => n(x.textContent || '') === n(t) && x.offsetParent !== null);
    el?.click();
    return !!el;
  }, text);
}
async function clickTab(page, label) {
  return page.evaluate((label) => {
    const n = (s) => s.replace(/\s+/g, '');
    const el = [...document.querySelectorAll('.ant-tabs-tab')].find((x) => n(x.textContent) === n(label) && x.offsetParent !== null);
    el?.click();
    return !!el;
  }, label);
}

const API = (p) => baseUrl.replace(/\/$/, '') + '/api' + p;
const jget = async (p) => { const r = await fetch(API(p)); if (r.status === 404) return null; if (!r.ok) return null; return r.json(); };
const jpost = async (p, body) => {
  const r = await fetch(API(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(`POST ${p} -> HTTP ${r.status}`);
  return r.json();
};
const jdel = async (p) => {
  const r = await fetch(API(p), { method: 'DELETE' });
  return { ok: r.ok, status: r.status };
};

const mk = (tag) => ({ customerId: 1, poNo: 'P0-' + tag + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6), dueDate: '2026-12-31', lines: [{ productId: 1, quantity: 1, unitPrice: 1 }] });

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1560, height: 1100 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  // ============ STEP A1：API 级纯草稿删除 ============
  const oa = await jpost('/orders', mk('A'));
  const a1Del = await jdel('/orders/' + oa.id);
  const a1Gone = await jget('/orders/' + oa.id) === null;
  console.log(`STEP-A1 纯草稿 DELETE: status=${a1Del.status} | GET 404: ${a1Gone ? 'OK' : 'FAIL'} (${oa.orderNo})`);

  // ============ STEP A2：UI 渲染检查（删除按钮 + Popconfirm 触发按钮存在） ============
  const obBtn = await jpost('/orders', mk('A2Btn'));
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(500);
  await clickMenu(page, '订单');
  await sleep(400);
  await clickTab(page, '订单列表');
  await page.waitForFunction((po) => document.body.innerText.includes(po), { timeout: 6000 }, obBtn.poNo).catch(() => {});
  await sleep(400);
  const uiHasBtn = await page.evaluate((po) => {
    const n = (s) => s.replace(/\s+/g, '');
    const row = [...document.querySelectorAll('.ant-table-tbody .ant-table-row')]
      .find((r) => (r.textContent || '').includes(po));
    const btns = row ? [...row.querySelectorAll('button')].map((b) => n(b.textContent || '')) : [];
    return { found: !!row, btns };
  }, obBtn.poNo);
  await page.screenshot({ path: `${outDir}/a2-ui-draft-row.png`, fullPage: false });
  const a2Ok = uiHasBtn.found && uiHasBtn.btns.includes('删除');
  console.log(`STEP-A2 UI 渲染：行存在=${uiHasBtn.found ? 'OK' : 'FAIL'} | 含「删除」: ${a2Ok ? 'OK' : 'FAIL'} | 操作按钮: ${uiHasBtn.btns.join(',')}`);

  // ============ STEP B：API 级驳回后订单删除（含 voided 计划单级联清理） ============
  const ob = await jpost('/orders', mk('B'));
  const planB = await jpost('/orders/' + ob.id + '/confirm', {});
  await jpost('/plan-sheets/' + planB.id + '/reject', {});
  const bDel = await jdel('/orders/' + ob.id);
  const bGone = await jget('/orders/' + ob.id) === null;
  const plans = await jget('/plan-sheets?status=voided') || [];
  const planGone = !plans.some((p) => p.planNo === planB.planNo);
  console.log(`STEP-B 驳回后删除: DELETE status=${bDel.status} | 订单404: ${bGone ? 'OK' : 'FAIL'} | voided计划单级联清理: ${planGone ? 'OK' : 'FAIL'} (${planB.planNo})`);

  // 清理 STEP-A2 测试单
  await jdel('/orders/' + obBtn.id);

  // ============ STEP C：AI 学习反馈积压自动补传 ============
  const selfNote = 'p0-flush-' + Date.now();
  await page.evaluate((note) => {
    localStorage.setItem('fms_ai_feedback_queue', JSON.stringify([
      { payload: { source: 'selftest', parsed: { note }, corrected: { note } }, ts: Date.now() },
    ]));
  }, selfNote);
  await clickMenu(page, '首页');
  await sleep(400);
  await clickMenu(page, '订单');
  await sleep(1500);
  const fb = await jget('/ai/feedback');
  const flushed = fb && fb.rows && fb.rows.some((r) => r.parsed && r.parsed.note === selfNote);
  const queueEmpty = await page.evaluate(() => JSON.parse(localStorage.getItem('fms_ai_feedback_queue') || '[]').length === 0);
  console.log(`STEP-C 反馈积压补传: 新增记录=${flushed ? 'OK' : 'FAIL'} | 队列清空=${queueEmpty ? 'OK' : 'FAIL'}`);
  console.log('清理SQL: docker exec fms-postgres psql -U fms -d fms -c "DELETE FROM ai_parse_feedback WHERE parsed->>\'note\' LIKE \'p0-flush-%\';"');

  console.log('---console errors---');
  console.log(pageErrors.length ? pageErrors.join('\n') : '(none)');
  const fails = [a1Gone, a2Ok, bGone, planGone, flushed, queueEmpty].filter((x) => !x).length;
  console.log(fails === 0 ? 'ALL-OK' : `HAS-FAIL(${fails})`);
  await browser.close();
})();