#!/usr/bin/env node
/**
 * 「文件夹=客户」清单生成器（**纯 Node、零第三方依赖**，不需要 python）
 * =====================================================================================
 * 甲方裁定：「以文件夹为识别主体，同一文件夹内的，都是同一家的」。本脚本严格照此产出：
 *   ① customer_folders.csv            客户清单：**顶层客户文件夹**（客户名 = 文件夹名），供同步脚本导入客户主数据
 *   ② pack_template_candidates.csv    包装（唛头）模板候选：客户列 = 顶层客户文件夹，内容 = 去重后的唛头正文
 *   ③ subfolder_reference.csv         二级条目备查清单（**只备查、不导入**，不是客户）
 *   ④ folder_lists_summary.txt        人读摘要
 *
 * 不做的事（避免臆造）：
 *   · 不读合同抬头取客户名（客户只来自文件夹名）；
 *   · 不做任何跨文件夹合并 / 别名归一；
 *   · 本厂（供方）名称绝不进客户清单。
 *
 * .doc 正文抽取用同目录的 doc-text.mjs（自研零依赖 Word97/CFB + docx 抽取器），
 * 因此本脚本对 python 与本目录的 JSONL 缓存**均无依赖**。
 *
 * 用法：
 *   node tools/ziliao/build_folder_lists.mjs                        # 默认读 D:/futures/ziliao-data，输出到 tools/ziliao/
 *   node tools/ziliao/build_folder_lists.mjs --root <解压目录> --outdir <输出目录>
 *
 * 产出后可直接同步（FMS_BASE 指向云端）：
 *   node tools/ziliao/sync_folder_data.mjs \
 *     --customers tools/ziliao/customer_folders.csv \
 *     --packs tools/ziliao/pack_template_candidates.csv
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractText, md5Hex, uniqLines } from './doc-text.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('--root', 'D:/futures/ziliao-data'));
const OUTDIR = path.resolve(arg('--outdir', __dirname));

const MARK = /唛|标贴|不干胶|贴纸|彩卡|彩盒|正唛|侧唛|标签/;
const CONTRACT_WORD = /采购单|生产计划单|供需合同|订购|订单/;
const OTHER_DOC = /库存|对账|送货单/;
const INC_PIC = /INCLUDEPICTURE/i;
/** 供方（本厂）名称：只用于输出校验提示，确保这些名字不会出现在客户清单里 */
const SUPPLIER_HINTS = ['一洲', '维克工具厂'];

/** 路径 → 片段列表：去掉空段与可能存在的 ziliao/ 外壳层 */
function normParts(rel) {
  let parts = String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length && parts[0] === 'ziliao') parts = parts.slice(1);
  return parts;
}

/**
 * 递归遍历：返回目录集合与文件清单（只统计顶层客户文件夹之内的条目）。
 *
 * **遍历顺序必须等价于 python 的 os.walk + sorted(filenames)**：
 * 因为「同一客户下同名唛头文件」要靠 -2/-3 后缀区分，谁先被遍历到谁拿不带后缀的名字，
 * 顺序一变，模板名与内容的对应关系就会整体错位（实测会导致 4 条名字互换、32 条内容互换）。
 * os.walk 的语义 = 先产出「本目录的文件」，再按目录项顺序递归子目录；scan_texts.py 对文件名做了 sorted。
 */
function walk(root) {
  const dirs = new Set();
  const files = [];
  const visit = (absDir, relDir) => {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    const subdirs = [];
    const fileNames = [];
    for (const e of entries) {
      if (e.isDirectory()) subdirs.push(e.name);
      else if (e.isFile()) fileNames.push(e.name);
    }
    fileNames.sort(); // scan_texts.py: for f in sorted(fn)
    for (const name of fileNames) {
      const childAbs = path.join(absDir, name);
      const childRel = relDir ? relDir + '/' + name : name;
      const parts = normParts(childRel);
      if (parts.length < 2) continue; // 客户文件夹之外的东西（如 _manifest.csv）不参与
      let size = 0;
      try { size = fs.statSync(childAbs).size; } catch { size = 0; }
      const ext = path.extname(name).slice(1).toLowerCase();
      files.push({ parts, rawRel: childRel, ext, size, abs: childAbs, base: name, stem: path.basename(name, path.extname(name)) });
    }
    for (const d of subdirs) {
      const childRel = relDir ? relDir + '/' + d : d;
      const dp = normParts(childRel);
      if (dp.length) dirs.add(dp.join('/'));
      visit(path.join(absDir, d), childRel);
    }
  };
  visit(root, '');
  return { dirs, files };
}

/** CSV 单元格转义（Python csv QUOTE_MINIMAL 口径） */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 写 CSV：UTF-8 BOM + CRLF（与 python 版一致，Excel 可直接双击打开） */
function writeCsv(file, headers, rows) {
  const out = ['\ufeff' + headers.map(csvCell).join(',')];
  for (const r of rows) out.push(headers.map((h) => csvCell(r[h])).join(','));
  fs.writeFileSync(file, out.join('\r\n') + '\r\n', 'utf8');
  return rows.length;
}

function main() {
  if (!fs.existsSync(ROOT)) {
    console.error('资料包根目录不存在：' + ROOT);
    process.exit(2);
  }
  fs.mkdirSync(OUTDIR, { recursive: true });
  console.log('资料包根目录：' + ROOT);
  console.log('输出目录：' + OUTDIR);

  const { dirs, files } = walk(ROOT);

  // ---------- ① 客户清单：顶层文件夹 ----------
  const topFiles = new Map();
  const topSize = new Map();
  const topExt = new Map();
  for (const f of files) {
    const top = f.parts[0];
    topFiles.set(top, (topFiles.get(top) || 0) + 1);
    topSize.set(top, (topSize.get(top) || 0) + f.size);
    if (!topExt.has(top)) topExt.set(top, new Map());
    const m = topExt.get(top);
    m.set(f.ext, (m.get(f.ext) || 0) + 1);
  }

  // 二级条目 = 「顶层客户/第二段名字」；来源三处（与 python 版分列口径一致）
  const subKind = new Map();
  for (const d of dirs) {
    const parts = d.split('/');
    if (parts.length === 2) subKind.set(parts[0] + '\u0000' + parts[1], '二级子文件夹');
  }
  const subFiles = new Map();
  const subSize = new Map();
  for (const f of files) {
    const p = f.parts;
    let key;
    if (p.length >= 3) key = p[0] + '\u0000' + p[1];
    else if (p.length === 2) { key = p[0] + '\u0000' + p[1]; if (!subKind.has(key)) subKind.set(key, '客户目录直属文件'); }
    else continue;
    if (!subKind.has(key)) subKind.set(key, '二级子文件夹');
    subFiles.set(key, (subFiles.get(key) || 0) + 1);
    subSize.set(key, (subSize.get(key) || 0) + f.size);
  }

  const customers = [...topFiles.keys()]
    .sort((a, b) => topFiles.get(b) - topFiles.get(a))
    .map((top) => {
      const subs = [...subKind.keys()].filter((k) => k.split('\u0000')[0] === top && subKind.get(k) === '二级子文件夹').length;
      const ext = topExt.get(top) || new Map();
      const excel = (ext.get('xls') || 0) + (ext.get('xlsx') || 0);
      const word = (ext.get('doc') || 0) + (ext.get('docx') || 0);
      return {
        '客户名称': top,
        '来源': '顶层客户文件夹名（文件夹=客户）',
        '文件数': topFiles.get(top),
        // toFixed(1)：与 python round(x, 1) 的写出形式一致（整数也保留 .0，保证与 python 版字节一致）
        '体积MB': ((topSize.get(top) || 0) / 1048576).toFixed(1),
        '二级子文件夹数': subs,
        'Excel份数': excel,
        'Word份数': word,
        '待确认项': '客户名按甲方裁定取文件夹名；合同抬头「需方」全称仅作一致性校验，不覆盖客户名、不合并',
      };
    });

  const custPath = path.join(OUTDIR, 'customer_folders.csv');
  const nCust = writeCsv(custPath, ['客户名称', '来源', '文件数', '体积MB', '二级子文件夹数', 'Excel份数', 'Word份数', '待确认项'], customers);

  // ---------- ② 二级条目备查清单（不导入） ----------
  const subRows = [...subKind.keys()]
    .sort((a, b) => {
      const ka = subKind.get(a), kb = subKind.get(b);
      if (ka !== kb) return ka < kb ? -1 : 1;
      const [ta, sa] = a.split('\u0000'); const [tb, sb] = b.split('\u0000');
      if (ta !== tb) return ta < tb ? -1 : 1;
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    })
    .map((k) => {
      const [top, sub] = k.split('\u0000');
      return {
        '顶层客户文件夹': top,
        '二级条目': sub,
        '类型': subKind.get(k),
        '文件数': subFiles.get(k) || 0,
        '体积MB': ((subSize.get(k) || 0) / 1048576).toFixed(1),
        '用途': '订单批次/项目标签候选（**不是客户**，不导入客户表）',
      };
    });
  writeCsv(path.join(OUTDIR, 'subfolder_reference.csv'),
    ['顶层客户文件夹', '二级条目', '类型', '文件数', '体积MB', '用途'], subRows);

  // ---------- ③ 包装（唛头）模板候选 ----------
  const candidates = files.filter((f) => (f.ext === 'doc' || f.ext === 'docx') && MARK.test(f.base));
  console.log('唛头候选文档（文件名命中）: ' + candidates.length + ' 份，开始抽取正文…');
  const packs = [];
  const seen = new Set();
  const usedNames = new Set();
  let extractFail = 0;
  for (const f of candidates) {
    let r;
    try { r = extractText(f.abs); } catch { extractFail += 1; continue; }
    if (!r || !r.chars) continue;
    if (INC_PIC.test(r.text)) continue; // 图文混排：正文只剩 INCLUDEPICTURE（临时 png 已丢失）→ 需视觉识别，不入库
    const content = uniqLines(r.text).join('\n').trim();
    if (content.length < 2) continue;
    if (CONTRACT_WORD.test(content) || OTHER_DOC.test(content) || content.length > 400) continue;
    const top = f.parts[0];
    const key = top + '\u0000' + content.replace(/\s+/g, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // 模板名：客户文件夹前缀 + 文件名词干，并保证同一批内唯一（跨二级目录常撞名）
    let baseName = top + '-' + f.stem;
    if (baseName.length > 76) baseName = baseName.slice(0, 69) + '-' + md5Hex(f.rawRel).slice(0, 6);
    let tplName = baseName;
    let k = 2;
    while (usedNames.has(tplName)) {
      tplName = baseName.slice(0, 76 - String(k).length - 1) + '-' + k;
      k += 1;
    }
    usedNames.add(tplName);
    packs.push({
      '客户文件夹': top,
      '模板名': tplName,
      'label内容': content.slice(0, 500),
      '字符数': r.chars,
      '来源文件': f.rawRel,
    });
  }
  packs.sort((a, b) => {
    if (a['客户文件夹'] !== b['客户文件夹']) return a['客户文件夹'] < b['客户文件夹'] ? -1 : 1;
    return a['模板名'] < b['模板名'] ? -1 : a['模板名'] > b['模板名'] ? 1 : 0;
  });
  const packPath = path.join(OUTDIR, 'pack_template_candidates.csv');
  const nPack = writeCsv(packPath, ['客户文件夹', '模板名', 'label内容', '字符数', '来源文件'], packs);

  // ---------- ④ 摘要 ----------
  const L = [];
  L.push('== 口径：文件夹=客户（甲方裁定）==');
  L.push('客户（顶层文件夹）: ' + customers.length + ' 家');
  for (const c of customers) {
    L.push('  ' + c['客户名称'] + '  文件 ' + c['文件数'] + '  二级子文件夹 ' + c['二级子文件夹数'] + '  Excel ' + c['Excel份数'] + '  Word ' + c['Word份数']);
  }
  const nDir = subRows.filter((r) => r['类型'] === '二级子文件夹').length;
  const nFile = subRows.filter((r) => r['类型'] === '客户目录直属文件').length;
  L.push('');
  L.push('二级条目（备查，不导入）: ' + subRows.length + ' 个 = 二级子文件夹 ' + nDir + ' + 客户目录直属文件 ' + nFile);
  const byTop = new Map();
  for (const r of subRows) if (r['类型'] === '二级子文件夹') byTop.set(r['顶层客户文件夹'], (byTop.get(r['顶层客户文件夹']) || 0) + 1);
  for (const [k, v] of [...byTop.entries()].sort((a, b) => b[1] - a[1])) L.push('  ' + k + ' 二级子文件夹 ' + v);
  L.push('');
  L.push('包装（唛头）模板候选: ' + packs.length + ' 条');
  const bp = new Map();
  for (const p of packs) bp.set(p['客户文件夹'], (bp.get(p['客户文件夹']) || 0) + 1);
  for (const [k, v] of [...bp.entries()].sort((a, b) => b[1] - a[1])) L.push('  ' + k + ' ' + v);
  L.push('');
  L.push('== 供方（本厂）名称：绝不进客户表 ==');
  for (const h of SUPPLIER_HINTS) {
    const hit = customers.filter((c) => c['客户名称'].includes(h)).map((c) => c['客户名称']);
    L.push('  ' + h + ' 命中客户清单: ' + (hit.length ? hit.join('、') : '无 ✅'));
  }
  L.push('');
  L.push('前 5 条模板：');
  for (const p of packs.slice(0, 5)) {
    L.push('  ▸ ' + p['模板名']);
    L.push('      内容: ' + p['label内容'].replace(/\n/g, ' / ').slice(0, 110));
    L.push('      来源: ' + p['来源文件']);
  }
  fs.writeFileSync(path.join(OUTDIR, 'folder_lists_summary.txt'), L.join('\n'), 'utf8');

  console.log('');
  console.log('customers=' + nCust + ' subfolders=' + subRows.length + ' packs=' + nPack
    + (extractFail ? '（抽取失败 ' + extractFail + ' 份，已跳过）' : ''));
  console.log('customer_folders.csv          → ' + custPath);
  console.log('pack_template_candidates.csv  → ' + packPath);
  console.log('');
  console.log('下一步（FMS_BASE 指向云端）：');
  console.log('  node tools/ziliao/sync_folder_data.mjs --customers tools/ziliao/customer_folders.csv --packs tools/ziliao/pack_template_candidates.csv');
}

main();
