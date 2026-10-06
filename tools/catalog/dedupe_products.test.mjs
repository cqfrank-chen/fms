/**
 * 去重合并判定 · 单元测试（零依赖，node:test）
 * =============================================================================
 * 运行：node --test tools/catalog/dedupe_products.test.mjs
 *
 * 覆盖（对应任务书「自测 1」）：
 *   ① 写法等价判定：0-1-101 ≡ 1-101 割嘴 0# ≡ 1-101 size0（同一产品）
 *   ② 不同 size 绝不合并：00-1-101 ≠ 0-1-101；1-101 #1 ≠ #0；0/00/000-GPN 三档
 *   ③ 分组正确性：合成数据 + **真实 1444 条产品名**（product_anchor.csv）逐项比对
 *   ④ 存活记录选择规则：完整度打分 → id 最小
 *   ⑤ 类型以目录为准：ACE→ACETYLENE、LPG→LPG；款式映射不到 → tbd（不臆造）
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildModelIndex } from './lib/product-model.mjs';
import { deriveProductType, typeDerivable } from './lib/catalog-type.mjs';
import {
  canonicalName, dedupeKeyOf, planDedupe, pickSurvivor, richness, targetOf,
} from './lib/dedupe-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cat = JSON.parse(readFileSync(path.join(__dirname, 'catalog_models.json'), 'utf8'));
const idx = buildModelIndex(cat);

/** 产品名 → 去重键（null = 不参与合并） */
const key = (name) => dedupeKeyOf(targetOf(name, idx));

// =====================================================================================
// ① 写法等价：同一「基础型号 + size」的不同写法 → 同一个去重键
// =====================================================================================
test('写法等价：0-1-101 ≡ 1-101 割嘴 0# ≡ 1-101 size0 ≡ 1-101 #0 ≡ 1-101-0（型号 1-101 / size 0）', () => {
  const forms = ['0-1-101', '1-101 割嘴 0#', '1-101 size0', '1-101 size 0', '1-101 0#', '1-101 #0',
    '1-101-0', '割嘴 1-101 #0 仿包装', '乙炔割嘴 1-101 #0 84.5g'];
  for (const f of forms) {
    const t = targetOf(f, idx);
    assert.equal(t.catalog_model, '1-101', f + ' → 型号应为 1-101');
    assert.equal(t.size_spec, '0', f + ' → size 应为 0');
    assert.equal(key(f), '1-101 0', f + ' → 去重键应为 1-101 0');
  }
  // 9 种写法归一到**同一个键** → 合并后就是一条档案
  assert.equal(new Set(forms.map(key)).size, 1);
});

test('写法等价：# 号前后的数字、型号前后的数字都是同一个 size', () => {
  assert.equal(key('106 #1'), key('106 1#'));
  assert.equal(key('106 #1'), '106 1');
  assert.equal(key('割嘴 6290-1# 产品号码6010'), key('6290-1'));
  assert.equal(key('HARRIS 丙烷割嘴6290-NX-0 53g'), key('6290NX-0'));
  assert.equal(key('1-GPN'), key('GPN-1'));
});

// =====================================================================================
// ② 不同 size 绝不合并（甲方最高优先级安全口径）
// =====================================================================================
test('00-1-101 ≠ 0-1-101（前导零是不同尺寸，绝不合并）', () => {
  assert.equal(key('0-1-101'), '1-101 0');
  assert.equal(key('00-1-101'), '1-101 00');
  assert.equal(key('000-1-101'), '1-101 000');
  assert.notEqual(key('00-1-101'), key('0-1-101'));
  assert.notEqual(key('000-1-101'), key('00-1-101'));
});

test('1-101 #1 ≠ #0；1-101 size0 ≠ 1-101 size1', () => {
  assert.notEqual(key('1-101 #1'), key('1-101 #0'));
  assert.notEqual(key('1-101 size0'), key('1-101 size1'));
  assert.equal(key('1-101 #1'), '1-101 1');
});

test('0-GPN / 00-GPN / 000-GPN 是三档不同 size（各自独立档案）', () => {
  assert.deepEqual([key('0-GPN'), key('00-GPN'), key('000-GPN')], ['GPN 0', 'GPN 00', 'GPN 000']);
  assert.equal(new Set([key('0-GPN'), key('00-GPN'), key('000-GPN')]).size, 3);
});

test('无法定死 size / 未锚定目录 → 键为 null（保持现状，绝不猜）', () => {
  assert.equal(key('1-101'), null);          // 只写型号没写尺寸
  assert.equal(key('GPN'), null);
  assert.equal(key('割嘴 1-GPN 2#'), null);  // 型号前后数字冲突 = 尺寸歧义
  assert.equal(key('106HC-2'), null);        // 目录里没有 106HC
  assert.equal(key('1380'), null);           // 货号不得被当成 138 的 size 0
  assert.equal(key('4154'), null);
  assert.equal(key('1-101 size 9'), null);   // 9 不在目录档位 → 整个候选作废
  assert.equal(key('1-101 size 99'), null);
});

// =====================================================================================
// ③ 分组正确性：合成数据
// =====================================================================================
const row = (id, name, extra = {}) => ({ id, name, type: 'tbd', default_packaging: null, default_routing: null, safety_stock: 0, ...extra });

test('planDedupe：同键归一组、不同 size 不同组、未锚定/未写尺寸不进组', () => {
  const rows = [
    row(1, '0-1-101'), row(2, '1-101 割嘴 0#'), row(3, '1-101 size0'),   // 组 A：1-101 size 0（3 条 → 合并 2 条）
    row(4, '00-1-101'),                                                    // 组 B：1-101 size 00（独立）
    row(5, '0-1-101'),                                                     // 与 1 同键 → 也进组 A
    row(6, '1-101'),                                                       // 没写 size → 不进组
    row(7, '106HC-2'),                                                     // 未锚定 → 不进组
  ];
  const { stat, groups, mergeGroups, singleGroups } = planDedupe(rows, idx);
  assert.equal(stat.total, 6 + 1);
  assert.equal(stat.unmatched, 1);
  assert.equal(stat.sizeUnknown, 1);
  assert.equal(groups.size, 2);                 // 1-101 0 与 1-101 00
  assert.equal(mergeGroups.length, 1);          // 只有 size 0 那一组是多条
  assert.equal(singleGroups.length, 1);         // size 00 只有一条
  assert.equal(mergeGroups[0].key, '1-101 0');
  assert.deepEqual(mergeGroups[0].merged.map((m) => m.row.id).sort((a, b) => a - b), [2, 3, 5]);
  assert.equal(mergeGroups[0].survivor.row.id, 1);   // 完整度相同 → id 最小者存活
});

test('planDedupe：组与组之间绝不串 size（0/00/000 各自成组）', () => {
  const rows = [row(1, '0-GPN'), row(2, '00-GPN'), row(3, '000-GPN'), row(4, 'GPN-1'), row(5, '1-GPN')];
  const { groups, mergeGroups, singleGroups } = planDedupe(rows, idx);
  assert.deepEqual([...groups.keys()].sort(), ['GPN 0', 'GPN 00', 'GPN 000', 'GPN 1']);
  assert.equal(mergeGroups.length, 1);
  assert.equal(mergeGroups[0].key, 'GPN 1');          // 只有 GPN size 1 是两条
  assert.deepEqual(mergeGroups[0].merged.map((m) => m.row.id), [5]);
  assert.equal(singleGroups.length, 3);
});

// =====================================================================================
// ④ 存活记录选择规则：完整度（type 具体 +2 / 默认包装 +1 / 工序路线 +1 / 安全库存>0 +1）→ id 最小
// =====================================================================================
test('richness + pickSurvivor：字段最全优先，其次 id 最小', () => {
  const a = { row: row(9, '1-GPN', { type: 'tbd' }), richness: 0 };
  const b = { row: row(20, 'GPN-1', { type: 'us_propane', default_packaging: '塑料盒' }), richness: 0 };
  a.richness = richness(a.row);
  b.richness = richness(b.row);
  assert.equal(a.richness, 0);
  assert.equal(b.richness, 3);                   // type 具体 +2、默认包装 +1
  assert.equal(pickSurvivor([a, b]).row.id, 20); // 完整度高的存活（即便 id 更大）

  const c = { row: row(30, 'GPN-1', { type: 'us_propane' }) };
  const d = { row: row(31, '1-GPN', { type: 'us_propane' }) };
  c.richness = richness(c.row);
  d.richness = richness(d.row);
  assert.equal(c.richness, d.richness);
  assert.equal(pickSurvivor([d, c]).row.id, 30); // 同完整度 → id 小者存活
});

// =====================================================================================
// ⑤ 类型以目录为准
// =====================================================================================
test('deriveProductType：美式/英式 × 乙炔/丙烷落到既有枚举；其余款式保持 tbd（不臆造）', () => {
  assert.equal(deriveProductType('AMERICAN STYLE CUTTING TIP', 'ACETYLENE'), 'us_acetylene');
  assert.equal(deriveProductType('AMERICAN STYLE CUTTING TIP', 'LPG'), 'us_propane');
  assert.equal(deriveProductType('BRITISH STYLE CUTTING TIP', 'ACETYLENE'), 'uk_acetylene');
  assert.equal(deriveProductType('BRITISH STYLE CUTTING TIP', 'LPG'), 'uk_propane');
  for (const s of ['JAPANESE STYLE CUTTING TIP', 'FRENCH STYLE CUTTING TIP', 'AUSTRALIAN STYLE CUTTING TIP', 'BRAZILIAN STYLE CUTTING TIP']) {
    assert.equal(deriveProductType(s, 'ACETYLENE'), 'tbd', s);
    assert.equal(deriveProductType(s, 'LPG'), 'tbd', s);
    assert.equal(typeDerivable(s, 'LPG'), false);
  }
  assert.equal(deriveProductType(null, 'LPG'), 'tbd');
  assert.equal(deriveProductType('AMERICAN STYLE CUTTING TIP', null), 'tbd');
});

test('targetOf：matched 行的类型严格由目录（系列 + 气体）推出，与名字里的「乙炔/丙烷」字样无关', () => {
  // 名字里写「丙烷」但目录是 AMERICAN + ACE（1-101 FOR ACE）→ 仍按目录判成 us_acetylene
  const t = targetOf('丙烷割嘴 1-101 1#', idx);
  assert.equal(t.series, 'AMERICAN STYLE CUTTING TIP');
  assert.equal(t.gas_type, 'ACETYLENE');
  assert.equal(t.type, 'us_acetylene');
  // 日式款式的类型落不到既有枚举 → tbd（并保留系列 / 气体，供人工裁定）
  const j = targetOf('106 1#', idx);
  assert.equal(j.series, 'JAPANESE STYLE CUTTING TIP');
  assert.equal(j.type, 'tbd');
});

test('canonicalName：目录标准名 = 「型号 size#」（仅 --canonical-name 开关使用）', () => {
  assert.equal(canonicalName('1-101', '0'), '1-101 0#');
  assert.equal(canonicalName('GPN', '000'), 'GPN 000#');
  assert.equal(canonicalName('GPN', null), 'GPN');
});

// =====================================================================================
// ③b 分组正确性：**真实 1444 条产品名**（与本地库 / 云端同一批候选）
// =====================================================================================
/** 取 CSV 第一列（产品名）——字段可能被双引号包住，做最小合规解析 */
function firstColumn(file) {
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const out = [];
  let i = 0;
  while (i < text.length) {
    let val = '';
    if (text[i] === '"') {
      i += 1;
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') { val += '"'; i += 2; continue; }
        if (text[i] === '"') { i += 1; break; }
        val += text[i]; i += 1;
      }
    } else {
      while (i < text.length && text[i] !== ',') { val += text[i]; i += 1; }
    }
    out.push(val);
    while (i < text.length && text[i] !== '\n') i += 1;   // 跳到行尾
    i += 1;
  }
  return out;
}

test('真实 1444 条产品名：分组统计与逐条判定（与本地库实跑一致）', () => {
  const names = firstColumn(path.join(__dirname, 'product_anchor.csv'));
  const rows = names.slice(1).filter((n) => n !== '').map((name, i) => row(i + 1, name));
  assert.equal(rows.length, 1444, '产品候选应为 1444 条');

  const { stat, groups, mergeGroups, singleGroups } = planDedupe(rows, idx);
  assert.equal(stat.matched, 1046);
  assert.equal(stat.matchedSized, 993);
  assert.equal(stat.sizeUnknown, 53);
  assert.equal(stat.unmatched, 398);
  assert.equal(groups.size, 191, '可合并分组（型号+尺寸）应为 191 组');
  assert.equal(mergeGroups.length, 145, '组内多于一条的应为 145 组');
  assert.equal(singleGroups.length, 46);
  assert.equal(mergeGroups.reduce((s, g) => s + g.merged.length, 0), 802, '待合并档案应为 802 条');
  assert.equal(stat.total - 802, 642, '合并后应为 642 条');

  // 组内成员必须**同型号同 size**，且不同 size 不共组
  for (const g of mergeGroups) {
    const keys = new Set([g.survivor, ...g.merged].map((m) => m.key));
    assert.equal(keys.size, 1, '合并组内只能有一个键：' + g.key);
    assert.equal(keys.has(g.key), true);
    assert.match(g.key, /^\S+ \S+$/);
  }
  // GPN 的 0 / 00 / 000 三档在真实数据里是**三个互不相同的组**（组内自查过 size 唯一），
  // 每个组各自合并成一条 —— 前导零三档绝不互相合并。
  for (const [k, size] of [['GPN 0', '0'], ['GPN 00', '00'], ['GPN 000', '000']]) {
    const members = groups.get(k);
    assert.ok(members && members.length >= 1, '应有分组：' + k);
    assert.deepEqual([...new Set(members.map((m) => m.target.size_spec))], [size], k + ' 组内 size 必须唯一且为 ' + size);
  }
  // 组内绝无「跨 size」：把所有组成员展开，同组内 size 唯一
  for (const [k, members] of groups) {
    const sizes = new Set(members.map((m) => m.target.size_spec));
    assert.equal(sizes.size, 1, '同一组内 size 必须唯一：' + k);
  }
});
