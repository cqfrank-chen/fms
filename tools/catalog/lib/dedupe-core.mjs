/**
 * 产品档案去重合并 —— **纯函数核心**（零依赖、不碰数据库）
 * =============================================================================
 * 把「产品名 → 目录锚定 → (基础型号, size) 分组 → 选存活记录」的判定集中到这里，
 * CLI（tools/catalog/dedupe_products.mjs）只负责读库 / 重挂外键 / 报告。
 * 单独抽出来是为了让单测（tools/catalog/dedupe_products.test.mjs）能直接验判定，
 * 不需要连库 —— 判定错了是数据事故，必须在纯函数层就被测住。
 *
 * 甲方规则（最高优先级）：
 *   ① 型号前后带的数字 / # 号后的数字 / 「size」二字后的数字 = **size**；
 *      同一 (基础型号, size) 的多种写法是**同一个产品**，合并为一条；
 *   ② 0 / 00 / 000 是**不同 size，绝不合并**（逐字符比较）；
 *   ③ 型号未锚定目录、或名字没写 size → 去重键为 null，**保持现状，不猜**。
 */
import { explainProductModel } from './product-model.mjs';
import { deriveProductType } from './catalog-type.mjs';

/** 以目录为准的列（合并 / 对齐时按这些列比对与写入；type 另算，见 targetOf） */
export const CATALOG_FIELDS = [
  'catalog_model', 'size_spec', 'series', 'gas_type', 'orifice_mm', 'thickness_range', 'catalog_anchor',
];

/** 空值归一：null / undefined / '' 一律按 null 比较（避免 '' 与 null 反复互写） */
export const norm = (v) => (v === null || v === undefined ? null : String(v));

/**
 * 由产品名解析出该行应有的目录字段（纯函数：同样的名字永远得到同样的结果）。
 * 锚定不到目录 → 目录列全 null + catalog_anchor='unmatched' + 中文原因（绝不臆造）。
 * matched 但没有 size → size_spec/orifice/thickness 保持 null，并写明「size 待人工确认」。
 */
export function targetOf(name, index) {
  const ex = explainProductModel(name, index);
  const p = ex.result;
  if (!p) {
    return {
      catalog_model: null, size_spec: null, series: null, gas_type: null, orifice_mm: null,
      thickness_range: null, catalog_anchor: 'unmatched', type: null,
      catalog_note: ex.reason ?? '型号未锚定到目录',
    };
  }
  return {
    catalog_model: p.model,
    size_spec: p.size,
    series: p.series,
    gas_type: p.gasType,
    orifice_mm: p.orificeMm,
    thickness_range: p.thicknessRange,
    catalog_anchor: 'matched',
    // 类型以目录为准：款式（系列）+ 气体 → 既有枚举；映射不到（日式/法式/澳式/巴西式）→ tbd，不臆造
    type: deriveProductType(p.series, p.gasType),
    catalog_note: p.sizeKnown ? null : '名称未写尺寸（size 待人工确认）',
  };
}

/**
 * 「基础型号 + size」去重键；null = **不参与合并**（型号未锚定 / 名字没写 size）。
 * size 原样参与（含前导零），所以 0 / 00 / 000 必然是不同的键 —— 绝不互相合并。
 */
export function dedupeKeyOf(target) {
  if (!target || target.catalog_anchor !== 'matched') return null;
  if (!target.catalog_model || target.size_spec == null) return null;
  return target.catalog_model + ' ' + target.size_spec;
}

/** 完整度打分（存活记录选择规则②：字段最全优先）——type 具体权重最高 */
export function richness(row) {
  return (row.type && row.type !== 'tbd' ? 2 : 0)
    + (row.default_packaging ? 1 : 0)
    + (row.default_routing ? 1 : 0)
    + (Number(row.safety_stock) > 0 ? 1 : 0);
}

/** 目录标准名（仅在甲方确认后由 --canonical-name 开关使用） */
export function canonicalName(model, size) {
  return size == null ? String(model ?? '') : model + ' ' + size + '#';
}

/** 组内选存活记录：完整度最高 → id 最小（确定性、可复算，与本文件顶部规则一一对应） */
export function pickSurvivor(members) {
  return [...members].sort((a, b) => (b.richness - a.richness) || (a.row.id - b.row.id))[0];
}

/**
 * 解析 + 分组 + 选存活（纯函数）。
 * @param rows 产品行（需含 id / name / type / default_packaging / default_routing / safety_stock）
 * @param index 目录型号索引（buildModelIndex(catalog_models.json)）
 * @returns {{parsed: Array, stat: object, groups: Map, mergeGroups: Array, singleGroups: Array}}
 *   mergeGroups：组内 >1 条（要合并）；singleGroups：组内 =1 条（仅按目录对齐 type 等列）
 */
export function planDedupe(rows, index) {
  const parsed = rows.map((r) => {
    const t = targetOf(r.name, index);
    return { row: r, target: t, key: dedupeKeyOf(t), richness: richness(r) };
  });

  const stat = { total: rows.length, matched: 0, matchedSized: 0, sizeUnknown: 0, unmatched: 0 };
  const groups = new Map();
  for (const p of parsed) {
    if (p.target.catalog_anchor === 'matched') {
      stat.matched += 1;
      if (p.target.size_spec != null) stat.matchedSized += 1;
      else stat.sizeUnknown += 1;
    } else stat.unmatched += 1;
    if (!p.key) continue;
    if (!groups.has(p.key)) groups.set(p.key, []);
    groups.get(p.key).push(p);
  }

  const mergeGroups = [];
  const singleGroups = [];
  for (const [key, members] of groups) {
    const survivor = pickSurvivor(members);
    const merged = members.filter((m) => m !== survivor)
      .sort((a, b) => a.row.id - b.row.id);
    if (merged.length) mergeGroups.push({ key, survivor, merged });
    else singleGroups.push({ key, survivor });
  }
  mergeGroups.sort((a, b) => a.survivor.row.id - b.survivor.row.id);
  return { parsed, stat, groups, mergeGroups, singleGroups };
}
