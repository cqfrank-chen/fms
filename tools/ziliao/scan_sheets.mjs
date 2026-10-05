#!/usr/bin/env node
/**
 * 资料包 .xls/.xlsx 批量结构扫描 → JSONL（每行：文件、工作表、表头、前若干行样例）
 *
 * 用法：node tools/ziliao/scan_sheets.mjs <资料包根目录> <输出.jsonl> [--rows 12]
 * 说明：复用仓库 apps/api 已安装的 SheetJS（@e965/xlsx），同时支持 BIFF8(.xls) 与 OOXML(.xlsx)。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(__dirname, '../../apps/api');
const require = createRequire(path.join(apiDir, 'package.json'));
const XLSX = require('@e965/xlsx');

const root = process.argv[2];
const outPath = process.argv[3];
const rowsArg = process.argv.indexOf('--rows');
const MAXROWS = rowsArg > 0 ? Number(process.argv[rowsArg + 1]) : 12;
if (!root || !outPath) {
  console.error('用法: node scan_sheets.mjs <root> <out.jsonl> [--rows N]');
  process.exit(2);
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(xls|xlsx)$/i.test(e.name)) acc.push(p);
  }
  return acc;
}

const files = walk(root).sort();
const out = fs.createWriteStream(outPath, { encoding: 'utf8' });
let n = 0, bad = 0, sheetTotal = 0;
for (const p of files) {
  const rel = path.relative(root, p).split(path.sep).join('/');
  const rec = { rel, size: fs.statSync(p).size };
  try {
    const wb = XLSX.read(fs.readFileSync(p), { type: 'buffer', cellDates: true, cellStyles: false });
    rec.sheets = wb.SheetNames.map((sn) => {
      sheetTotal++;
      const ws = wb.Sheets[sn];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false });
      const range = ws['!ref'] || '';
      return {
        name: sn,
        ref: range,
        nrows: aoa.length,
        head: aoa.slice(0, MAXROWS).map((r) => r.slice(0, 14).map((c) => String(c ?? '').slice(0, 60))),
      };
    });
    rec.ok = true;
  } catch (e) {
    rec.ok = false; rec.err = String(e && e.message || e); bad++;
  }
  out.write(JSON.stringify(rec) + '\n');
  n++;
  if (n % 200 === 0) console.log('[' + n + '/' + files.length + ']');
}
out.end();
console.log('DONE files=' + n + ' sheets=' + sheetTotal + ' errors=' + bad + ' -> ' + outPath);
