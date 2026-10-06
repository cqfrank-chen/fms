/**
 * 产品名归一 + 型号提炼 + 归位（默认包装 / 备注）—— **纯函数核心**（零依赖、不碰数据库）
 * =============================================================================
 * 甲方规则（2026 标准化，最高优先级）：
 *   ① **产品名统一为 {size}-{model}**：size 用目录 size setting 原值（0 / 00 / 000 / 1 …，
 *      **不补零不删零**），model 用目录型号代码 —— 例：0-1-101、000-3-101、0-261；
 *      因此「261 割嘴 0#」→ 0-261，「0-1-101」与「1-101 割嘴 0#」→ 同一条 0-1-101。
 *   ② **从名称提炼型号**（只认能锚定到目录的写法）→ 归一后按 (model, size) **再次去重**；
 *      **不同 size 绝不合并**（0 ≠ 00 ≠ 000）。
 *   ③ **多余信息归位**：产品号码 / 塑料盖贴（塑料盖 / 贴盖 / 盖贴）→ **默认包装**；
 *      其余（品牌 / 刻字 / 重量 / 货号 / 尺寸描述 / 备注性文字）→ **备注**。
 *   ④ 主观判断一律**不臆造**：型号锚定不到目录、或名称没写 size 的档案，**保持现状**并逐条列清单。
 *
 * 本文件只做判定；写库 / 重挂外键 / 报告由 CLI（tools/catalog/normalize_products.mjs）负责。
 * 抽出来的目的是让单测（normalize_products.test.mjs）直接验规则，不需要连库。
 */
import { explainProductModelSpans, toHalfWidth } from './product-model.mjs';

/** 甲方口径的产品名：{size}-{model}（如 0-1-101 / 000-3-101 / 0-261） */
export function canonicalProductName(size, model) {
  return String(size) + '-' + String(model);
}

/**
 * 「非多余信息」的词：产品类别 / 款式 / 气体 —— 这些信息已经落在 type / series / gas_type 列里，
 * 既不属于默认包装也不属于备注，归一时**直接丢掉**（否则每条产品的备注都会被「割嘴」刷屏）。
 * 只删词、不删数字与其它文字，所以 53g / 4187 / 分体式 / 刻字 等内容一定保留。
 */
const GENERIC_WORDS = [
  '仿澳大利亚款式', '澳大利亚款式', '美式款式', '英式款式', '日式款式', '法式款式', '巴西式款式',
  '切割喷嘴', '丙烷割嘴', '乙炔割嘴', '快速割嘴', '内喷嘴', '外喷嘴', '割嘴', '喷嘴', '内嘴', '外嘴',
  '焊杆', '割炬', '焊枪', '快速', '仿', '款式',
  '澳大利亚', '澳洲', '澳式', '巴西', '美式', '英式', '日式', '法式', '美国', '日本', '英国', '法国',
  '乙炔', '丙烷', '液化气', '天然气', '煤气', '中性', '常规', '通用', '型号', '规格',
];
const GENERIC_RE = new RegExp(GENERIC_WORDS.join('|'), 'g');

/**
 * 「归默认包装」的关键词（甲方规则③）：
 *   产品号码、塑料贴盖一族（塑料盖 / 塑料盒盖 / 盖贴 / 贴盖 / 塑壳），以及其它明确的包装物描述。
 * 注意 **货号 / 代码 不在其中** —— 甲方把「货号」明确归入备注。
 */
const PACKAGING_RE = new RegExp([
  '产品号码', '塑料盖', '塑料盒盖', '塑壳盖', '盖贴', '贴盖', '塑料盒', '塑壳',
  '不干胶', '标贴', '贴纸', '商标', '条码',
  '包装', '彩盒', '彩卡', '泡壳', '吸塑', '尼龙袋', 'PP袋', '塑料袋', '纸箱', '中盒', '盒盖', '说明书', '散装',
].join('|'));

/** 片段两端的分隔符（归一后去掉；中间的分隔符有含义，如 1#） */
const TRIM_EDGE_RE = /^[\s\-_—:：,，、;；|｜#*+~"'“”‘’()（）\[\]【】]+|[\s\-_—:：,，、;；|｜#*+~"'“”‘’()（）\[\]【】]+$/g;
/** 判断「去掉类别词之后还有没有内容」时，还要一并忽略的纯装饰字符 */
const DECOR_RE = /[\s\-_—:：,，、;；|｜#*+~"'“”‘’()（）\[\]【】.。!！?？]/g;

/** 文本归一：折空白、去两端分隔符（幂等：同样的输入永远得到同样的输出） */
export function normalizeFragment(s) {
  return String(s ?? '').replace(/\s+/g, ' ').replace(TRIM_EDGE_RE, '').trim();
}

/** 名 → 片段（先按行拆，再按句读拆；不做空格拆分，避免把「塑料盖贴：1-101 1」拆散） */
export function splitFragments(text) {
  const out = [];
  for (const line of String(text ?? '').split(/[\r\n]+/)) {
    for (const seg of line.split(/[;；,，、|｜]+/)) out.push(seg);
  }
  return out;
}

/**
 * 把「型号 + size」区间从名字里挖掉（区间来自 explainProductModelSpans，坐标是半角化并 trim 后的串），
 * 剩下的文字按片段分类：默认包装 / 备注 /（类别词构成的纯噪音 → 丢弃）。
 * @returns {{packagings: string[], remarks: string[]}}
 */
/** 型号 / size 区间是否「干净」：只含字母数字与分隔符（不含中文等无关文字） */
function spanIsClean(raw, start, end) {
  if (start == null || end == null) return false;
  return /^[0-9A-Za-z\s\-_./]*$/.test(raw.slice(start, end));
}

export function extractExtras(rawName, spans) {
  const raw = String(rawName ?? '');
  const cuts = [];
  const mClean = spanIsClean(raw, spans?.modelStart, spans?.modelEnd);
  const sClean = spanIsClean(raw, spans?.sizeStart, spans?.sizeEnd);
  if (mClean) cuts.push([spans.modelStart, spans.modelEnd]);
  if (sClean) cuts.push([spans.sizeStart, spans.sizeEnd]);
  // 型号与 size 之间的「连接段」（只剩分隔符或 SC-50-A-0 的变体字母 A）：无数字、无中文才切
  if (mClean && sClean) {
    const [a, b] = spans.modelStart < spans.sizeStart
      ? [spans.modelEnd, spans.sizeStart]
      : [spans.sizeEnd, spans.modelStart];
    const gap = raw.slice(a, b);
    if (!/[0-9\u4e00-\u9fff]/.test(gap)) cuts.push([a, b]);
  }
  cuts.sort((x, y) => x[0] - y[0]);
  let rest = '';
  // 型号区间「不干净」（紧凑匹配跨过了无关文字，如「割嘴 GPN #3  塑料盖贴：GPN-3」的 3GPN）：
  // 位置不可靠 —— 干脆**不切**，整名按片段归位（信息零丢失），并在报告里单列待甲方确认。
  if (mClean || sClean) {
    let cursor = 0;
    for (const [s, e] of cuts) {
      if (s < cursor || e < s) continue; // 区间重叠 / 逆序（理论上不会）：跳过，保证不越界
      rest += raw.slice(cursor, s) + ' ';
      cursor = e;
    }
    rest += raw.slice(cursor);
  } else {
    rest = raw;
  }

  const packagings = [];
  const remarks = [];
  for (const seg of splitFragments(rest)) {
    // 先去掉类别 / 款式 / 气体词（这些信息已在 type / series / gas_type 列里），再看还剩什么
    const clean = normalizeFragment(String(seg).replace(GENERIC_RE, ' '));
    if (!clean) continue; // 纯类别词 → 噪音（如「乙炔割嘴」「澳大利亚款式乙炔 割嘴」）
    // 分类看**原始片段**：例如「仿包装」「包装：塑料盒+不干胶」都算包装
    if (PACKAGING_RE.test(seg)) { if (!packagings.includes(clean)) packagings.push(clean); }
    else if (!remarks.includes(clean)) remarks.push(clean);
  }
  return { packagings, remarks, unsafeModelSpan: spans?.modelStart != null && !mClean };
}

/** 备注多值合并（幂等：已有的片段不重复追加；用分隔符拼回，便于下次拆回来） */
export const REMARK_SEP = ' ｜ ';
export function mergeRemark(existing, fragments) {
  const cur = String(existing ?? '').split(REMARK_SEP).map((s) => s.trim()).filter(Boolean);
  const add = (fragments ?? []).map((s) => String(s).trim()).filter(Boolean);
  const all = [...cur];
  for (const a of add) if (!all.includes(a)) all.push(a);
  return all.length ? all.join(REMARK_SEP) : null;
}

/** 完整度打分（与 dedupe-core 同口径）：类型具体 +2 / 默认包装 +1 / 默认工序路线 +1 / 安全库存>0 +1 */
export function richness(row) {
  return (row.type && row.type !== 'tbd' ? 2 : 0)
    + (row.default_packaging ? 1 : 0)
    + (row.default_routing ? 1 : 0)
    + (Number(row.safety_stock) > 0 ? 1 : 0);
}

/** 组内选存活记录：完整度最高 → id 最小（确定性、可复算） */
export function pickSurvivor(members) {
  return [...members].sort((a, b) => (b.richness - a.richness) || (a.row.id - b.row.id))[0];
}

/**
 * 归一计划（纯函数）：解析 → 定标准名 → 归位包装/备注 → 按 (model,size) 分组选存活。
 * @param rows 产品行（需含 id / name / type / catalog_model / size_spec / default_packaging /
 *             default_routing / safety_stock / remark / legacy_name；后两列可缺省）
 * @param index 目录型号索引（buildModelIndex(catalog_models.json)，可先 withModelAliases 叠加别名）
 */
export function planNormalize(rows, index) {
  const entries = rows.map((row) => {
    // 归一的输入一律取 **原始名**：第一次跑用 name，之后用 legacy_name（否则改名后信息就取不到了）
    const sourceName = row.legacy_name ?? row.name;
    const ex = explainProductModelSpans(sourceName, index);
    const p = ex.result;
    const sized = !!(p && p.sizeKnown && p.size != null);
    const canonical = sized ? canonicalProductName(p.size, p.model) : null;
    const rawHalf = toHalfWidth(String(sourceName ?? '')).trim();
    const extras = sized ? extractExtras(rawHalf, ex) : { packagings: [], remarks: [] };
    return {
      row,
      parse: p,
      reason: ex.reason,
      sourceName,
      canonical,
      sized,
      // 「命名变更」= 标准名与当前显示名不同（已经是 0-GPN 这种标准名的行不算变更）
      changedName: canonical != null && canonical !== row.name,
      // 「新提炼出型号」= 库里还没有型号、或与本次从名称提炼出的型号不一致
      newlyExtracted: sized && (!row.catalog_model || row.catalog_model !== p.model),
      extras,
      richness: richness(row),
    };
  });

  const stat = {
    total: rows.length,
    matchedSized: 0,
    sizeUnknown: 0,
    unmatched: 0,
    renamed: 0,
    renamedModelKinds: 0,
    newlyExtracted: 0,
    merged: 0,
    mergeGroups: 0,
  };
  const groups = new Map();
  for (const e of entries) {
    if (e.sized) {
      stat.matchedSized += 1;
      if (e.changedName) stat.renamed += 1;
      if (e.newlyExtracted) stat.newlyExtracted += 1;
      const key = e.parse.model + ' ' + e.parse.size;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    } else if (e.parse) stat.sizeUnknown += 1; // 型号锚定到了，但名称没写 size
    else stat.unmatched += 1;
  }
  stat.renamedModelKinds = new Set(entries.filter((e) => e.sized).map((e) => e.parse.model + ' ' + e.parse.size)).size;

  const merges = [];
  const survivors = [];
  for (const [key, members] of groups) {
    const survivor = pickSurvivor(members);
    const merged = members.filter((m) => m !== survivor).sort((a, b) => a.row.id - b.row.id);
    if (merged.length) {
      merges.push({ key, survivor, merged });
      stat.merged += merged.length;
      stat.mergeGroups += 1;
    }
    survivors.push({ key, survivor, merged });
  }
  merges.sort((a, b) => a.survivor.row.id - b.survivor.row.id);
  survivors.sort((a, b) => a.survivor.row.id - b.survivor.row.id);

  // ---- 归位产物：存活记录上的 默认包装（多值）+ 备注（多值）+ 原始名留档 ----
  const packagingRows = [];
  // 既有 default_packaging 文本列 → 1:N 表回填（source='legacy'）：让「多默认包装」一次到位，
  // 且与后端「没有行时才虚拟合成」的口径不冲突（回填后就有真行了）。幂等：唯一索引兜底。
  // 被合并档案的包装一律挂到存活记录上（否则随被并入档案一起级联删除，信息就丢了）。
  const ownerOf = new Map();
  for (const g of survivors) {
    ownerOf.set(g.survivor.row.id, g.survivor.row.id);
    for (const m of g.merged) ownerOf.set(m.row.id, g.survivor.row.id);
  }
  const legacySeen = new Set();
  for (const e of entries) {
    const legacy = String(e.row.default_packaging ?? '').trim();
    if (!legacy) continue;
    const owner = ownerOf.get(e.row.id) ?? e.row.id;
    const k = owner + '\u0000' + legacy;
    if (legacySeen.has(k)) continue;
    legacySeen.add(k);
    packagingRows.push({ productId: owner, packaging: legacy, source: 'legacy' });
  }
  const legacyPackagingRows = packagingRows.length;
  const remarkWrites = [];
  const renames = [];
  for (const g of survivors) {
    const s = g.survivor;
    // 合并时把被并入档案的包装 / 备注一并保留（不丢信息）
    const packs = [];
    for (const e of [s, ...g.merged]) {
      for (const p of e.extras.packagings) if (!packs.includes(p)) packs.push(p);
    }
    // 合并时也把「被并入档案已经落库的包装」并过来（例如第一轮归位过、本轮又被合并的行）
    for (const e of [s, ...g.merged]) {
      const existing = Array.isArray(e.row.packagings) ? e.row.packagings : [];
      for (const p of existing) {
        const t = String(p?.packaging ?? '').trim();
        if (t && !packs.includes(t)) packs.push(t);
      }
    }
    for (const p of packs) packagingRows.push({ productId: s.row.id, packaging: p, source: 'name' });

    const remarks = [];
    for (const e of [s, ...g.merged]) for (const r of e.extras.remarks) if (!remarks.includes(r)) remarks.push(r);
    const existingRemark = [s, ...g.merged]
      .map((e) => e.row.remark)
      .filter(Boolean)
      .join(REMARK_SEP);
    const nextRemark = mergeRemark(existingRemark, remarks);
    remarkWrites.push({ id: s.row.id, remark: nextRemark });

    if (s.changedName) renames.push({ id: s.row.id, from: s.row.name, to: s.canonical, model: s.parse.model, size: s.parse.size });
  }

  // ---- 未锚定清单（保持现状，含原因）----
  const unanchored = entries
    .filter((e) => !e.sized)
    .map((e) => ({
      id: e.row.id,
      name: e.row.name,
      category: e.parse ? '型号已锚定但名称未写 size' : '型号未锚定目录',
      model: e.parse ? e.parse.model : null,
      reason: e.parse ? '名称未写尺寸（size 待人工确认，脚本不猜）' : (e.reason ?? '型号未锚定到目录'),
    }));

  // ---- 重名检查：归一后与**未改名档案**重名（如 GPN size 3 → 3-GPN，而库里已有档案名就叫 3-GPN）----
  const unchangedNames = new Map();
  for (const e of entries) {
    if (e.changedName) continue;
    if (!unchangedNames.has(e.row.name)) unchangedNames.set(e.row.name, []);
    unchangedNames.get(e.row.name).push(e.row.id);
  }
  const collisions = [];
  for (const r of renames) {
    const hit = unchangedNames.get(r.to);
    if (hit && hit.length) collisions.push({ name: r.to, renamedId: r.id, keptIds: hit });
  }

  // 型号区间不干净的档案（归位时未做位置切割，整名归入包装/备注）—— 列清单，不臆造
  const unsafeSpans = entries
    .filter((e) => e.sized && e.extras.unsafeModelSpan)
    .map((e) => ({ id: e.row.id, name: e.row.name, model: e.parse.model, size: e.parse.size }));

  return {
    entries, stat, groups, merges, survivors, packagingRows, legacyPackagingRows,
    remarkWrites, renames, unanchored, collisions, unsafeSpans,
  };
}
