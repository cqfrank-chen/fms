/**
 * 回归：设置页「AI 服务配置」保存链路（修复双重 JSON.stringify bug）
 * 步骤：导航设置页 → 在对话 API Key 键入测试值 → 点「保存 AI 配置」
 *      → 断言 success toast + GET /api/ai/config keySet=true → 清理还原
 * 用法：node repro-ai-config-save.cjs <baseUrl> <outDir>
 */
const path = require('path');
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const [, , baseUrl = 'http://localhost/', outDir = __dirname + '/shots-ai-config'] = process.argv;
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

async function apiGet(page, p) {
  return page.evaluate(async (p) => (await fetch('/api' + p)).json(), p);
}

async function typeIntoCardInput(page, inputIndex, text) {
  const ok = await page.evaluate((i) => {
    const card = [...document.querySelectorAll('.ant-card')]
      .find((c) => c.querySelector('.ant-card-head-title')?.textContent?.includes('AI 服务配置'));
    const el = card?.querySelectorAll('input')[i];
    if (!el) return false;
    el.focus();
    return true;
  }, inputIndex);
  if (ok) await page.keyboard.type(text, { delay: 15 });
  return ok;
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  // 1. 打开首页 → 设置·主数据
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(600);
  await clickMenu(page, '设置·主数据');
  await page.waitForFunction(() => document.body.innerText.includes('AI 服务配置'), { timeout: 20000 });
  await sleep(500);
  console.log('STEP1 设置页就绪 OK');
  await page.screenshot({ path: `${outDir}/a1-setup.png`, fullPage: false });

  // 2. 键入测试 API Key（第 0 个 input = 对话 API Key）
  const typed = await typeIntoCardInput(page, 0, 'sk-front-test-99abcd');
  console.log('STEP2 键入 key:', typed ? 'OK' : 'FAIL');
  await sleep(300);
  await page.screenshot({ path: `${outDir}/a2-typed.png` });

  // 3. 点「保存 AI 配置」
  const saved = await clickBtn(page, '保存AI配置');
  console.log('STEP3 点击保存按钮:', saved ? 'OK' : 'FAIL');
  await page.waitForFunction(() => document.body.innerText.includes('已保存并立即生效'), { timeout: 10000 }).catch(() => {});
  await sleep(600);
  const hasSuccess = await page.evaluate(() => !!document.querySelector('.ant-message-success'));
  const errToast = await page.evaluate(() => [...document.querySelectorAll('.ant-message-error')].map((x) => x.textContent));
  console.log('STEP3 success toast:', hasSuccess ? 'OK' : 'FAIL', '| error toast:', errToast.length ? JSON.stringify(errToast) : '(none)');
  await page.screenshot({ path: `${outDir}/a3-saved.png` });

  // 4. 后端回读断言
  const cfg = await apiGet(page, '/ai/config');
  const keySet = !!cfg.chatApiKey?.keySet;
  const hint = cfg.chatApiKey?.keyHint ?? '';
  console.log('STEP4 后端 keySet:', keySet ? 'OK' : 'FAIL', '| keyHint=', hint, keySet && hint === '…abcd' ? 'OK' : '(FAIL)');

  // 5. 修改模型字段也保存一次（覆盖非 key patch 路径）
  await typeIntoCardInput(page, 2, 'deepseek-chat-x');
  await clickBtn(page, '保存AI配置');
  await sleep(800);
  const cfg2 = await apiGet(page, '/ai/config');
  const modelSaved = cfg2.chatModel?.value === 'deepseek-chat-x';
  console.log('STEP5 模型保存:', modelSaved ? 'OK' : 'FAIL', '=', cfg2.chatModel?.value);
  await page.screenshot({ path: `${outDir}/a5-model.png` });

  // 6. 清理：清除两个 DB 覆盖（回退默认）
  const clean = await page.evaluate(async () => {
    const r1 = await fetch('/api/ai/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatApiKey: '', chatModel: '' }) });
    return r1.ok ? 'cleaned' : 'clean-failed:' + r1.status;
  });
  const cfg3 = await apiGet(page, '/ai/config');
  console.log('STEP6 清理:', clean, '| keySet now:', cfg3.chatApiKey?.keySet, '| model now:', cfg3.chatModel?.value);

  console.log('=== PAGE ERRORS ===', pageErrors.length ? pageErrors.join('\n') : '(none)');
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
