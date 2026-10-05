#!/usr/bin/env node
/**
 * Excel 合同「共性解析问题」审计（离线 · 不发 HTTP）· 只读不写库
 * =====================================================================
 * 目的：批量落草稿前，先把整批 Excel 合同的**解析质量**盘一遍，回答三个问题：
 *   ① 表头族识别：产品列/单价列是不是被别的字段抢走？（安宝族「客户需求产品描述」实测被 customer 抢）
 *   ② 多工作表：一个工作簿里有几张「带价合同表」？管线只读第一张非空表 → 会漏几张？
 *   ③ 大文件：多大？（>8MB 会被服务端 /ai/orders/parse 的 8MB 上传护栏挡掉，HTTP 400/413）
 * 口径：直接调用仓库**已构建**的识单模块 apps/api/dist/ai/table-parser.service.js（先 npm run build），
 *       与线上识单完全同一套代码，不做二次实现；客户一律按「文件夹=客户」传 folderCustomer。
 *
 * 用法：
 *   node tools/ziliao/excel_contract_audit.mjs --dir <安宝公司> --dir <尤耐克> --label AFTER --out D:/futures/_work/excel_audit_AFTER.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { extractContractFile } from './lib/ziliao-extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(__dirname, '../../apps/api');
const require = createRequire(path.join(API_DIR, 'package.json'));
const M = require(path.join(API_DIR, 'dist/ai/table-parser.service.js'));
const XLSX = require('@e965/xlsx');

const argv = process.argv.slice(2);
const argsOf = (k) => argv.reduce((a, v, i) => (v === k && argv[i + 1] ? [...a, argv[i + 1]] : a), []);
const arg1 = (k, d) => argsOf(k)[0] ?? d;
const DIRS = argsOf('--dir');
const LABEL = arg1('--label', 'RUN');
const OUT = path.resolve(arg1('--out', path.join('D:/futures/_work', 'excel_audit_' + LABEL + '.json')));
/** 单个文件超过该体积就会被 /ai/orders/parse 的 8MB 上传护栏挡掉（base64 还会再放大 1/3，12mb JSON 上限也扛不住） */
const BIG_MB = Number(arg1('--big-mb', 6)) || 6;
if (!DIRS.length) { console.error('用法: node excel_contract_audit.mjs --dir <客户文件夹> [--dir ...] [--label X] [--out 文件]'); process.exit(2); }

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(xls|xlsx)$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}

/** 该单元格是否「看起来是产品列」（含产品/品名/描述/需求）却被别的字段占走 */
function stolenProductCells(rows, headerRowIndex, columns) {
  const out = [];
  const scan = Math.min(rows.length, headerRowIndex + 1);
  for (let r = 0; r <= headerRowIndex && r < scan; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const v = M.normalizeToken(rows[r][c]);
      if (!v) continue;
      if (!(v.includes('产品') || v.includes('品名') || v.includes('描述') || v.includes('需求'))) continue;
      const owner = Object.entries(columns).find(([, cc]) => cc === c);
      if (owner && owner[0] !== 'productName' && owner[0] !== 'productCode') {
        out.push({ text: String(rows[r][c]).slice(0, 30), row: r, col: c, owner: owner[0] });
      }
    }
  }
  return out;
}

/** 该列的真实非空数据行数（用于量化「产品列被抢走」的漏抽） */
function nonEmptyDataRows(rows, headerRowIndex, col) {
  if (col === null || col === undefined) return 0;
  return rows.slice(headerRowIndex + 1).filter((r) => String(r[col] ?? '').trim() !== '').length;
}

const files = [];
for (const d of DIRS) {
  const abs = path.resolve(d);
  const top = path.basename(abs);
  for (const f of walk(abs)) files.push({ abs: f, top, rel: path.relative(abs, f).split(path.sep).join('/') });
}
files.sort((a, b) => (a.top + '/' + a.rel).localeCompare(b.top + '/' + b.rel));

const out = [];
let nBig = 0;
for (const it of files) {
  const buf = fs.readFileSync(it.abs);
  const sizeMb = buf.length / 1024 / 1024;
  if (sizeMb > BIG_MB) nBig += 1;
  const local = (() => { try { return extractContractFile(it.abs, it.rel, it.top); } catch { return { sheets: [] }; } })();
  const rec = { key: it.top + '/' + it.rel, top: it.top, sizeMb: Number(sizeMb.toFixed(2)), contractByPriceColumn: local.sheets.length > 0, pricedSheets: local.sheets.length };
  let rows = null;
  try {
    const kind = M.sniffMagicKind(buf);
    if (kind === 'xls') rows = M.normalizeMatrix(M.readXlsMatrix(buf));
    else if (kind === 'xlsx') rows = M.normalizeMatrix(await M.readXlsxMatrix(buf));
    else { rec.error = '非表格（magic=' + kind + '）'; out.push(rec); continue; }
  } catch (e) { rec.error = '读取失败：' + String(e && e.message ? e.message : e).slice(0, 80); out.push(rec); continue; }
  if (!rows || !rows.length) { rec.error = '空矩阵'; out.push(rec); continue; }
  const h = M.mapHeader(rows, { folderCustomer: it.top });
  const r = M.ruleMapMatrix(rows, { folderCustomer: it.top });
  const stolen = stolenProductCells(rows, h.headerRowIndex, h.columns);
  const descCell = stolen.find((s) => /客户.*(产品|需求)/.test(s.text)) ?? null;
  Object.assign(rec, {
    headerRowIndex: h.headerRowIndex,
    columns: h.columns,
    missingRequired: h.missingRequired,
    validRows: r.dataRows.validRows,
    incompleteRows: r.dataRows.incomplete,
    emittedRows: r.dataRows.emittedRows,
    stopReason: r.dataRows.stopReason,
    productNameFromCode: r.table ? undefined : undefined,
    stolen,
    /** 「客户需求产品描述」类列被谁抢走 + 该列非空行数（**含合并单元格向下回填，只能当漏抽的上限参考**，不是真值） */
    descColumn: descCell ? { col: descCell.col, owner: descCell.owner, nonEmptyRowsWithMergeFill: nonEmptyDataRows(rows, h.headerRowIndex, descCell.col) } : null,
    /** 单价列是否存在；缺失且是「含税」族 → 记 含税族缺单价列 */
    hasUnitPriceColumn: h.columns.unitPrice !== undefined,
    headerHasHanShui: rows.slice(0, Math.min(rows.length, 8)).some((row) => row.some((c) => M.normalizeToken(c) === '含税')),
  });
  out.push(rec);
}

// ============ 汇总 ============
const ok = out.filter((x) => !x.error);
const sum = {
  label: LABEL, dirs: DIRS, files: out.length, readErrors: out.length - ok.length,
  contracts: ok.filter((x) => x.contractByPriceColumn).length,
  validRows: ok.reduce((a, x) => a + (x.validRows ?? 0), 0),
  incompleteRows: ok.reduce((a, x) => a + (x.incompleteRows ?? 0), 0),
  emittedRows: ok.reduce((a, x) => a + (x.emittedRows ?? 0), 0),
  zeroValid: ok.filter((x) => x.validRows === 0).length,
  /** 问题①：产品列被抢（「客户需求产品描述」类列被 customer 抢走） */
  descStolenFiles: ok.filter((x) => x.descColumn && x.descColumn.owner !== 'productName').length,
  descStolenValidRows: ok.filter((x) => x.descColumn).reduce((a, x) => a + (x.validRows ?? 0), 0),
  /** 问题②：多工作表（另有带价表 → 管线只读第一张非空表，会漏） */
  multiSheetFiles: ok.filter((x) => x.pricedSheets > 1).length,
  multiSheetExtraSheets: ok.filter((x) => x.pricedSheets > 1).reduce((a, x) => a + x.pricedSheets - 1, 0),
  /** 问题③：大文件（上传护栏） */
  bigFiles: nBig, bigMbThreshold: BIG_MB,
  /** 其它：单价列缺失但表头出现「含税」 */
  hanShuiNoPriceFiles: ok.filter((x) => !x.hasUnitPriceColumn && x.headerHasHanShui).length,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ summary: sum, files: out }, null, 1));

console.log('================ Excel 合同解析审计（' + LABEL + '）================');
console.log('目录 ' + DIRS.length + ' 个　Excel 文件 ' + sum.files + '　读取失败 ' + sum.readErrors);
console.log('「带单价列合同」（与产品/报价抽取同一口径） ' + sum.contracts + ' 份');
console.log('产品行合计：完整 ' + sum.validRows + ' / 残缺 ' + sum.incompleteRows + ' / 输出 ' + sum.emittedRows
  + '　有效行为 0 的文件 ' + sum.zeroValid + ' 份');
console.log('① 产品列被抢（『客户需求产品描述』类列落到别的字段）：' + sum.descStolenFiles
  + ' 份　这些文件当前有效产品行合计 ' + sum.descStolenValidRows
  + '（改动前后用同一脚本各跑一次即可看到增减；『该列非空行数』含合并单元格回填，仅作上限参考）');
console.log('② 多工作表：另有带价表的文件 ' + sum.multiSheetFiles + ' 份（额外 ' + sum.multiSheetExtraSheets + ' 张带价表未参与识单）');
console.log('③ 大文件（>' + sum.bigMbThreshold + 'MB，会被 8MB 上传护栏挡掉） ' + sum.bigFiles + ' 份');
console.log('④ 表头出现「含税」但没识别出单价列 ' + sum.hanShuiNoPriceFiles + ' 份（缺价来源）');
console.log('报告：' + OUT);
