// I12 UI 验收截图：AI 助手（查数对话/利润摘要）+ 预警铃铛抽屉 + 订单 AI 导入入口
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = 'D:/futures/factory-management-system/.scratch/factory-management-system/research/';

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1680, height: 1000 });
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 160)));
    await page.goto('http://localhost/', { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(900);

    const nav = async (label) => {
      await page.evaluate((l) => {
        const mi = [...document.querySelectorAll('.ant-menu li[role=menuitem]')].find((x) => x.textContent.trim() === l);
        if (mi) mi.click();
      }, label);
      await sleep(1600);
    };

    // 1) AI 助手 · 查数对话（点快捷问题）
    await nav('AI 助手');
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('这个月利润怎么样') && x.offsetParent);
      if (b) b.click();
    });
    await sleep(2500);
    await page.screenshot({ path: OUT + 'i12-ai-ask.png' });

    // 2) AI 助手 · 利润月报摘要
    await page.evaluate(() => {
      const t = [...document.querySelectorAll('[role=tab]')].find((x) => x.textContent.includes('利润月报摘要'));
      if (t) t.click();
    });
    await sleep(1200);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('生成 AI 执行摘要') && x.offsetParent);
      if (b) b.click();
    });
    await sleep(2500);
    await page.screenshot({ path: OUT + 'i12-report-summary.png' });

    // 3) 预警铃铛抽屉
    await nav('首页');
    await page.evaluate(() => {
      const b = document.querySelector('button[aria-label="规则预警"]');
      if (b) b.click();
    });
    await sleep(1400);
    await page.screenshot({ path: OUT + 'i12-alerts-drawer.png' });

    // 4) 订单 · AI 导入入口
    await nav('订单');
    await page.screenshot({ path: OUT + 'i12-order-ai-import.png' });

    console.log('console errors:', errs.length ? errs.join(' || ') : 'NONE');
    console.log('screenshots done');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
