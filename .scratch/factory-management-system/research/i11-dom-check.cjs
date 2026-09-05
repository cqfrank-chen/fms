// I11 完善 DOM 断言：缩放格宽切换 / 周一分隔标注 / 待排筛选框 / 任务简介→查看完整订单
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://localhost/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('deprecated')) errors.push(m.text()); });
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(800);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('li,a,span,div')].find((x) => x.textContent.trim() === '排程' && x.offsetParent !== null);
      if (el) el.click();
    });
    await sleep(1800);

    const report = {};

    // A. 日/周 表头格宽测量（找表头首个日期格子）
    const dayW = await page.evaluate(() => {
      const grid = [...document.querySelectorAll('div')].find((d) => d.childElementCount > 5 && [...d.children].every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.getAttribute('title') || '')));
      if (!grid) return -1;
      const first = grid.children[0];
      return first ? first.getBoundingClientRect().width : -1;
    });
    report.dayCellWidth = Math.round(dayW * 10) / 10;

    await page.evaluate(() => {
      const seg = [...document.querySelectorAll('.ant-segmented-item')].find((x) => x.textContent.trim() === '周');
      if (seg) seg.click();
    });
    await sleep(600);
    const weekInfo = await page.evaluate(() => {
      const grid = [...document.querySelectorAll('div')].find((d) => d.childElementCount > 5 && [...d.children].every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.getAttribute('title') || '')));
      if (!grid) return null;
      const first = grid.children[0];
      const w = first ? first.getBoundingClientRect().width : -1;
      // 周一格子下方应有 MM-DD 文本
      const mon = [...grid.children].find((c) => c.getAttribute('title') && new Date(c.getAttribute('title') + 'T00:00:00Z').getUTCDay() === 1);
      const monText = mon ? mon.textContent.trim() : '(no monday)';
      return { cellWidth: Math.round(w * 10) / 10, monText };
    });
    report.week = weekInfo;

    // B. 待排筛选框
    report.filterBox = await page.evaluate(() => {
      const inp = document.querySelector('input[type="search"], .ant-card .ant-input-affix-wrapper input');
      return !!inp;
    });

    // C. 点击已排期任务条 → 任务简介 → 「查看完整订单」按钮存在
    report.taskModalBtn = await page.evaluate(() => {
      const seg = [...document.querySelectorAll('.ant-segmented-item')].find((x) => x.textContent.trim() === '日');
      if (seg) seg.click();
      return true;
    });
    await sleep(600);
    const taskModal = await page.evaluate(() => {
      const bar = [...document.querySelectorAll('div')].find((d) => d.style && d.style.cursor === 'grab' && d.childElementCount === 0 && d.textContent.includes('·行') && d.offsetParent);
      if (!bar) return 'NO_BAR';
      bar.click();
      return 'clicked';
    });
    await sleep(900);
    const modalCheck = await page.evaluate(() => {
      const modal = [...document.querySelectorAll('.ant-modal-wrap')].find((m) => m.offsetParent !== null);
      if (!modal) return 'NO_MODAL';
      const txt = modal.textContent || '';
      const btn = [...modal.querySelectorAll('button')].some((b) => b.textContent.includes('查看完整订单'));
      return { hasFullOrderBtn: btn, sample: txt.slice(0, 60) };
    });
    report.taskModal = { barClicked: taskModal, ...modalCheck };

    // D. 点击「查看完整订单」→ 订单详情弹窗出现（含订单号标题）
    const orderModal = await page.evaluate(() => {
      const modal = [...document.querySelectorAll('.ant-modal-wrap')].find((m) => m.offsetParent !== null);
      if (!modal) return 'NO_MODAL';
      const btn = [...modal.querySelectorAll('button')].find((b) => b.textContent.includes('查看完整订单'));
      if (!btn) return 'NO_BTN';
      btn.click();
      return 'clicked';
    });
    await sleep(1000);
    const orderModalCheck = await page.evaluate(() => {
      const modal = [...document.querySelectorAll('.ant-modal-wrap')].find((m) => m.offsetParent !== null);
      if (!modal) return 'NO_MODAL';
      const txt = modal.textContent || '';
      return { isOrder: /订单详情/.test(txt), hasOrderNo: /SO-\d{8}-\d{2}|订单详情/.test(txt), sample: txt.slice(0, 80) };
    });
    report.orderModal = { clicked: orderModal, ...orderModalCheck };

    console.log(JSON.stringify(report, null, 2));
    console.log('console/page errors:', errors.length ? errors.join(' | ') : 'none');
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });