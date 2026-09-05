// I11 取证：临时取消 line 8 排期 → 进入待排区 → 点击触发 ScheduleModal → 截图 → 恢复
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://localhost/';
const OUT = 'D:/futures/factory-management-system/.scratch/factory-management-system/research/i11-schedule-modal.png';
const LINE_ID = 8;
const RESTORE = { wcKey: 'finish', startDate: '2026-09-20', coverDays: 5 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(`http://localhost/api/scheduling${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`API ${path} ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function main() {
  // 1) 取消 line 8 排期（让它回到待排区）
  await api(`/plan-lines/${LINE_ID}/schedule`, { method: 'DELETE' });

  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1560, height: 1000, deviceScaleFactor: 1.5 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('deprecated')) errors.push(m.text()); });

    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(800);

    // 点左侧「排程」
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('a,div,span,li')].find((x) => x.textContent.trim() === '排程' && x.offsetParent !== null);
      if (el) el.click();
    });
    await sleep(1500);

    // 待排区卡片：含「行8」字样
    const clicked = await page.evaluate((lid) => {
      const cards = [...document.querySelectorAll('div')].filter((d) => {
        if (!d.offsetParent) return false;
        const t = (d.textContent || '').trim();
        const cs = d.style;
        return t.startsWith('PS-') && t.includes(`·行${lid}`) && (cs.cursor === 'pointer' || cs.borderLeft?.includes('1677ff'));
      });
      // 取最外层（最短路径）
      const card = cards.sort((a, b) => b.textContent.length - a.textContent.length).pop() || cards[cards.length - 1];
      if (card) { card.click(); return true; }
      return false;
    }, LINE_ID);
    if (!clicked) throw new Error('未在待排区找到行8 卡片');
    await sleep(1500);

    await page.screenshot({ path: OUT });
    console.log('OK ->', OUT);
    console.log('errors:', errors.length ? errors.join(' | ') : 'none');
  } finally {
    await browser.close();
  }

  // 2) 恢复 line 8 排期
  await api(`/plan-lines/${LINE_ID}/schedule`, {
    method: 'POST',
    body: JSON.stringify(RESTORE),
  });
  console.log('RESTORED ->', RESTORE);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });