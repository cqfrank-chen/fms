/**
 * 验证：排程看板下方图例（底色/描边含义提示）
 *   1. 顶部不再显示旧文字提示
 *   2. 甘特看板下方出现图例条（含 蓝/黄/绿 底、红框、紫虚线框 五项）
 * 用法：node verify-legend.cjs <baseUrl> <outDir>
 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const [, , baseUrl = 'http://localhost/', outDir = __dirname + '/shots-legend'] = process.argv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.replace(/\s+/g, '');

async function clickMenu(page, text) {
  return page.evaluate((t) => {
    const norm = (s) => s.replace(/\s+/g, '');
    const el = [...document.querySelectorAll('.ant-menu-item, .ant-menu-title-content, [class*=menu] span')]
      .find((x) => norm(x.textContent || '') === norm(t) && x.offsetParent !== null);
    el?.click();
    return !!el;
  }, text);
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1560, height: 1100 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(600);
  await clickMenu(page, '排程');
  await sleep(1600);

  const bodyText = await page.evaluate(() => document.body.innerText);
  const keys = ['蓝底=已排未动（待开工）', '黄底=进行中', '绿底=成品已报齐', '红框=预计超期', '紫虚线框=工期人工指定'];
  const sAll = keys.every((k) => norm(bodyText).includes(norm(k)))
    ? 'OK' : 'FAIL(缺: ' + keys.filter((k) => !norm(bodyText).includes(norm(k))).join(',') + ')';

  // 旧顶部文字不应再出现
  const sOld = bodyText.includes('蓝=待办') ? 'FAIL(旧顶部提示仍在)' : 'OK(旧提示已移除)';

  // 定位图例容器：滚动到最底部
  await page.evaluate(() => {
    const divs = [...document.querySelectorAll('div')];
    const legend = divs.find((d) => (d.textContent || '').includes('蓝底=已排未动') && (d.textContent || '').includes('紫虚线框'));
    legend?.scrollIntoView({ block: 'center' });
    return !!legend;
  });
  await sleep(400);

  // 图例条几何：应在甘特（最大滚动容器）下方
  const geo = await page.evaluate(() => {
    const isLeg = (d) => {
      const t = (d.textContent || '').trim();
      return t.startsWith('蓝底=已排未动') && t.includes('紫虚线框');
    };
    const legend = [...document.querySelectorAll('div')].filter((d) => {
      const t = (d.textContent || '').trim();
      return isLeg(d) && [...d.children].every((c) => isLeg(c) || (c.textContent || '').includes('蓝底'));
    }).sort((a, b) => (b.textContent || '').length - (a.textContent || '').length)[0];
    if (!legend) return null;
    const r = legend.getBoundingClientRect();
    const colorSwatches = [...legend.querySelectorAll('span')].filter((s) => {
      const st = s.getAttribute('style') || '';
      return (st.includes('background: rgb') || st.includes('outline')) && (st.includes('width: 18px') || st.includes('width:18px'));
    }).map((s) => {
      const st = s.getAttribute('style') || '';
      return { bg: (st.match(/background:\s*(rgb[^;]+)/) || [])[1] || '', outline: (st.match(/outline:\s*([^;]+)/) || [])[1] || '', shadow: (st.match(/box-shadow:\s*([^;]+)/) || [])[1] || '' };
    });
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), swatches: colorSwatches.length };
  });
  console.log(`LEGEND 图例条: ${sAll}`);
  console.log(`LEGEND 色样数量: ${geo ? geo.swatches + '（期望 5）' : 'FAIL: 未定位到图例条'}`);
  console.log(`LEGEND 旧提示: ${sOld}`);
  await page.screenshot({ path: `${outDir}/legend-bottom.png`, fullPage: false });

  console.log('---console errors---');
  console.log(pageErrors.length ? pageErrors.join('\n') : '(none)');
  const ok = sAll === 'OK' && sOld.startsWith('OK') && geo && geo.swatches === 5;
  console.log(ok ? 'ALL-OK' : 'HAS-FAIL');
  await browser.close();
})();
