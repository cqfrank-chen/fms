/**
 * 单点验证：驳回后计划单在「全部」筛选下显示「已作废」且操作按钮消失（轨迹可见）。
 * 用库里现成 voided 计划单（默认 PS-20260906-02）验证，不改任何数据。
 * 用法：node repro-i05-voided-visible.cjs <baseUrl> <outDir> [PLAN_NO]
 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const [, , baseUrl = 'http://localhost/', outDir = __dirname + '/shots-i05-voided'] = process.argv;
const planNo = process.env.PLAN_NO || 'PS-20260906-02';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1560, height: 1100 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(600);
  await page.evaluate(() => {
    const norm = (s) => s.replace(/\s+/g, '');
    const el = [...document.querySelectorAll('.ant-menu-item, .ant-menu-title-content, [class*=menu] span')]
      .find((x) => norm(x.textContent || '') === '计划单' && x.offsetParent !== null);
    el?.click();
  });
  await sleep(900);

  const rowText = await page.evaluate((planNo) => {
    const row = [...document.querySelectorAll('.ant-table-tbody .ant-table-row')]
      .find((r) => r.textContent.includes(planNo));
    return row ? row.textContent.replace(/\s+/g, ' ') : null;
  }, planNo);
  const rowHas = (t) => !!rowText && rowText.includes(t);
  console.log('VOIDED单', planNo, '| 行存在:', !!rowText ? 'OK' : 'FAIL',
    '| 状态「已作废」:', rowHas('已作废') ? 'OK' : 'FAIL',
    '| 无「不通过」:', !rowHas('不通过') ? 'OK' : 'FAIL',
    '| 无「审核」按钮:', !rowHas('审核') ? 'OK' : 'FAIL');
  await page.screenshot({ path: `${outDir}/voided-visible.png`, fullPage: true });
  console.log('=== PAGE ERRORS ===', pageErrors.length ? pageErrors.join('\n') : '(none)');
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
