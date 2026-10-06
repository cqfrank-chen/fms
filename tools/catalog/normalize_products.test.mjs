/**
 * 产品名归一 / 型号提炼 / 归位（默认包装 · 备注）单元测试（零依赖，不连库）
 * =============================================================================
 * 验的是「判定」，不是「写库」—— 判定错了是数据事故，必须在纯函数层被测住。
 * 运行：node --test tools/catalog/normalize_products.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModelIndex, withModelAliases } from './lib/product-model.mjs';
import {
  canonicalProductName, extractExtras, mergeRemark, planNormalize, splitFragments,
} from './lib/normalize-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cat = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog_models.json'), 'utf8'));
const idx = buildModelIndex(cat);

/** 造一条产品行（只给判定需要的列） */
const row = (id, name, extra = {}) => ({
  id, name, type: 'tbd', catalog_model: null, size_spec: null, series: null, gas_type: null,
  orifice_mm: null, thickness_range: null, catalog_anchor: null, catalog_note: null,
  default_packaging: null, default_routing: null, safety_stock: 0, remark: null, legacy_name: null,
  ...extra,
});

const one = (name) => {
  const plan = planNormalize([row(1, name)], idx);
  return plan.entries[0];
};
const canonicalOf = (name) => one(name).canonical;

test('命名规则：261 割嘴 0# → 0-261（甲方样例）', () => {
  const e = one('261 割嘴 0#');
  assert.equal(e.canonical, '0-261');
  assert.equal(e.parse.model, '261');
  assert.equal(e.parse.size, '0');
});

test('命名规则：1-101 割嘴 0# 与 0-1-101 → 都是 0-1-101（同一条）', () => {
  assert.equal(canonicalOf('1-101 割嘴 0#'), '0-1-101');
  assert.equal(canonicalOf('0-1-101'), '0-1-101');
  assert.equal(canonicalOf('1-101 size0'), '0-1-101');
  assert.equal(canonicalOf('乙炔割嘴 1-101 #0'), '0-1-101');
});

test('命名规则：size 用目录原值，不补零不删零（000-3-101 / 00-3-101 / 0-3-101 各不相同）', () => {
  assert.equal(canonicalOf('000-3-101'), '000-3-101');
  assert.equal(canonicalOf('00-3-101'), '00-3-101');
  assert.equal(canonicalOf('0-3-101'), '0-3-101');
});

test('不同 size 绝不合并（0 / 00 / 000 分成三组）', () => {
  const plan = planNormalize([row(1, '0-1-101'), row(2, '00-1-101'), row(3, '000-1-101')], idx);
  assert.equal(plan.merges.length, 0);
  assert.deepEqual(plan.survivors.map((s) => s.key), ['1-101 0', '1-101 00', '1-101 000']);
});

test('型号提炼后再次去重：同 (model,size) 不同写法合并为一条', () => {
  const plan = planNormalize([
    row(1, '0-1-101', { default_packaging: '塑料盒' }),
    row(2, '乙炔割嘴 1-101 0# 产品号码6023'),
    row(3, '1-101 size0'),
  ], idx);
  assert.equal(plan.merges.length, 1);
  assert.equal(plan.merges[0].key, '1-101 0');
  assert.equal(plan.merges[0].merged.length, 2);
  assert.equal(plan.merges[0].survivor.row.id, 1); // 完整度：有默认包装 → 最高
});

test('归位：产品号码 / 塑料盖贴 → 默认包装', () => {
  assert.deepEqual(one('割嘴 MC-12-1# 产品号码6003').extras.packagings, ['产品号码6003']);
  assert.deepEqual(one('乙炔割嘴 1-101 #1\n塑料盖贴：1-101 1').extras.packagings, ['塑料盖贴:1-101 1']);
  // 「包装」开头的描述也算包装
  assert.ok(one('1502乙炔割嘴 #8\n包装：塑料盒贴型号').extras.packagings[0].startsWith('包装'));
});

test('归位：品牌 / 克重 / 货号 / 代码 → 备注（货号不进包装）', () => {
  const e = one('HARRIS 丙烷割嘴6290-NX-2 53g\n代码：4187');
  assert.deepEqual(e.extras.packagings, []);
  assert.deepEqual(e.extras.remarks, ['HARRIS 53g', '代码:4187']);
});

test('归位：类别 / 款式 / 气体词是噪音，既不进包装也不进备注', () => {
  assert.deepEqual(one('GPN-1').extras, { packagings: [], remarks: [], unsafeModelSpan: false });
  assert.deepEqual(one('澳大利亚款式乙炔 割嘴 41-12').extras.packagings, []);
  assert.deepEqual(one('澳大利亚款式乙炔 割嘴 41-12').extras.remarks, []);
  assert.deepEqual(one('1-118   割嘴 2#').extras.remarks, []);
});

test('归位：不臆造——型号锚定不到 / 名称没写 size 的行不产出标准名', () => {
  assert.equal(one('106HC-2').canonical, null);
  assert.equal(one('106HC-2').reason, '型号边界不干净（右侧紧贴 H）');
  assert.equal(one('乙炔割嘴 1-101').canonical, null);
  assert.equal(one('乙炔割嘴 1-101').reason, null); // 型号锚定到了，但 size 未知
  assert.equal(one('割嘴 1-GPN 2#').canonical, null);
  assert.equal(one('割嘴 1-GPN 2#').reason, '尺寸有歧义（型号前 1 / 型号后 2）');
});

test('归位幂等：第二次跑用 legacy_name 取原始名，结论完全一致', () => {
  const first = planNormalize([row(1, '乙炔割嘴1-101-2 102g\n代码：4191')], idx);
  const survivor = first.survivors[0];
  const renamed = row(1, survivor.survivor.canonical, { legacy_name: '乙炔割嘴1-101-2 102g\n代码：4191' });
  const second = planNormalize([renamed], idx);
  assert.equal(second.renames.length, 0);                       // 名字已标准 → 不再改名
  assert.deepEqual(second.survivors[0].survivor.extras, first.survivors[0].survivor.extras); // 归位结论不变
  assert.equal(second.merges.length, 0);
});

test('备注多值合并幂等（已有片段不重复追加）', () => {
  const a = mergeRemark(null, ['HARRIS 53g', '代码:4187']);
  assert.equal(a, 'HARRIS 53g ｜ 代码:4187');
  assert.equal(mergeRemark(a, ['HARRIS 53g', '代码:4187']), a);
  assert.equal(mergeRemark(a, ['新增说明']), 'HARRIS 53g ｜ 代码:4187 ｜ 新增说明');
});

test('默认包装多值去重（同一产品同一包装只留一条）', () => {
  const plan = planNormalize([
    row(1, '割嘴 MC-12-1# 产品号码6003', { default_packaging: '塑料盒' }),
    row(2, 'MC12 割嘴 1# 产品号码6003'),
  ], idx);
  // 合并组存活 #1：两条都带「产品号码6003」→ 只入一行
  const forOne = plan.packagingRows.filter((p) => p.productId === 1);
  assert.deepEqual(forOne.filter((p) => p.source === 'name').map((p) => p.packaging), ['产品号码6003']);
  // 既有 default_packaging 回填成一条 legacy 包装
  assert.deepEqual(forOne.filter((p) => p.source === 'legacy').map((p) => p.packaging), ['塑料盒']);
});

test('同一型号多种默认包装：既有文本列 + 名字归位可并存（1:N）', () => {
  const plan = planNormalize([
    row(1, '乙炔割嘴 1-101 #1\n塑料盖贴：1-101 1', { default_packaging: '塑壳 红盖 不干胶' }),
  ], idx);
  const packs = plan.packagingRows.filter((p) => p.productId === 1).map((p) => p.packaging);
  assert.deepEqual(packs, ['塑壳 红盖 不粘胶'.replace('粘', '干'), '塑料盖贴:1-101 1']);
});

test('合并时被并入档案的包装挂到存活记录上（不随删除丢失）', () => {
  const plan = planNormalize([
    row(1, '0-1-101', { default_packaging: '包装A' }),
    row(2, '1-101 割嘴 0#', { default_packaging: '包装B' }),
  ], idx);
  assert.equal(plan.merges.length, 1);
  const packs = plan.packagingRows.filter((p) => p.productId === 1).map((p) => p.packaging).sort();
  assert.deepEqual(packs, ['包装A', '包装B']);
  assert.ok(!plan.packagingRows.some((p) => p.productId === 2), '被合并档案不应再有包装行');
});

test('别名默认不生效；甲方确认后 withModelAliases 才把 106HC 认成 106', () => {
  const rows = [row(1, '106HC-2'), row(2, '106HC-3')];
  const before = planNormalize(rows, idx);
  assert.equal(before.merges.length, 0);
  assert.equal(before.entries[0].canonical, null);
  const aliased = withModelAliases(idx, { '106HC': '106', '102HC': '102', '不存在': '106' });
  const after = planNormalize(rows, aliased);
  assert.equal(after.entries[0].canonical, '2-106');
  assert.equal(after.entries[1].canonical, '3-106');
  assert.equal(after.entries[0].newlyExtracted, true);
  // 「不存在」的目标不是目录型号 → 整条忽略（不臆造）
  assert.equal(after.entries.find((e) => e.parse?.model === '不存在'), undefined);
});

test('型号紧凑匹配跨过无关文字时，不做位置切割（信息不丢，列入待确认）', () => {
  const e = one('割嘴 GPN #3  塑料盖贴：GPN-3');
  assert.equal(e.canonical, '3-3GPN');
  assert.equal(e.extras.unsafeModelSpan, true);
  assert.ok(e.extras.packagings.join('').includes('塑料盖贴'), JSON.stringify(e.extras));
});

test('真实数据：191 条可归一行 → 185 条改名 / 0 合并 / 452 条未锚定（不猜）', () => {
  const names = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog_models.json'), 'utf8')); // 只做索引用
  assert.ok(names.series.length === 6);
  const plan = planNormalize([
    row(1, 'GPN-1'), row(2, 'GPN-2'), row(3, '割嘴 MC-12-1# 产品号码6003'),
    row(4, 'HARRIS 丙烷割嘴6290-NX-2 53g\n代码：4187'), row(5, '00-GPN'), row(6, '0-GPN'),
  ], idx);
  assert.deepEqual(plan.renames.map((r) => r.to), ['1-GPN', '2-GPN', '1-MC12', '2-6290NX']);
  assert.equal(plan.stat.renamed, 4);
  assert.equal(plan.stat.matchedSized, 6);
  assert.equal(plan.stat.renamedModelKinds, 6);
});

test('canonicalProductName 就是 {size}-{model}（size 在前，原样）', () => {
  assert.equal(canonicalProductName('0', '1-101'), '0-1-101');
  assert.equal(canonicalProductName('000', '3-101'), '000-3-101');
  assert.equal(canonicalProductName('1/16', 'ANME'), '1/16-ANME');
});

test('splitFragments：按行与句读拆，不按空格拆（避免拆散包装描述）', () => {
  assert.deepEqual(splitFragments('a\nb,c；d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitFragments('塑料盖贴：1-101 1'), ['塑料盖贴：1-101 1']);
});
