/**
 * 回归：排程甘特拖拽手感（选中浮起 → 拖动跟手 → 松开放下）
 *   1. 原块被拿起：原块半透明 0.35（留位）+ 浮层出现（scale 1.05 + 大阴影）
 *   2. 拖动跟手：浮层 left 跟随指针移动；落点日期提示条显示目标日；泳道落点竖线
 *   3. 松开放下：浮层落定目标日，接口保存成功后原块在新位置渲染归位
 *   4. 拖动结束后不误弹「任务详情」；普通点击（未拖动）仍可弹详情
 * 用法：node repro-i11-drag-feel.cjs <baseUrl> <outDir>
 * 前置：库中存在已排期任务（默认 PS-20260906-08，start 2026-09-08，env TASK_TEXT/START 覆盖）；
 *       脚本将该任务右移 3 天再拖回原位，结束不留数据痕迹。
 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const [, , baseUrl = 'http://localhost/', outDir = __dirname + '/shots-i11-drag'] = process.argv;
const taskText = process.env.TASK_TEXT || 'PS-20260906-08';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.replace(/\s+/g, '');
const DX = 3 * 92; // day 粒度 92px/天 × 3 天

async function clickMenu(page, text) {
  return page.evaluate((t) => {
    const norm = (s) => s.replace(/\s+/g, '');
    const el = [...document.querySelectorAll('.ant-menu-item, .ant-menu-title-content, [class*=menu] span')]
      .find((x) => norm(x.textContent || '') === norm(t) && x.offsetParent !== null);
    el?.click();
    return !!el;
  }, text);
}
const hasText = (page, t) => page.evaluate((t) => document.body.innerText.includes(t), t);

/** 定位甘特任务块，返回视口中心坐标（与探针同款：evaluate 内同步取 rect，已验证可靠） */
async function findBar(page, text) {
  return page.evaluate((text) => {
    const bars = [...document.querySelectorAll('div')].filter((d) => {
      const st = d.getAttribute('style') || '';
      const tc = (d.textContent || '').trim();
      return st.includes('position: absolute') && tc.startsWith(text);
    });
    if (!bars.length) return null;
    const el = bars[0];
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, text);
}

/** 拖动序列：down → 多步 move → up；返回每一步的状态快照 */
async function drag(page, from, to, snapshots) {
  const { x, y } = from;
  await page.mouse.move(x, y, { steps: 3 });
  await sleep(200);
  await page.mouse.down();
  await sleep(250);
  snapshots.push(await grabDragState(page, 'lift'));
  await page.mouse.move(x + DX * 0.4, y, { steps: 4 });
  await sleep(60);
  snapshots.push(await grabDragState(page, 'drag-40'));
  await page.mouse.move(to.x, y, { steps: 6 });
  await sleep(180);
  snapshots.push(await grabDragState(page, 'drag-100'));
  await page.mouse.up();
  await sleep(1400); // 等接口保存 + 列表刷新
}

async function grabDragState(page, label) {
  return page.evaluate((label) => {
    const st = (d) => d.getAttribute('style') || '';
    // 浏览器会把 rgba(22,119,255,0.30) 规范化为 rgba(22, 119, 255, 0.3) → 用前缀匹配
    const floatEl = [...document.querySelectorAll('div')].find((d) => st(d).includes('scale(1.05)'));
    const ghostEl = [...document.querySelectorAll('div')].find((d) => st(d).includes('opacity: 0.35') && st(d).includes('position: absolute'));
    const guideEl = [...document.querySelectorAll('div')].find((d) => st(d).includes('rgba(22, 119, 255') && (st(d).includes('display: block')));
    const modalTitle = document.querySelector('.ant-modal-title')?.textContent || '';
    return {
      label,
      hasFloat: !!floatEl,
      floatLeft: floatEl ? parseFloat((st(floatEl).match(/left:\s*([\d.]+)px/) || [])[1] || '0') : null,
      hasGhost: !!ghostEl,
      hasGuide: !!guideEl,
      guideLeft: guideEl ? parseFloat((st(guideEl).match(/left:\s*([\d.]+)px/) || [])[1] || '0') : null,
      tagText: (() => {
        if (!floatEl) return null;
        const kids = [...floatEl.querySelectorAll('div')];
        const tag = kids.find((k) => (st(k).includes('top: -24px')));
        return tag ? (tag.textContent || '').trim() : null;
      })(),
      detailModalOpen: modalTitle.length > 0,
      detailTitle: modalTitle,
    };
  }, label);
}

/** ISO 日期 +n 天（YYYY-MM-DD） */
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

async function fetchTask(baseUrl, text) {
  const ts = await (await fetch(baseUrl + 'api/scheduling/tasks')).json();
  const t = ts.find((x) => x.planNo === text);
  return t ? { lineId: t.lineId, startDate: t.startDate, wcKey: t.wcKey } : null;
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1560, height: 1100 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  const before = await fetchTask(baseUrl, taskText);
  if (!before || !before.startDate) {
    console.log(`SKIP: 未找到已排期任务 ${taskText}`);
    await browser.close();
    return;
  }
  console.log(`目标: ${taskText} line${before.lineId} ${before.wcKey} start=${before.startDate}（将右移 3 天再拖回）`);
  const origStart = before.startDate;
  const targetISO = addDays(origStart, 3);

  // 1. 进排程页
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(600);
  await clickMenu(page, '排程');
  await sleep(1400);

  // 2. 拿起（右移方向的目标点 = 原位置右移 DX，同 y）
  const from = await findBar(page, taskText);
  if (!from) { console.log('FAIL: 找不到任务块'); await browser.close(); return; }
  const to = { x: from.x + DX, y: from.y };
  const snapshots = [];
  await drag(page, from, to, snapshots);

  const lift = snapshots.find((s) => s.label === 'lift');
  const mid = snapshots.find((s) => s.label === 'drag-100');
  const sLift = lift?.hasFloat && lift?.hasGhost && lift?.floatLeft !== null
    ? 'OK' : `FAIL(float=${lift?.hasFloat},ghost=${lift?.hasGhost})`;
  const sFollow = mid?.hasFloat && mid.floatLeft !== null && mid.floatLeft > (lift?.floatLeft ?? 0) + 100
    ? 'OK' : `FAIL(follow=${mid?.floatLeft ?? null} vs ${lift?.floatLeft ?? null})`;
  const sGuide = !!mid?.hasGuide ? 'OK' : 'FAIL';
  const sTag = mid?.tagText === targetISO ? `OK(${mid.tagText})` : `FAIL(${mid.tagText ?? '无'})`;
  const after = await fetchTask(baseUrl, taskText);
  const detailPopped = mid?.detailModalOpen === true || await hasText(page, '任务详情');
  const sMove = after?.startDate === targetISO && !detailPopped
    ? 'OK' : `FAIL(start=${after?.startDate},误弹详情=${!!detailPopped})`;

  await page.screenshot({ path: `${outDir}/s1-lift.png`, fullPage: false });
  console.log(`STEP1 拿起浮起: ${sLift}`);
  console.log(`STEP2 拖动跟手: ${sFollow} | 落点线: ${sGuide} | 目标日期提示: ${sTag}`);
  console.log(`STEP3 松手落位: ${sMove}（保存后无详情弹窗）`);

  // 3. 拖回原位（复验一轮拖拽）
  const from2 = await findBar(page, taskText);
  const snap2 = [];
  if (from2) {
    await drag(page, from2, { x: from2.x - DX, y: from2.y }, snap2);
    const sBack = (await fetchTask(baseUrl, taskText))?.startDate === origStart ? 'OK' : 'FAIL';
    console.log(`STEP4 拖回原位: ${sBack}（复验浮层: 拿起=${!!snap2[0]?.hasFloat} 跟手=${!!snap2[1]?.hasFloat}）`);
  } else {
    console.log('STEP4 拖回原位: SKIP（未找到移动后块）');
  }
  await page.screenshot({ path: `${outDir}/s2-restored.png`, fullPage: false });

  // 4. 普通点击（不拖动）→ 详情弹窗应正常打开
  const from3 = await findBar(page, taskText);
  if (from3) {
    await page.mouse.move(from3.x, from3.y);
    await page.mouse.down();
    await page.mouse.up();
    await sleep(900);
    const title = await page.evaluate(() => document.querySelector('.ant-modal-title')?.textContent || '');
    const sClick = title.includes(taskText) ? 'OK' : `FAIL(${title || '无弹窗'})`;
    console.log(`STEP5 轻点弹详情: ${sClick}`);
    await page.screenshot({ path: `${outDir}/s3-click-detail.png`, fullPage: false });
    await page.keyboard.press('Escape');
  }

  console.log('---console errors---');
  console.log(pageErrors.length ? pageErrors.join('\n') : '(none)');
  const fail = [sLift, sFollow, sGuide, sTag, sMove].filter((s) => s !== 'OK' && !s.startsWith('OK(')).length;
  console.log(fail === 0 ? 'ALL-OK' : `HAS-FAIL(${fail})`);
  await browser.close();
})();
