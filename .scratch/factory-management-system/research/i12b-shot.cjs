// I12 增强验收：设置页 AI 服务配置卡截图 + DOM 断言
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'D:/futures/factory-management-system/.scratch/factory-management-system/research/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setViewport({ width: 1500, height: 1100 });
    await page.goto('http://localhost/', { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(800);
    await page.evaluate(() => { const mi = [...document.querySelectorAll('.ant-menu li[role=menuitem]')].find((x) => x.textContent.includes('设置')); if (mi) mi.click(); });
    await sleep(1800);
    // 滚到 AI 服务配置卡
    await page.evaluate(() => {
      const h = [...document.querySelectorAll('.ant-card-head-title, .ant-card .ant-typography strong')].find((x) => x.textContent.includes('AI 服务配置'));
      if (h) h.scrollIntoView({ block: 'start' });
    });
    await sleep(600);
    // DOM 断言
    const info = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.ant-card')];
      const aiCard = cards.find((c) => (c.textContent || '').includes('AI 服务配置'));
      if (!aiCard) return { found: false };
      const t = aiCard.textContent || '';
      return {
        found: true,
        hasDialogTag: t.includes('对话未配置') || t.includes('对话已配置'),
        hasVisionTag: t.includes('识图未配置') || t.includes('识图已配置'),
        hasKeyInputs: aiCard.querySelectorAll('input[type=password]').length,
        hasTestButtons: (t.match(/测试.*连接/g) || []).length,
        hasSaveBtn: t.includes('保存 AI 配置'),
      };
    });
    console.log('ASSERT:', JSON.stringify(info));
    await page.screenshot({ path: OUT + 'i12b-ai-config.png', fullPage: false });
    console.log('SHOT_OK');
    console.log('CONSOLE_ERRORS:', errors.length);
  } finally { await browser.close(); }
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
