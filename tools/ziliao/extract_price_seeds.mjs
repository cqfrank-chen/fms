#!/usr/bin/env node
/**
 * 任务二：历史成交价 → 报价种子 CSV（可直接喂 tools/ziliao/import_quotes_cloud.mjs）
 * =============================================================================
 * 数据来源（与任务一同一遍解析口径，见 lib/ziliao-extract.mjs）：
 *   ① Excel 合同（表头含单价列的 570 份）→ 客户 = 顶层文件夹名，来源 = contract
 *   ② .doc 切片采购单族 / 带价其它单据（36 份有「不含税价」列）→ 来源 = doc
 *
 * 口径声明（不臆造）：
 *   · 单价：**原文直取**，不做税额换算、不做单位换算；解析不出干净数字的单元格一律丢弃
 *     （实测被丢弃的是 "25.7X1.04=28.6"、"45+2" 这类算式与 "单发焊杆,不带混合器" 这类错位文本）；
 *   · 币种：合同表头/子行里出现 USD/美元 → USD，其余一律 CNY（甲方裁定：币种统一归一为 CNY）；
 *   · 日期：单据日期只认两种**字面证据**——
 *       ① 抬头/正文里的「签约时间 / 签订时间 / 签定时间 / 日期」；
 *       ② 合同号/订单号里直接编码的日期（YZ20220402 → 2022-04-02；AB25293 → 无编码日期）。
 *     两处都没有 → **生效日期留空**（不猜年份/月份），并按「客户+产品」只保留一条（避免表内自重复）；
 *   · 产品名：原始写法（与任务一的产品候选同名），**不做任何别名合并**；
 *   · 号数/规格行（品名只有 1~2 位数字或 #N）一律剔除——两边都不可识别，匹配上等于编造价格。
 *
 * 产出：
 *   contract_price_seeds.csv   报价种子（表头：客户名称,产品名称,单价,币种,生效日期,失效日期,来源,备注）
 *   contract_price_seeds_summary.txt  人读摘要
 *   contract_price_seeds_report.json  机器可读报告
 *
 * 用法：
 *   node tools/ziliao/extract_price_seeds.mjs [--root 资料包根] [--work _work 目录] [--out tools/ziliao]
 * 环境变量：ZILIAO_ROOT / ZILIAO_WORK
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ZILIAO_ROOT, DEFAULT_WORK, DEFAULT_DOC_SLICE_DIRS,
  scanContracts, loadDocSlices, loadDocTexts, docRowValues,
  isProductNoise, isSizeOnlyName, normalizeToken, topFolder, parseDateCell,
} from './lib/ziliao-extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argsOf = (k) => process.argv.reduce((a, v, i) => (v === k && process.argv[i + 1] ? [...a, process.argv[i + 1]] : a), []);
const ROOT = argsOf('--root')[0] ?? DEFAULT_ZILIAO_ROOT;
const WORK = argsOf('--work')[0] ?? DEFAULT_WORK;
const OUT_DIR = argsOf('--out')[0] ?? __dirname;
const SLICE_DIRS = argsOf('--csvdir').length ? argsOf('--csvdir') : DEFAULT_DOC_SLICE_DIRS;

/**
 * 从合同号/订单号里抽日期（单据自己的编号规则，不是猜测）：
 *   YZ20220402 → 2022-04-02（8 位 YYYYMMDD）
 *   YZ240729   → 2024-07-29（6 位 YYMMDD）
 *   非日期形态（如 AB20831、LGC10801299）→ null
 */
export function dateFromPoNo(poNo) {
  const s = String(poNo ?? '').replace(/\s+/g, '');
  const m8 = s.match(/(\d{4})(\d{2})(\d{2})/);
  if (m8) {
    const y = Number(m8[1]), mo = Number(m8[2]), d = Number(m8[3]);
    if (y >= 2010 && y <= 2035 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return y + '-' + m8[2] + '-' + m8[3];
    }
  }
  const m6 = s.match(/(\d{2})(\d{2})(\d{2})$/);
  if (m6) {
    const y = 2000 + Number(m6[1]), mo = Number(m6[2]), d = Number(m6[3]);
    if (y >= 2010 && y <= 2035 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return y + '-' + m6[2] + '-' + m6[3];
    }
  }
  return null;
}

/** 月/日缺年份（"6/2"）时：优先用合同号里的日期补年，再退回 null（不猜） */
function resolveSignDate(raw, poNo) {
  if (!raw) return { date: null, source: 'none' };
  const full = parseDateCell(raw);
  if (full) return { date: full, source: 'document' };
  const m = String(raw).match(/^(\d{1,2})\s*[\/\-]\s*(\d{1,2})$/);
  if (!m) return { date: null, source: 'none' };
  const po = dateFromPoNo(poNo);
  if (po && po.slice(5, 7) === String(m[1]).padStart(2, '0') && po.slice(8, 10) === String(m[2]).padStart(2, '0')) {
    return { date: po, source: 'document-no-year+po' };
  }
  return { date: null, source: 'none' };
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ============================================================
// ① Excel 合同
// ============================================================
const raw = [];
console.log('资料包根目录：' + ROOT);
const { contracts, scanned } = scanContracts(ROOT);
console.log('Excel 总数 ' + scanned + '，其中「表头含单价列」合同 ' + contracts.length + ' 份');
let contractRows = 0, contractKept = 0, contractDroppedNoName = 0, contractDroppedSizeOnly = 0, contractDroppedBadPrice = 0, contractNoDate = 0;
const currencyCount = {};
for (const c of contracts) {
  for (const s of c.sheets) {
    const cur = s.currency && /usd|美元|us\$/i.test(s.currency) ? 'USD' : 'CNY';
    const head = s.headerArea;
    const sign = resolveSignDate(head.signDate, head.poNo);
    for (const r of s.rows) {
      contractRows += 1;
      if (!r.productName) { contractDroppedNoName += 1; continue; }
      if (isSizeOnlyName(r.productName)) { contractDroppedSizeOnly += 1; continue; }
      if (isProductNoise(r.productName)) { contractDroppedNoName += 1; continue; }
      if (r.unitPrice === null || r.unitPrice === undefined || !(r.unitPrice > 0)) { contractDroppedBadPrice += 1; continue; }
      const date = sign.date ?? dateFromPoNo(head.poNo);
      const dateSource = sign.date ? '抬头签约时间' : (date ? '合同号编码日期' : '无（已留空）');
      if (!date) contractNoDate += 1;
      currencyCount[cur] = (currencyCount[cur] ?? 0) + 1;
      raw.push({
        customer: c.top, productName: r.productName, unitPrice: r.unitPrice, currency: cur,
        validFrom: date, source: 'contract',
        remark: '来源文件：' + c.rel + '（工作表 ' + s.sheet + ' 第 ' + r.rowNo + ' 行'
          + (head.poNo ? '；合同号 ' + head.poNo : '')
          + (head.buyer ? '；抬头需方 ' + head.buyer : '')
          + '；日期凭证：' + dateSource + '）'
          + (r.packaging ? '；包装：' + r.packaging : '')
          + '【tools/ziliao/extract_price_seeds.mjs 自动抽取·历史成交价·待甲方核对】',
      });
      contractKept += 1;
    }
  }
}
console.log('合同价格行 ' + contractRows + ' → 保留 ' + contractKept
  + '（无产品名/噪声 ' + contractDroppedNoName + '，号数行 ' + contractDroppedSizeOnly + '，价格不可解析 ' + contractDroppedBadPrice + '）');
console.log('合同行币种分布 ' + JSON.stringify(currencyCount) + '；无日期行 ' + contractNoDate + '（生效日期留空）');

// ============================================================
// ② .doc 切片
// ============================================================
const slices = loadDocSlices(SLICE_DIRS);
const texts = loadDocTexts(path.join(WORK, 'texts.jsonl'));
const KIND_LABEL = { plan: '计划单', purchase: '采购单', other: '其它单据' };
let docRows = 0, docKept = 0, docDroppedSize = 0, docDroppedBad = 0, docNoDate = 0;
for (const s of slices) {
  if (s.headerRowIndex < 0 || s.columns.unitPrice === undefined) continue;
  const txt = texts.get(s.rel);
  const poNo = txt?.poNo ?? s.head?.poNo ?? null;
  const sign = resolveSignDate(txt?.signDate ?? s.head?.signRaw ?? null, poNo);
  const date = sign.date ?? dateFromPoNo(poNo);
  const dateSource = sign.date ? (sign.source === 'document' ? '单据签定时间' : '签定时间(补年自合同号)') : (date ? '合同号编码日期' : '无（已留空）');
  for (const row of s.rows) {
    const v = docRowValues(row, s.columns);
    if (!v.name) continue;
    docRows += 1;
    if (isSizeOnlyName(v.name)) { docDroppedSize += 1; continue; }
    if (isProductNoise(v.name)) continue;
    if (v.unitPrice === undefined || !(v.unitPrice > 0)) { docDroppedBad += 1; continue; }
    if (!date) docNoDate += 1;
    raw.push({
      customer: topFolder(s.rel), productName: v.name, unitPrice: v.unitPrice, currency: 'CNY',
      validFrom: date, source: 'doc',
      remark: '来源文件：' + s.rel + '（' + (KIND_LABEL[s.kind] ?? s.kind) + ' 第 ' + (s.headerRowIndex + 2) + ' 行起'
        + (poNo ? '；合同号 ' + poNo : '')
        + (s.head?.dueRaw ? '；单据交货期 ' + s.head.dueRaw : '')
        + '；日期凭证：' + dateSource + '）'
        + (v.recovered ? '【该行由列错位回填，产品名需人工核对】' : '')
        + '【tools/ziliao/extract_price_seeds.mjs 自动抽取·历史成交价·待甲方核对】',
    });
    docKept += 1;
  }
}
console.log('.doc 切片 ' + slices.length + ' 份（含单价列的 ' + slices.filter((s) => s.columns && s.columns.unitPrice !== undefined).length + ' 份）'
  + ' → 保留价格行 ' + docKept + '（号数行 ' + docDroppedSize + '，价格不可解析 ' + docDroppedBad + '）；无日期行 ' + docNoDate);

// ============================================================
// 去重（服务端幂等键 = 客户 + 产品 + 生效日期；表内自重复会被服务端判为错误行）
// ============================================================
const merged = new Map();
let dupCount = 0, undatedDup = 0;
for (const r of raw) {
  const key = r.customer + '|' + normalizeToken(r.productName) + '|' + (r.validFrom ?? '');
  const prev = merged.get(key);
  if (!prev) { merged.set(key, r); continue; }
  dupCount += 1;
  if (!r.validFrom) undatedDup += 1;
  // 同键保留信息更全的一条（有包装/有合同号的优先），价格不同则保留较新的录入（后者）
  merged.set(key, prev.remark.length >= r.remark.length ? prev : r);
}
const rowsAll = [...merged.values()];
console.log('同键合并 ' + dupCount + ' 条（其中无日期同键 ' + undatedDup + ' 条）→ 去重后 ' + rowsAll.length + ' 条');

const byCustomer = {};
const bySource = {};
const byYear = {};
const priceMin = { v: Infinity }, priceMax = { v: 0 };
for (const r of rowsAll) {
  byCustomer[r.customer] = (byCustomer[r.customer] ?? 0) + 1;
  bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  const y = r.validFrom ? r.validFrom.slice(0, 4) : '（无日期）';
  byYear[y] = (byYear[y] ?? 0) + 1;
  priceMin.v = Math.min(priceMin.v, r.unitPrice);
  priceMax.v = Math.max(priceMax.v, r.unitPrice);
}

rowsAll.sort((a, b) => a.customer.localeCompare(b.customer) || (b.validFrom ?? '').localeCompare(a.validFrom ?? '') || a.productName.localeCompare(b.productName));

const outFile = path.join(OUT_DIR, 'contract_price_seeds.csv');
const header = ['客户名称', '产品名称', '单价', '币种', '生效日期', '失效日期', '来源', '备注'];
const lines = [header, ...rowsAll.map((r) => [r.customer, r.productName, Number(r.unitPrice).toFixed(2), r.currency, r.validFrom ?? '', '', r.source, r.remark])];
fs.writeFileSync(outFile, '\uFEFF' + lines.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');

const summary = [
  '历史成交价报价种子抽取摘要（tools/ziliao/extract_price_seeds.mjs）',
  '=============================================================',
  '资料包根目录：' + ROOT,
  '来源① Excel 合同 ' + contracts.length + ' 份 → 价格行 ' + contractKept + '（币种 ' + JSON.stringify(currencyCount) + '）',
  '来源② .doc 切片（采购单族/带价其它单据）→ 价格行 ' + docKept,
  '同键（客户+产品+生效日期）合并 ' + dupCount + ' 条 → 最终 ' + rowsAll.length + ' 条',
  '',
  '按客户：' + JSON.stringify(byCustomer),
  '按来源：' + JSON.stringify(bySource),
  '按年份：' + JSON.stringify(byYear),
  '单价区间：' + (rowsAll.length ? Number(priceMin.v).toFixed(2) + ' ~ ' + Number(priceMax.v).toFixed(2) + ' 元' : '-'),
  '',
  '日期口径（只认字面证据，两处都没有就留空，不猜）：',
  '  ① 抬头/正文的「签约时间 / 签订时间 / 签定时间 / 日期」；',
  '  ② 合同号里编码的日期：YZ20220402 → 2022-04-02、YZ240729 → 2024-07-29；',
  '  ③ 都没有 → 生效日期留空（该报价不设起始边界，始终参与取价），并在备注里写明「日期凭证：无（已留空）」。',
  '',
  '刻意剔除（见 lib/ziliao-extract.mjs isSizeOnlyName / isProductNoise）：',
  '  · 品名只有 1~2 位数字或 #N 的「号数行」：' + (contractDroppedSizeOnly + docDroppedSize) + ' 行（合同 ' + contractDroppedSizeOnly + ' + 切片 ' + docDroppedSize + '）；',
  '  · 价格单元格不是干净数字的（算式/描述错位）：合同 ' + contractDroppedBadPrice + ' 行 + 切片 ' + docDroppedBad + ' 行；',
  '  · 理由：这些行两边的产品都不可识别，匹配上等于编造价格。',
  '',
  '导出：' + outFile,
];
fs.writeFileSync(path.join(OUT_DIR, 'contract_price_seeds_summary.txt'), summary.join('\r\n') + '\r\n', 'utf8');

fs.writeFileSync(path.join(OUT_DIR, 'contract_price_seeds_report.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  root: ROOT,
  contracts: { scanned, priceContracts: contracts.length, rows: contractRows, kept: contractKept, droppedSizeOnly: contractDroppedSizeOnly, droppedBadPrice: contractDroppedBadPrice, noDate: contractNoDate, currency: currencyCount },
  docSlices: { files: slices.length, kept: docKept, droppedSizeOnly: docDroppedSize, droppedBadPrice: docDroppedBad, noDate: docNoDate },
  mergedDuplicates: dupCount,
  total: rowsAll.length,
  byCustomer, bySource, byYear,
  output: outFile,
  rows: rowsAll,
}, null, 1), 'utf8');

console.log('');
console.log('================ 历史成交价种子汇总 ================');
console.log('最终 ' + rowsAll.length + ' 条（合同 ' + bySource.contract + ' / 单据 ' + (bySource.doc ?? 0) + '）');
console.log('按客户 ' + JSON.stringify(byCustomer));
console.log('按年份 ' + JSON.stringify(byYear));
console.log('产出：');
console.log('  ' + outFile);
console.log('  ' + path.join(OUT_DIR, 'contract_price_seeds_summary.txt'));
