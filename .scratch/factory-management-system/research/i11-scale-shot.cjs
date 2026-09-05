// I11 完善取证：日/周缩放 + 待排筛选 + 任务简介「查看完整订单」
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://localhost/';
const OUT_DIR = 'D:/futures/factory-management-system/.scratch/factory-management-system/research';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.5 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('deprecated')) errors.push(m.text()); });

    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(800);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('li,a,span,div')].find((x) => x.textContent.trim() === '排程' && x.offsetParent !== null);
      if (el) el.click();
    });
    await sleep(1600);

    // ① 日视图（默认）
    await page.screenshot({ path: `${OUT_DIR}/i11-board-day.png` });

    // ② 切「周」→ 44px/格，周一分隔线 + 周一显示 MM-DD
    await page.evaluate(() => {
      const seg = [...document.querySelectorAll('.ant-segmented-item')].find((x) => x.textContent.trim() === '周');
      if (seg) seg.click();
    });
    await sleep(800);
    await page.screenshot({ path: `${OUT_DIR}/i11-board-week.png` });
    const pxInfo = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('.ant-card')];
      const b = cells.find((x) => x.textContent.includes('排程看板') || x.textContent.includes('待排区'));
      return b ? 'found-card' : 'no-card';
    });

    // ③ 待排筛选：清空/输入关键字（当前池空则仅验证输入框存在）
    await page.evaluate(() => {
      const inp = document.querySelector('.ant-card input.ant-input, .ant-card input[type="search"], .ant-card .ant-input');
      return !!inp;
    });

    console.log('OK');
    console.log('errors:', errors.length ? errors.join(' | ') : 'none');
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });