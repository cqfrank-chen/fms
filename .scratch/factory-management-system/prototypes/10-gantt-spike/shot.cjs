// I10 取证脚本 v2：headless Edge → 逐 Tab 截图 + 真实鼠标拖拽验证回调
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = process.argv[2] || 'http://localhost:5199/';
const outDir = process.argv[3] || './shots';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1560, height: 1000, deviceScaleFactor: 1.5 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('deprecated')) pageErrors.push(m.text()); });

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('[role=tab]', { timeout: 30000 });
  await sleep(1000);
  fs.mkdirSync(outDir, { recursive: true });

  const clickTab = async (substr) => {
    const ok = await page.evaluate((s) => {
      const el = [...document.querySelectorAll('[role=tab]')].find((x) => x.textContent.includes(s));
      if (el) { el.click(); return true; }
      return false;
    }, substr);
    await sleep(substr.includes('dhtmlx') ? 1500 : 900);
    return ok;
  };
  const visiblePane = async () =>
    page.evaluate(() => {
      const ps = [...document.querySelectorAll('[role=tabpanel]')];
      return (ps.find((el) => el.offsetParent !== null) || ps[0])?.id ?? null;
    });

  const results = {};

  // ---- 截图 ----
  const shots = {};
  for (const [key, label] of [['lane', '目标形态'], ['frappe', 'frappe-gantt'], ['dhtmlx', 'dhtmlx-gantt']]) {
    await clickTab(label);
    await sleep(600);
    const pane = await visiblePane();
    const f = `${outDir}/${key}.png`;
    await page.screenshot({ path: f });
    shots[key] = { pane, file: f };
  }

  const logText = () =>
    page.evaluate(() => {
      const pane = [...document.querySelectorAll('[role=tabpanel]')].find((el) => el.offsetParent !== null) || document.querySelector('[role=tabpanel]');
      const el = pane && pane.querySelector('[data-cb-log]');
      return el ? el.textContent.trim() : '(no log el)';
    });
  const laneLog = () =>
    page.evaluate(() => {
      const w = window;
      return (w.__laneLog || []).join(' | ');
    });

  // ---- ① 泳道自研：真实鼠标拖第一条蓝条（+3 天 ≈ 276px） ----
  await clickTab('目标形态');
  await sleep(600);
  {
    const bar = await page.evaluate(() => {
      const pane = [...document.querySelectorAll('[role=tabpanel]')].find((el) => el.offsetParent !== null) || document.querySelector('[role=tabpanel]');
      // 取"待办蓝条"（rgb(22,119,255)）；已完成绿条不可拖
      const el = [...pane.querySelectorAll('div')].find((d) => getComputedStyle(d).cursor === 'grab' && d.childElementCount === 0 && d.textContent.trim() && getComputedStyle(d).backgroundColor === 'rgb(22, 119, 255)');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (bar) {
      await page.mouse.move(bar.x, bar.y);
      await page.mouse.down();
      await page.mouse.move(bar.x + 276, bar.y, { steps: 15 });
      await page.mouse.up();
      await sleep(600);
      const txt = await laneLog();
      results.lane_drag = txt.includes('onDateChange') ? 'PASS(' + txt.slice(0, 60) + ')' : 'FAIL(' + txt + ')';
    } else results.lane_drag = 'NO_BAR';
  }

  // ---- ② frappe-gantt：真实鼠标拖任务条（+2 列） ----
  await clickTab('frappe-gantt');
  await sleep(1000);
  {
    const bar = await page.evaluate(() => {
      const pane = [...document.querySelectorAll('[role=tabpanel]')].find((el) => el.offsetParent !== null) || document.querySelector('[role=tabpanel]');
      const el = pane.querySelector('.bar-wrapper .bar');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (bar) {
      await page.mouse.move(bar.x, bar.y);
      await page.mouse.down();
      await page.mouse.move(bar.x + 100, bar.y, { steps: 10 });
      await page.mouse.up();
      await sleep(600);
      const txt = await logText();
      results.frappe_drag = txt.includes('开始 ') && txt.includes('→') ? 'PASS(' + txt.slice(0, 70) + ')' : 'FAIL(' + txt + ')';
    } else results.frappe_drag = 'NO_BAR';
    await page.screenshot({ path: `${outDir}/frappe-after-drag.png` });
  }

  // ---- ③ dhtmlx-gantt：真实鼠标拖任务条 ----
  await clickTab('dhtmlx-gantt');
  await sleep(1200);
  {
    const bar = await page.evaluate(() => {
      const pane = [...document.querySelectorAll('[role=tabpanel]')].find((el) => el.offsetParent !== null) || document.querySelector('[role=tabpanel]');
      // dhtmlx v10：条集中渲染于 gantt_bars_area，按 y 序与左侧网格行序对齐
      const rows = [...pane.querySelectorAll('.gantt_row')];
      const i = rows.findIndex((r) => r.textContent.includes('·行2'));
      if (i === -1) return null;
      const lines = [...pane.querySelectorAll('.gantt_bars_area .gantt_task_line')].sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
      const el = lines[i];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (bar) {
      await page.mouse.move(bar.x, bar.y);
      await page.mouse.down();
      await page.mouse.move(bar.x + 140, bar.y, { steps: 10 });
      await page.mouse.up();
      await sleep(700);
      const txt = await logText();
      results.dhtmlx_drag = txt.includes('新开始') ? 'PASS(' + txt.slice(0, 70) + ')' : 'FAIL(' + txt + ')';
    } else results.dhtmlx_drag = 'NO_BAR';
    await page.screenshot({ path: `${outDir}/dhtmlx-after-drag.png` });
  }

  console.log('=== SHOTS ==='); console.log(JSON.stringify(shots, null, 2));
  console.log('=== DRAG RESULTS ==='); console.log(JSON.stringify(results, null, 2));
  console.log('=== PAGE ERRORS ==='); console.log(pageErrors.length ? pageErrors.join('\n') : '(none)');
  await browser.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
