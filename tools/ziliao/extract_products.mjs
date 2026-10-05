#!/usr/bin/env node
/**
 * 任务一：从客户资料包抽取「产品建档候选」
 * =============================================================================
 * 来源（三种，全部走既有解析口径，见 lib/ziliao-extract.mjs）：
 *   ① Excel 合同：工作表表头含单价列的合同族（实测 570 份，其中安宝公司 316 份为甲方点名的口径）
 *   ② .doc 切片：计划单族（214 份，**无单价列**，产品名与包装仍可抽）
 *   ③ .doc 切片：采购单族 / 带价其它单据（36 份有「不含税价」列）
 *
 * 产出：
 *   products_candidates.csv   产品建档候选（可直接喂 tools/ziliao/import_products_cloud.mjs）
 *   products_variants.csv     **疑似同产品的不同写法**清单（只列疑点，脚本不自动合并）
 *   products_candidates_summary.txt  人读摘要（数量/类型分布/噪声剔除/口径说明）
 *   products_extract_report.json     机器可读全量报告
 *
 * 去重口径（与 apps/api/src/ai/table-parser.service.ts **逐字符同口径**，2026 甲方更正后）：
 *   ① 文本外壳归一：去空格 / 全角半角 / 大小写 / 括号冒号顿号横杠斜杠等噪声；
 *   ② **数字指纹（digitSignature）必须逐字符一致**：前导零、数字位数、后缀号数原样保留，不做任何折叠。
 *   去重键 = productIdentityKey = ① + ②。
 *   甲方口径：「0-GPN 和 00-GPN 是同一型号的不同尺寸」→ 000-GPN / 00-GPN / 0-GPN **各是一条独立候选**，
 *   绝不合并；变体清单按「A 类纯文本差异 / B 类数字尺寸差异」分开产出（B 类明确标注不合并、各自建档）。
 *
 * 产品类型（NOT NULL 枚举）：只认字面证据（气体：乙炔/丙烷；地域：英式/美式 + ANM/PNM/6290 型号族），
 *   **推断不出一律 tbd**，并在候选清单里标「类型待人工确认」。绝不臆造。
 *
 * 用法：
 *   node tools/ziliao/extract_products.mjs [--root 资料包根] [--work _work 目录] [--out tools/ziliao]
 * 环境变量：ZILIAO_ROOT / ZILIAO_WORK
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ZILIAO_ROOT, DEFAULT_WORK, DEFAULT_DOC_SLICE_DIRS,
  scanContracts, loadDocSlices, loadDocTexts, docRowValues, docMtime,
  inferProductType, isProductNoise, isSizeOnlyName, cleanPackaging, normalizeToken, topFolder,
  digitSignature, productIdentityKey, variantGroupFingerprint,
} from './lib/ziliao-extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argsOf = (k) => process.argv.reduce((a, v, i) => (v === k && process.argv[i + 1] ? [...a, process.argv[i + 1]] : a), []);
const ROOT = argsOf('--root')[0] ?? DEFAULT_ZILIAO_ROOT;
const WORK = argsOf('--work')[0] ?? DEFAULT_WORK;
const OUT_DIR = argsOf('--out')[0] ?? __dirname;

/** 累积器：产品同一性键（文本归一 + 数字指纹）→ 记录 */
function newAcc() {
  return {
    key: '',            // productIdentityKey(name) = normalizeToken + '#' + digitSignature
    token: '',          // normalizeToken(name)：仅用于「旧口径是否会把不同尺寸折叠成一条」的审计
    name: '',           // 首次出现的原始写法（保留原文，不做清洗）
    variants: new Map(), // 原始写法 → 次数（同一归一形式的不同原文写法）
    count: 0,
    files: new Set(),
    examples: [],
    kinds: {},          // 合同 / 计划单 / 采购单
    packages: new Map(), // 包装描述 → 次数
    recovered: 0,       // 列错位回填行数
    variantTexts: new Map(), // 号数/规格（合同里产品名后的短单元格）
  };
}

function addRow(acc, name, opts) {
  // ⚠️ 甲方更正（2026）：前导零 / 数字位差异 = 不同尺寸 = 不同产品，**绝不合并**。
  // 去重键因此是「文本归一 + 数字指纹」（productIdentityKey）：0-GPN / 00-GPN / 000-GPN 各是一条候选。
  const key = productIdentityKey(name);
  if (!key || key === '#') return null;
  let rec = acc.get(key);
  if (!rec) { rec = newAcc(); rec.key = key; rec.token = normalizeToken(name); rec.name = name; acc.set(key, rec); }
  rec.count += 1;
  if (!rec.variants.has(name)) rec.variants.set(name, 0);
  rec.variants.set(name, rec.variants.get(name) + 1);
  if (opts.file) {
    rec.files.add(opts.file);
    if (rec.examples.length < 3 && !rec.examples.includes(opts.file)) rec.examples.push(opts.file);
  }
  const k = opts.kind ?? '其它';
  rec.kinds[k] = (rec.kinds[k] ?? 0) + 1;
  const pkg = cleanPackaging(opts.packaging);
  if (pkg) rec.packages.set(pkg, (rec.packages.get(pkg) ?? 0) + 1);
  if (opts.recovered) rec.recovered += 1;
  if (opts.variantText) rec.variantTexts.set(opts.variantText, (rec.variantTexts.get(opts.variantText) ?? 0) + 1);
  return rec;
}

function topEntries(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** CSV 单元格转义 */
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function writeCsv(file, header, rows) {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(','));
  fs.writeFileSync(file, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
}

// ============================================================
// 抽取
// ============================================================
console.log('资料包根目录：' + ROOT);
console.log('--- ① Excel 合同（表头含单价列）---');
const t0 = Date.now();
const { contracts, scanned } = scanContracts(ROOT, { onProgress: (n, total) => console.log('    [' + n + ' 份带价合同 / 共 ' + total + ' 个 Excel]') });
const byTop = {};
for (const c of contracts) byTop[c.top] = (byTop[c.top] ?? 0) + 1;
console.log('Excel 总数 ' + scanned + '，其中「表头含单价列」合同 ' + contracts.length + ' 份，耗时 ' + (Date.now() - t0) + 'ms');
console.log('按顶层客户文件夹：' + JSON.stringify(byTop));

const acc = new Map();
const noiseSamples = [];
const sizeOnlySamples = [];
let contractRows = 0, contractNoise = 0, contractSizeOnly = 0;
for (const c of contracts) {
  for (const s of c.sheets) {
    for (const r of s.rows) {
      contractRows += 1;
      if (isSizeOnlyName(r.productName)) { contractSizeOnly += 1; if (sizeOnlySamples.length < 20) sizeOnlySamples.push([c.rel, r.productName]); continue; }
      if (isProductNoise(r.productName)) { contractNoise += 1; if (noiseSamples.length < 40) noiseSamples.push([c.rel, r.productName]); continue; }
      addRow(acc, r.productName, {
        file: c.rel, kind: '合同', packaging: r.packaging, variantText: r.variantText,
      });
    }
  }
}
console.log('合同产品行 ' + contractRows + '（剔除噪声 ' + contractNoise + ' 行）');

console.log('--- ② / ③ .doc 切片（计划单 / 采购单 / 带价其它）---');
const slices = loadDocSlices(DEFAULT_DOC_SLICE_DIRS.length ? DEFAULT_DOC_SLICE_DIRS : [path.join(WORK, 'doc_csv_sz'), path.join(WORK, 'doc_csv_zh')]);
const texts = loadDocTexts(path.join(WORK, 'texts.jsonl'));
const kindCount = {};
for (const s of slices) kindCount[s.kind] = (kindCount[s.kind] ?? 0) + 1;
console.log('切片 CSV ' + slices.length + ' 份：' + JSON.stringify(kindCount) + '　Word 正文缓存 ' + texts.size + ' 份');

const KIND_LABEL = { plan: '计划单', purchase: '采购单', other: '其它单据' };
let docRows = 0, docPricedRows = 0, recoveredRows = 0, docSizeOnly = 0, docSizeOnlyPriced = 0;
const priceRows = []; // 任务二用：历史成交价行
for (const s of slices) {
  if (s.headerRowIndex < 0 || s.columns.productName === undefined) continue;
  const label = KIND_LABEL[s.kind] ?? '其它单据';
  const txt = texts.get(s.rel);
  const mtime = docMtime(ROOT, s.rel);
  for (const row of s.rows) {
    const v = docRowValues(row, s.columns);
    if (!v.name) continue;
    docRows += 1;
    if (v.recovered) recoveredRows += 1;
    // 号数/规格行（合并单元格残留）：既不当产品，也不当报价 —— 见 isSizeOnlyName 注释
    if (isSizeOnlyName(v.name)) {
      docSizeOnly += 1;
      if (s.columns.unitPrice !== undefined && v.unitPrice !== undefined && v.unitPrice > 0) {
        docSizeOnlyPriced += 1;
        if (sizeOnlySamples.length < 40) sizeOnlySamples.push([s.rel, v.name, v.unitPrice]);
      }
      continue;
    }
    if (isProductNoise(v.name)) { if (noiseSamples.length < 40) noiseSamples.push([s.rel, v.name]); continue; }
    addRow(acc, v.name, { file: s.rel, kind: label, packaging: v.packaging, recovered: v.recovered });
    // 历史成交价行：只要该单据有单价列且该行有单价
    if (s.columns.unitPrice !== undefined && v.unitPrice !== undefined && v.unitPrice > 0) {
      docPricedRows += 1;
      priceRows.push({
        rel: s.rel, top: topFolder(s.rel), kind: s.kind, label, productName: v.name,
        unitPrice: v.unitPrice, quantity: v.quantity, packaging: v.packaging,
        rowNo: docRows, recovered: v.recovered,
        poNo: txt?.poNo ?? s.head?.poNo ?? null,
        signRaw: txt?.signDate ?? s.head?.signRaw ?? null,
        dueRaw: s.head?.dueRaw ?? null,
        mtime,
      });
    }
  }
}
console.log('切片产品行 ' + docRows + '（列错位回填 ' + recoveredRows + ' 行，号数/规格行剔除 ' + docSizeOnly + ' 行，其中带价 ' + docSizeOnlyPriced + ' 行），可识别有单价行 ' + docPricedRows);

// ============================================================
// 打分：置信度 / 类型
// ============================================================
const rows = [];
for (const rec of acc.values()) {
  const inferred = inferProductType(rec.name);
  const typeText = inferred.type === 'tbd' ? '待定' : inferred.type;
  const kinds = Object.keys(rec.kinds).join('+');
  const files = rec.files.size;
  const pkg = topEntries(rec.packages, 1)[0]?.[0] ?? '';
  const variantTexts = topEntries(rec.variantTexts, 6).map(([k]) => k).join(' / ');
  // 置信度（可解释规则，写进摘要）：
  //   高 = 出现 ≥3 次且来自 ≥2 个文件；或出现 ≥2 次且类型已明确（非 tbd）
  //   中 = 出现 ≥2 次
  //   低 = 只出现 1 次
  let conf = '低';
  if (rec.count >= 2) conf = '中';
  if ((rec.count >= 3 && files >= 2) || (rec.count >= 2 && inferred.type !== 'tbd')) conf = '高';
  rows.push({
    name: rec.name,
    type: typeText,
    typeConfirmed: inferred.type !== 'tbd',
    typeReason: inferred.reason,
    packaging: pkg,
    count: rec.count,
    files,
    example: rec.examples[0] ?? '',
    examples: rec.examples,
    conf,
    kinds,
    recovered: rec.recovered,
    variantTexts,
    key: rec.key,
    token: rec.token,
    digits: digitSignature(rec.name),
    altWritings: [...rec.variants.keys()].filter((x) => x !== rec.name).length,
  });
}
rows.sort((a, b) => b.count - a.count || b.files - a.files || a.name.localeCompare(b.name));

// ============================================================
// 变体清单 —— 按甲方更正**重新分类**（只列疑点，绝不自动合并）
// ============================================================
// 甲方更正（最高优先级）：「0-GPN 和 00-GPN 是同一型号的不同尺寸」——
//   · 前导零 / 数字位 / 后缀号数 的差异 = **不同尺寸 = 不同产品**，绝不合并、各自建档；
//   · 只有「空格 / 全角半角 / 大小写 / 标点 / 同义描述（品牌前缀、包装、刻字）」的差异才可能是同一产品。
// 判定口径：分组仍用**宽松的候选分组指纹**（variantGroupFingerprint，只为把同族写法聚到一起），
//   分类则一律看 **数字指纹 digitSignature 是否逐字符一致**：全部一致 → A 类；出现 ≥2 种 → B 类。

/** 变体候选分组：先按服务端口径归一，去掉包装/标签/刻字等描述性后缀，再由 variantGroupFingerprint 聚组 */
function variantFingerprint(name) {
  let t = normalizeToken(name);
  t = t.replace(/(原装|使用|外箱|中箱|中盒|塑盒|塑料盒|尼龙袋|彩盒|不干胶|标签|包装|刻字|印刷|印上|madein[a-z]*|带连接器|连接器).*$/, '');
  return variantGroupFingerprint(t);
}
const groups = new Map();
for (const r of rows) {
  const fp = variantFingerprint(r.name);
  if (!fp || fp.length < 2) continue;
  if (!groups.has(fp)) groups.set(fp, []);
  groups.get(fp).push(r);
}

const A_TEXT = 'A 类·纯文本差异';
const B_SIZE = 'B 类·数字/尺寸差异';
const variantRows = [];      // 全量（带**组级**差异类别）
const variantGroups = [];    // 分组对象（供报告与拆分清单）
const aSubClusters = [];     // A 类：组内「同一数字指纹 + ≥2 种写法」的子簇（真正可合并的候选）
for (const [fp, list] of groups) {
  // 同一指纹下有 ≥2 种不同归一写法 → 才是「疑似同产品不同写法」
  if (new Set(list.map((x) => x.key)).size < 2) continue;
  // 组内按**数字指纹**分子簇：同一数字指纹 = 同一尺寸；≥2 个子簇 = 组内含不同尺寸
  const byDigits = new Map();
  for (const x of list) {
    if (!byDigits.has(x.digits)) byDigits.set(x.digits, []);
    byDigits.get(x.digits).push(x);
  }
  const isSizeDiff = byDigits.size >= 2;
  const cls = isSizeDiff ? B_SIZE : A_TEXT;
  // 组级建议标准名：只在 A 类（组内数字指纹全部一致）时给；B 类必须各自建档，不能给合并建议
  const best = list.slice().sort((a, b) => b.count - a.count || a.name.length - b.name.length)[0];
  const action = isSizeDiff
    ? '同型号不同尺寸（数字部分含前导零/位数/号数不一致）→ **不合并，各自建档**（甲方更正：0-GPN 与 00-GPN 是不同尺寸）'
    : ('纯文本差异（仅空格/全角半角/大小写/标点/描述性后缀）→ 可合并候选，建议标准名：' + best.name);
  variantGroups.push({
    fp, cls, isSizeDiff, action, suggested: isSizeDiff ? '' : best.name,
    digits: [...byDigits.keys()],
    writings: list.map((x) => ({ name: x.name, key: x.key, digits: x.digits, count: x.count, files: x.files, example: x.example })),
  });
  for (const x of list) {
    // 同一数字指纹 = 同一个「尺寸」→ 给一个「尺寸分组号」，便于甲方按尺寸各自建档
    variantRows.push([fp, cls, x.digits, fp + '#' + x.digits, x.name, x.key, x.count, x.files, x.example, action]);
  }
  // A 类子簇：数字指纹逐字符一致、但写法有 ≥2 种（纯文本差异）→ 可合并候选（**只给建议，不自动合并**）
  for (const [digits, sub] of byDigits) {
    if (sub.length < 2) continue;
    const std = sub.slice().sort((a, b) => b.count - a.count || a.name.length - b.name.length)[0];
    aSubClusters.push({ fp, digits, suggested: std.name, list: sub });
  }
}
variantRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[2]).localeCompare(String(b[2])) || b[6] - a[6]);
const aGroups = variantGroups.filter((g) => !g.isSizeDiff);
const bGroups = variantGroups.filter((g) => g.isSizeDiff);
const aRows = variantRows.filter((r) => r[1] === A_TEXT);
const bRows = variantRows.filter((r) => r[1] === B_SIZE);
const aSubRows = aSubClusters.flatMap((c) => c.list.map((x) => [c.fp, c.digits, x.name, x.count, x.files, x.example, c.suggested,
  '同尺寸（数字指纹逐字符一致）的纯文本差异 → 可合并候选，待人工确认（脚本不自动合并）']));

// ============================================================
// 审计：旧口径（只用 normalizeToken 去重）是否会把「不同尺寸」折叠成同一条？
// ============================================================
// 旧口径的候选去重键 = normalizeToken(name)；新口径 = productIdentityKey（多了数字指纹）。
// 凡是「文本归一相同、数字指纹不同」的写法，旧口径会折成一条候选 → 就是一次**尺寸合并**。
const byToken = new Map();
for (const r of rows) {
  if (!byToken.has(r.token)) byToken.set(r.token, []);
  byToken.get(r.token).push(r);
}
const sizeMerges = [...byToken.entries()]
  .map(([token, list]) => ({ token, list }))
  .filter((x) => x.list.length > 1)
  .map((x) => ({
    normalizeToken: x.token,
    names: x.list.map((r) => r.name),
    digitSignatures: x.list.map((r) => r.digits),
    counts: x.list.map((r) => r.count),
  }));
const mergedRowCount = sizeMerges.reduce((n, x) => n + x.names.length, 0);

// ============================================================
// 落盘
// ============================================================
const candFile = path.join(OUT_DIR, 'products_candidates.csv');
writeCsv(candFile,
  ['产品名称', '建议产品类型', '默认包装', '出现次数', '来源文件数', '来源示例文件', '置信度', '类型待人工确认', '类型推断依据', '来源构成', '疑似号数/规格', '列错位回填行数'],
  rows.map((r) => [r.name, r.type, r.packaging, r.count, r.files, r.example, r.conf, r.typeConfirmed ? '否' : '是', r.typeReason, r.kinds, r.variantTexts, r.recovered]));

const varFile = path.join(OUT_DIR, 'products_variants.csv');
writeCsv(varFile,
  ['分组指纹', '差异类别', '数字指纹（逐字符）', '尺寸分组号（B类用）', '写法', '产品同一性键', '出现次数', '来源文件数', '来源示例文件', '建议动作'],
  variantRows);

// 两类清单分别落盘（甲方要求：纯文本差异 vs 尺寸差异分开产出）
// A 类清单口径：**同一数字指纹（同一尺寸）下出现 ≥2 种写法** —— 这是真正「可合并」的集合；
//   注意：它会把「B 类组内某个尺寸的多种包装/刻字写法」也一并列出（那些确实是纯文本差异，可合并）。
//   组级 A 类（整个分组里数字指纹全部一致，见 products_variants.csv 的「差异类别」列）是它的子集。
const aFile = path.join(OUT_DIR, 'products_variants_A_文本差异.csv');
writeCsv(aFile,
  ['分组指纹', '数字指纹（逐字符）', '写法', '出现次数', '来源文件数', '来源示例文件', '建议合并后的标准名', '建议动作'],
  aSubRows);

const bFile = path.join(OUT_DIR, 'products_variants_B_尺寸差异.csv');
writeCsv(bFile,
  ['分组指纹', '数字指纹（逐字符）', '尺寸分组号', '写法', '出现次数', '来源文件数', '来源示例文件', '建议动作'],
  bRows.map((r) => [r[0], r[2], r[3], r[4], r[6], r[7], r[8], r[9]]));

// 审计清单落盘：旧口径会把哪些「不同尺寸」折叠成同一条候选
const mergeAuditFile = path.join(OUT_DIR, 'products_size_merge_audit.csv');
writeCsv(mergeAuditFile,
  ['旧口径归一形式', '会被折叠成一条的写法数', '各写法的数字指纹（逐字符）', '写法（出现次数）', '结论'],
  sizeMerges.flatMap((m) => m.names.map((n, i) => [m.normalizeToken, m.names.length, m.digitSignatures.join(' | '),
    n + '（' + m.counts[i] + ' 次）', '数字指纹不一致 → 旧口径属于尺寸合并；新口径各自建档'])));

const typeDist = {};
for (const r of rows) typeDist[r.type] = (typeDist[r.type] ?? 0) + 1;
const confDist = {};
for (const r of rows) confDist[r.conf] = (confDist[r.conf] ?? 0) + 1;
const kindDist = {};
for (const r of rows) kindDist[r.kinds] = (kindDist[r.kinds] ?? 0) + 1;
const tbdCount = rows.filter((r) => !r.typeConfirmed).length;

const summaryLines = [
  '产品建档候选抽取摘要（tools/ziliao/extract_products.mjs）',
  '=====================================================',
  '资料包根目录：' + ROOT,
  'Excel 总数 ' + scanned + '；其中「表头含单价列」合同 ' + contracts.length + ' 份（按顶层客户：' + JSON.stringify(byTop) + '）',
  '.doc 切片 ' + slices.length + ' 份 ' + JSON.stringify(kindCount) + '；切片产品行 ' + docRows + '（列错位回填 ' + recoveredRows + ' 行）',
  '合同产品行 ' + contractRows + '（噪声剔除 ' + contractNoise + ' 行）',
  '号数/规格行（品名只有 1~2 位数字或 #N，合并单元格残留）：合同 ' + contractSizeOnly + ' 行、切片 ' + docSizeOnly + ' 行（其中带价 ' + docSizeOnlyPriced + ' 行）',
  '  → 刻意剔除，理由见 lib/ziliao-extract.mjs isSizeOnlyName：既不可识别为产品，也不可作为报价（匹配上等于编造价格）',
  '',
  '去重键口径（2026 甲方更正）：**文本归一 + 数字指纹**（productIdentityKey）——',
  '  只做「空格 / 全角半角 / 大小写 / 标点」归一；数字部分含前导零、位数、号数**原样保留、逐字符比较**。',
  '  因此 0-GPN / 00-GPN / 000-GPN 是**同一型号的不同尺寸 → 三条独立候选**，绝不合并。',
  '去重后候选产品：' + rows.length + ' 条',
  '置信度分布：' + JSON.stringify(confDist),
  '来源构成分布：' + JSON.stringify(kindDist),
  '建议产品类型分布：' + JSON.stringify(typeDist),
  '类型待人工确认（推断不出 → tbd）：' + tbdCount + ' 条（' + (rows.length ? ((tbdCount / rows.length) * 100).toFixed(1) : '0') + '%）',
  '',
  '疑似同产品的不同写法（已按甲方更正**重新分类**）：' + variantGroups.length + ' 组 / ' + variantRows.length + ' 条',
  '  · A 类·纯文本差异（组内数字指纹全部一致：仅空格/全角半角/大小写/标点/描述性后缀）：' + aGroups.length + ' 组 / ' + aRows.length + ' 条',
  '  · B 类·数字/尺寸差异（组内出现 ≥2 种数字指纹：前导零、数字位、后缀号数不同）→ **同型号不同尺寸，不合并，各自建档**：' + bGroups.length + ' 组 / ' + bRows.length + ' 条',
  '  · 另附 A 类可合并候选子簇（同一数字指纹 + ≥2 种写法，含 B 类组内同尺寸的多种包装/刻字写法）：' + aSubClusters.length + ' 簇 / ' + aSubRows.length + ' 条',
  '  清单：products_variants_A_文本差异.csv（可合并候选，附建议标准名，**未自动合并**）/ products_variants_B_尺寸差异.csv（各自建档）',
  '',
  '尺寸合并审计（旧口径只用 normalizeToken 去重，会把「文本归一相同但数字指纹不同」的写法折成一条）：',
  '  · 被旧口径折叠的归一形式：' + sizeMerges.length + ' 种 / 涉及写法 ' + mergedRowCount + ' 条',
  '  · 新口径（文本归一 + 数字指纹）已全部拆开 → 候选数 ' + rows.length + ' 条（旧口径会是 ' + (rows.length - mergedRowCount + sizeMerges.length) + ' 条）',
  '  · 明细见 products_size_merge_audit.csv',
  '',
  '出现次数 Top 30：',
  ...rows.slice(0, 30).map((r) => '  ' + String(r.count).padStart(5) + '  ' + r.files + ' 文件  ' + r.conf + '  ' + r.type.padEnd(13) + '  ' + r.name),
  '',
  '类型推断口径（只认字面证据，缺一轴即 tbd）：',
  '  气体轴：乙炔/acetylene → acetylene；丙烷/propane/LPG → propane',
  '  地域轴：英式/UK/ANM/PNM → uk；美式/US/USA/MADE IN USA/6290/101 → us',
  '  两轴齐 → uk_acetylene / uk_propane / us_acetylene / us_propane；否则 tbd（待人工确认）',
];
fs.writeFileSync(path.join(OUT_DIR, 'products_candidates_summary.txt'), summaryLines.join('\r\n') + '\r\n', 'utf8');

// 历史成交价行落盘（供任务二直接复用，避免再解析一遍）
const priceFile = path.join(OUT_DIR, 'contract_price_rows.json');
fs.writeFileSync(priceFile, JSON.stringify({ generatedAt: new Date().toISOString(), count: priceRows.length, rows: priceRows }, null, 1), 'utf8');

const report = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  excel: { scanned, priceContracts: contracts.length, byTop },
  docSlices: { files: slices.length, byKind: kindCount, productRows: docRows, recoveredRows, pricedRows: docPricedRows },
  contract: { productRows: contractRows, noiseSkipped: contractNoise },
  candidates: rows.length,
  confidence: confDist,
  typeDistribution: typeDist,
  typeTbd: tbdCount,
  variantGroups: variantGroups.length,
  variantRows: variantRows.length,
  variantClass: {
    aText: { groups: aGroups.length, rows: aRows.length },
    bSize: { groups: bGroups.length, rows: bRows.length },
    aTextSubClusters: { clusters: aSubClusters.length, rows: aSubRows.length },
  },
  sizeMergeAudit: { foldedNormalizedForms: sizeMerges.length, affectedWritings: mergedRowCount, samples: sizeMerges.slice(0, 50) },
  excluded: { sizeOnlyContract: contractSizeOnly, sizeOnlyDoc: docSizeOnly, sizeOnlyDocPriced: docSizeOnlyPriced, noiseContract: contractNoise, samples: { sizeOnly: sizeOnlySamples, noise: noiseSamples } },
  outputs: {
    candidates: candFile, variants: varFile,
    variantsA: aFile, variantsB: bFile, sizeMergeAudit: mergeAuditFile,
    priceRows: priceFile,
  },
  top: rows.slice(0, 200),
};
fs.writeFileSync(path.join(OUT_DIR, 'products_extract_report.json'), JSON.stringify(report, null, 1), 'utf8');

console.log('');
console.log('================ 产品建档候选抽取汇总 ================');
console.log('候选产品 ' + rows.length + ' 条（置信度 ' + JSON.stringify(confDist) + '）');
console.log('建议类型分布 ' + JSON.stringify(typeDist) + '　其中待人工确认 ' + tbdCount + ' 条');
console.log('疑似同产品的不同写法 ' + variantGroups.length + ' 组 / ' + variantRows.length + ' 条（未合并）');
console.log('  · A 类·纯文本差异（组内数字指纹全一致）' + aGroups.length + ' 组 / ' + aRows.length + ' 条');
console.log('  · B 类·数字/尺寸差异（不合并，各自建档）' + bGroups.length + ' 组 / ' + bRows.length + ' 条');
console.log('  · A 类可合并候选子簇（同尺寸多种写法）' + aSubClusters.length + ' 簇 / ' + aSubRows.length + ' 条');
console.log('尺寸合并审计：旧口径会折叠 ' + sizeMerges.length + ' 种归一形式 / ' + mergedRowCount + ' 条写法 → 新口径已全部拆开');
console.log('产出：');
console.log('  ' + candFile);
console.log('  ' + varFile);
console.log('  ' + aFile);
console.log('  ' + bFile);
console.log('  ' + mergeAuditFile);
console.log('  ' + path.join(OUT_DIR, 'products_candidates_summary.txt'));
console.log('  ' + priceFile + '（历史成交价行 ' + priceRows.length + ' 条，供任务二）');
