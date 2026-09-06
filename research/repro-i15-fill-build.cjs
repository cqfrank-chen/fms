/**
 * 回归：AI 识别结果填入新建订单 + 未建档快速建档 + 保存检测（新链路）
 * 步骤：设置页?不 —— 直接订单页；window.__fillAI 模拟「AI 复核确认填入」：
 *   未建档客户文本 + 未建档产品文本 + 已建档产品行
 *   → 断言表单预填/待建档卡/保存拦截 → 客户/产品快速建档自动回填 → 保存成功 → 清理
 * 用法：node repro-i15-fill-build.cjs <baseUrl> <outDir>
 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const [, , baseUrl = 'http://localhost/', outDir = __dirname + '/shots-i15'] = process.argv;
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
const formVal = (page) => page.evaluate(() => window.__orderForm?.getFieldsValue?.());

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1560, height: 1100 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  // 0. 已知数据（页面导航后取）
  let seed = { firstProductId: null, productsCount: 0 };

  // 1. 订单页
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  seed = await page.evaluate(async () => {
    const ps = await (await fetch('/api/products')).json();
    return { firstProductId: ps[0]?.id ?? null, productsCount: ps.length };
  });
  await sleep(600);
  await clickMenu(page, '订单');
  await page.waitForFunction(() => document.body.innerText.includes('📷 AI 导入订单'), { timeout: 20000 });
  await sleep(400);
  console.log('STEP1 订单页就绪 OK');
  await page.screenshot({ path: `${outDir}/i15-1-orders.png` });

  // 2. 模拟 AI 确认填入（含 1 未建档客户 + 1 未建档产品 + 1 已建档产品行）
  const fill = await page.evaluate(async (firstProductId) => {
    const w = window;
    if (typeof w.__fillAI !== 'function') return { ok: false, reason: '__fillAI missing' };
    w.__fillAI({
      customerId: undefined,
      customerText: 'AI 新客户回归',
      poNo: 'PO-AI-REGRESS',
      dueDate: '2026-10-20',
      note: '回归测试订单（将被清理）',
      lines: [
        { productId: undefined, productName: 'ANM 新品 X9', quantity: 1200, unitPrice: 4.2, currency: 'RMB', engraving: 'LOGO-9' },
        { productId: firstProductId, productName: undefined, quantity: 2000, unitPrice: 3.5, currency: 'USD' },
      ],
      result: { directPass: false, confidence: 'low', notes: [], issues: [] },
    });
    return { ok: true };
  }, seed.firstProductId);
  console.log('STEP2 模拟填入:', fill.ok ? 'OK' : 'FAIL ' + fill.reason);
  await sleep(700);

  const v2 = await formVal(page);
  const f2 = v2 && {
    customerId: v2.customerId ?? null,
    poNo: v2.poNo,
    lineCount: v2.lines?.length,
    l0: v2.lines?.[0] && { qty: v2.lines[0].quantity, price: v2.lines[0].unitPrice, name: v2.lines[0].productName, pid: v2.lines[0].productId ?? null },
    l1: v2.lines?.[1] && { pid: v2.lines[1].productId, qty: v2.lines[1].quantity },
  };
  const b2a = await hasText(page, 'AI 新客户回归');
  const b2b = await hasText(page, 'ANM 新品 X9');
  const b2c = await clickBtn(page, '快速客户建档');
  const b2d = await hasText(page, '保存订单（草稿）');
  console.log('STEP3 表单预填:', f2 ? JSON.stringify(f2) : 'EMPTY',
    '| 客户建档按钮:', b2c ? 'OK' : 'FAIL', '| 文案出现:', b2a && b2b ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/i15-2-filled.png`, fullPage: true });

  // 3. 未建档时点保存 → 应被检测拦截（不创建订单）
  await clickBtn(page, '保存订单（草稿）');
  await page.waitForFunction(() => document.body.innerText.includes('未建档或未选择'), { timeout: 6000 }).catch(() => {});
  await sleep(500);
  const blocked = await hasText(page, '仍有 1 个产品行未建档');
  console.log('STEP4 保存检测拦截:', blocked ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/i15-3-blocked.png`, fullPage: true });

  // 4. 快速客户建档（Modal 预填识别名 → 建档并选用）
  await clickBtn(page, '快速客户建档');
  await sleep(500);
  const custNameInModal = await page.evaluate(() => {
    const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
    const inp = m?.querySelector('input');
    return inp?.value ?? '';
  });
  await clickBtn(page, '建档并选用');
  await page.waitForFunction(() => document.body.innerText.includes('已建档并自动选用'), { timeout: 8000 }).catch(() => {});
  await sleep(500);
  const v4 = await formVal(page);
  const custLinked = !!v4?.customerId;
  const custGone = !(await hasText(page, '快速客户建档'));
  console.log('STEP5 客户建档:', 'Modal 预填=', custNameInModal, '| 自动选用 customerId=', v4?.customerId, custLinked ? 'OK' : 'FAIL', '| 提示消失:', custGone ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/i15-4-cust.png`, fullPage: true });

  // 5. 快速产品建档（名称只读=识别名 → 加入目录 → 行自动回填 productId）
  await clickBtn(page, '加入产品目录');
  await sleep(500);
  const prodNameInModal = await page.evaluate(() => {
    const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
    return m?.querySelector('input')?.value ?? '';
  });
  await clickBtn(page, '加入目录并填入行');
  await page.waitForFunction(() => document.body.innerText.includes('已加入目录并填入行'), { timeout: 8000 }).catch(() => {});
  await sleep(600);
  const v5 = await formVal(page);
  const line0Pid = v5?.lines?.[0]?.productId;
  const line0NameGone = !(v5?.lines?.[0]?.productName);
  const cardGone = !(await hasText(page, 'AI 识别出'));
  console.log('STEP6 产品建档: Modal 名称=', prodNameInModal, '| 行0 productId=', line0Pid, line0Pid ? 'OK' : 'FAIL',
    '| 卡片消失:', cardGone ? 'OK' : 'FAIL', '| name 清空:', line0NameGone ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/i15-5-prod.png`, fullPage: true });

  // 6. 保存订单
  await clickBtn(page, '保存订单（草稿）');
  await page.waitForFunction(() => document.body.innerText.includes('订单已保存为草稿'), { timeout: 10000 }).catch(() => {});
  await sleep(700);
  const saved = await hasText(page, '订单已保存为草稿');
  const formCleared = await page.evaluate(() => {
    const v = window.__orderForm?.getFieldsValue?.();
    return !v?.customerId && !v?.lines?.some?.((l) => l.productId);
  });
  console.log('STEP7 保存成功:', saved ? 'OK' : 'FAIL', '| 表单已复位:', formCleared ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/i15-6-saved.png`, fullPage: true });

  // 7. 清理：找到刚建的客户/产品/订单并删除
  const clean = await page.evaluate(async () => {
    const out = {};
    try {
      // 顺序关键：先删订单（连带 order_lines），再删被其引用的客户/产品
      const orders = await (await fetch('/api/orders')).json();
      const ord = (Array.isArray(orders) ? orders : []).find((o) => o.poNo === 'PO-AI-REGRESS');
      if (ord) { out.orderId = ord.id; await fetch('/api/orders/' + ord.id, { method: 'DELETE' }); }
      const custs = await (await fetch('/api/customers')).json();
      const cust = custs.find((c) => c.name === 'AI 新客户回归');
      if (cust) { out.custId = cust.id; await fetch('/api/customers/' + cust.id, { method: 'DELETE' }); }
      const prods = await (await fetch('/api/products')).json();
      const prod = prods.find((p) => p.name === 'ANM 新品 X9');
      if (prod) { out.prodId = prod.id; await fetch('/api/products/' + prod.id, { method: 'DELETE' }); }
    } catch (e) { out.err = String(e); }
    return out;
  });
  console.log('STEP8 清理:', JSON.stringify(clean));

  console.log('=== PAGE ERRORS ===', pageErrors.length ? pageErrors.join('\n') : '(none)');
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
