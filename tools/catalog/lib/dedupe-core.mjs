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

/** 锚定等级（存活规则①）：已锚定目录 = 1，未锚定 = 0 */
export const anchorRank = (m) => (m && m.target && m.target.catalog_anchor === 'matched' ? 1 : 0);

/**
 * 组内选存活记录：**规则与文件顶部一致** ——
 *   ① 优先 catalog_anchor='matched'（未锚定的不配当存活记录）；
 *   ② 其次完整度最高（richness）；
 *   ③ 其次 id 最小（最早建档）。
 * 确定性、可复算、不随机；对既有「自动分组」是无变化的一步
 * （自动分组的成员天然全 matched，①恒等）。
 */
export function pickSurvivor(members) {
  return [...members].sort((a, b) =>
    (anchorRank(b) - anchorRank(a)) || (b.richness - a.richness) || (a.row.id - b.row.id))[0];
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

/**
 * 甲方点名的「重名两条」手工合并组（纯函数）—— 与自动分组**取并集**，存活规则完全沿用。
 * =============================================================================
 * 场景：`3-GPN` 这种写法可以解析成「GPN 的 size 3」，也可以解析成「型号 3GPN（未写 size）」，
 * 于是两条档案归一后**同名**，但它们不在同一个 (型号,size) 自动分组里，通用去重不会碰它们。
 * 甲方批准后，用 --merge-ids 18,24 明确点名：把这几条并成**一条**。
 *
 * 口径（不新造规则）：
 *   · 成员 = 点名的 id ∪ 与它们相交的自动分组的全部成员（吸收，保证不漏合并、不重复处理）；
 *   · 存活记录 = pickSurvivor（①matched ②完整度 ③id 最小）—— 与自动合并**同一套**；
 *   · **身份以库内既有值为准**（manual: true，调用方据此不重写存活记录的目录列）：
 *     点名合并的起因正是「名字有歧义」，若再拿名字重新解析一边，等于用歧义覆盖已确认的事实。
 *   · **安全闸**：存活记录必须「库里已 anchored + 型号 + size 齐全」，否则拒绝合并
 *     （身份写不死就等于把不同尺寸的东西并到一起 —— 脚本不猜）。
 *
 * @returns groups 剩余自动分组（被手工组吸收的已剔除）/ manualGroups 手工合并组（0 或 1 组）/
 *          absorbed 被吸收的自动分组数 / missing 点名但库里不存在的 id（幂等复跑会出现）/
 *          identityLocked 点名里「库内身份已齐全」的行（自校验按库内身份核对，不按名字重解析）/
 *          refused 拒绝原因（中文；非空时调用方必须终止，不得写库）
 */
export function planManualMerges(parsed, autoMergeGroups, manualIds) {
  const byId = new Map(parsed.map((p) => [p.row.id, p]));
  const wanted = [...new Set(manualIds.map(Number).filter((n) => Number.isInteger(n)))];
  const missing = wanted.filter((id) => !byId.has(id));
  const picked = wanted.filter((id) => byId.has(id));
  const absorbed = new Set();
  const ids = new Set(picked);
  const parts = picked.map((id) => byId.get(id));
  // 吸收与点名 id 相交的自动分组（并集闭包：吸收进来的成员若又引出别的组，继续吸收）
  let grew = true;
  while (grew) {
    grew = false;
    autoMergeGroups.forEach((g, i) => {
      if (absorbed.has(i)) return;
      const members = [g.survivor, ...g.merged];
      if (!members.some((m) => ids.has(m.row.id))) return;
      absorbed.add(i);
      for (const m of members) {
        if (ids.has(m.row.id)) continue;
        ids.add(m.row.id);
        parts.push(m);
      }
      grew = true;
    });
  }
  const groups = autoMergeGroups.filter((_, i) => !absorbed.has(i));
  const manualGroups = [];
  /** 库内身份（型号 + size）齐备的已锚定行：自校验按它核对，不按名字重解析 */
  const identityLocked = parts
    .filter((p) => p.row.catalog_anchor === 'matched' && p.row.catalog_model != null && p.row.size_spec != null)
    .map((p) => ({
      id: p.row.id, name: p.row.name, model: p.row.catalog_model, size: p.row.size_spec,
      key: p.row.catalog_model + ' ' + p.row.size_spec,
    }));
  let refused = null;
  if (parts.length >= 2) {
    const survivor = pickSurvivor(parts);
    const lock = identityLocked.find((x) => x.id === survivor.row.id);
    if (!lock) {
      refused = '点名合并的存活记录 #' + survivor.row.id + '（' + survivor.row.name
        + '）在库里不是「已锚定 + 型号 + size 齐全」的档案，合并后的身份没法写死 —— 拒绝合并（脚本不猜 size）';
    } else {
      manualGroups.push({
        key: lock.key,
        survivor,
        merged: parts.filter((p) => p !== survivor).sort((a, b) => a.row.id - b.row.id),
        manual: true,
      });
    }
  }
  return { groups, manualGroups, absorbed: absorbed.size, missing, identityLocked, refused };
}
