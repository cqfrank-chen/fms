#!/usr/bin/env node
/**
 * 包装（唛头）模板试点导入 → 既有接口 POST /api/pack-templates（不新增业务逻辑）
 *
 * 用法：node tools/ziliao/import_pack_templates.mjs --in <pack_template_candidates.csv> [--out 目录]
 * 映射：模板名 = 候选「模板名」；pack = { label: <提取正文> }；note = 来源文件 + 字符数 + 来源说明
 * 环境变量：FMS_BASE / FMS_USER / FMS_PASS（同 import_customers.mjs）
 *
 * 注意：唛头/正唛/侧唛在 FMS 包装词表里最贴近 PACK_TYPES 的 label（不干胶/标贴）；
 *      box/bag/carton 三类在资料包里没有独立可提取的文本证据，不做臆造。
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.resolve(__dirname, '../../.scratch/ziliao-pilot'));
const BASE = process.env.FMS_BASE ?? 'http://127.0.0.1:3100/api';
const USER = process.env.FMS_USER ?? 'admin';
const PASS = process.env.FMS_PASS ?? 'Fms@2026';
if (!IN) { console.error('用法: node import_pack_templates.mjs --in <csv> [--out 目录]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ''));
}

async function login() {
  const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  const j = await r.json();
  if (!r.ok || !j.token) throw new Error('登录失败: ' + JSON.stringify(j));
  return j.token;
}

const rows = parseCsv(fs.readFileSync(IN, 'utf8'));
const H = rows[0];
const idx = (re) => H.findIndex((h) => re.test(h));
const iName = idx(/模板名/), iContent = idx(/label内容/), iSrc = idx(/来源文件/), iChars = idx(/字符数/);
const cands = rows.slice(1).map((r) => ({
  name: (r[iName] || '').trim(), label: (r[iContent] || '').trim(),
  src: (r[iSrc] || '').trim(), chars: (r[iChars] || '').trim(),
})).filter((x) => x.name && x.label);
console.log('包装模板候选: ' + cands.length);

const token = await login();
const created = [], failed = [];
for (const c of cands) {
  const body = {
    name: c.name.slice(0, 80),
    pack: { label: c.label },
    note: '来源文件：' + c.src + '｜提取字符数：' + c.chars + '｜由 tools/ziliao 从 ziliao.zip 唛头文档自动提取，待人工核对',
  };
  const r = await fetch(BASE + '/pack-templates', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body),
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (r.ok) created.push({ id: j.id, name: j.name, src: c.src });
  else failed.push({ name: c.name, status: r.status, err: j });
}
console.log('created=' + created.length + ' failed=' + failed.length);
if (failed.length) console.log(JSON.stringify(failed.slice(0, 5), null, 1));
fs.writeFileSync(path.join(OUT, 'import_pack_templates_report.json'), JSON.stringify({ base: BASE, input: IN, total: cands.length, created, failed }, null, 1));
console.log('报告: ' + path.join(OUT, 'import_pack_templates_report.json'));
