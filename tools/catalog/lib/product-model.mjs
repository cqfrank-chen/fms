/**
 * 产品名 →（目录系列, 基础型号, size）解析（**工具侧**实现，零依赖）。
 * =============================================================================
 * 甲方规则（最高优先级）：**型号名前面或后面跟的数字、或 # 号后的数字 = 同一型号的不同 size**。
 *   · 0-GPN / 00-GPN / 000-GPN  →  型号 GPN，size 0 / 00 / 000（三档不同尺寸，各自是独立产品）
 *   · 106 #1 / 106 1#            →  型号 106，size 1
 *   · 1-1-101                    →  型号 1-101，size 1（前导数字 = size）
 *   · Victor 乙炔割嘴 1-1-101      →  同上（品牌 / 描述前缀不影响）
 *   · 割嘴 1#-3-101 / 乙炔割嘴1-101-2 → 型号 3-101 size 1 / 型号 1-101 size 2
 *
 * 安全口径（宁缺勿错，**型号必须锚定到官方目录 37 个型号之一**）：
 *   ① 型号要「边界对齐」：型号左边必须是分隔符或串首；右边要么是分隔符/串尾，
 *      要么紧跟一个**该型号目录里真实存在的 size** —— 否则候选作废（防止货号 4154 被当成型号 41）；
 *   ② size 必须**逐字符等于**目录档位（0 != 00 != 000 != 0000），且与型号之间要有分隔符
 *      （型号紧凑键以字母结尾时才允许紧贴，如 G1-P16/10、6290NX2）；
 *   ③ 型号前后**同时**出现数字且互不相同 → 「尺寸有歧义」，**不出结论**（如「割嘴 1-GPN 2#」）；
 *   ④ 不做无约束子串匹配、不做模糊数字比较、不臆造目录里没有的型号。
 *
 * ⚠️ 本文件与 apps/api/src/ai/product-model.ts 是同一算法的**两份实现**（服务端 TS / 工具 JS），
 * 由 tools/catalog/verify_parity.mjs 用同一批名称逐条比对，防止两处口径漂移。
 */

/** 紧凑键：只留字母数字并小写（连字符/空格/点号/斜杠等分隔符一律忽略）——用于「型号写法」匹配 */
export function compactKey(s) {
  return String(s ?? '').replace(/[^0-9A-Za-z]/g, '').toLowerCase();
}

/** 全角 → 半角（与 table-parser.service.ts 的 normalizeToken 第一步同口径） */
export function toHalfWidth(s) {
  return String(s ?? '').replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

const isAlnum = (ch) => ch !== undefined && /[0-9A-Za-z]/.test(ch);

// size 写法：整数（可含前导零，1~3 位）或分数（MOREX 的 1/32 之类）
const SIZE = '([0-9]{1,3}\/[0-9]{1,2}|[0-9]{1,3})';
// 型号前：数字（可带 #）紧跟分隔符，再接型号；数字左边不能再是数字（0000-GPN 不算 size 0）
const PREFIX_RE = new RegExp('(?:^|[^0-9])' + SIZE + '\\s*#?[\\s\\-_]*$');
// 型号后（紧邻）：至少一个分隔符，可选一个单字母变体标记（SC-50-A-0 的 A），再取数字（可带 #）
const SUF_NEAR_RE = new RegExp('^[#\\s\\-_]+(?:[A-Za-z][\\s\\-_]+)?' + SIZE + '(?![0-9])\\s*#?');
// 型号后（紧贴，仅当型号键以字母结尾时允许）：G1-P16/10、6290NX2
const SUF_GLUED_RE = new RegExp('^' + SIZE + '(?![0-9])\\s*#?');
// 型号后（隔一段描述文字，但数字必须带 # 标记）：割嘴 0# / 丙烷割嘴 #4
const SUF_HASH_AFTER_RE = new RegExp('^[^0-9]{1,14}?' + SIZE + '(?![0-9])\\s*#');
const SUF_HASH_BEFORE_RE = new RegExp('^[^0-9]{1,14}?#\\s*' + SIZE + '(?![0-9])');

/**
 * 型号条目 → 索引。key = compactKey(型号或别名)。
 * 只有「紧凑键长度 >= 2」的才进索引：目录里 A / M 两族是单字母，必须连气体后缀
 * （A(ACE) / M(LPG) / A_AC / M_LPG）一起写出来才认，避免把名字里随便一个 A / M 当成型号。
 */
export function buildModelIndex(catalog) {
  const byKey = new Map();
  for (const s of catalog.series) {
    for (const m of s.models) {
      const keys = new Set([compactKey(m.model), ...((m.aliases ?? []).map(compactKey))]);
      for (const k of keys) {
        if (k.length < 2) continue;
        if (byKey.has(k)) continue;
        byKey.set(k, {
          key: k, model: m.model, series: s.series, seriesCode: s.code,
          gasType: m.gasType, sizes: m.sizes.map((r) => r.size),
          bySize: new Map(m.sizes.map((r) => [r.size, r])),
        });
      }
    }
  }
  return byKey;
}

/** 名字里所有「目录型号」候选（按紧凑键长度从长到短，同长取靠左） */
function candidates(raw, index) {
  let c = '';
  const rawAt = []; // 紧凑串第 i 位对应的原串下标
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/[0-9A-Za-z]/.test(ch)) { c += ch.toLowerCase(); rawAt.push(i); }
  }
  const out = [];
  for (const [key, hit] of index) {
    let from = 0;
    for (;;) {
      const p = c.indexOf(key, from);
      if (p < 0) break;
      out.push({ hit, key, start: rawAt[p], end: rawAt[p + key.length - 1] + 1 });
      from = p + 1;
    }
  }
  out.sort((a, b) => (b.key.length - a.key.length) || (a.start - b.start));
  return out;
}

/**
 * 解析产品名并给出「为什么没锚定」的说明（报告用）。
 * 锚定不到目录（型号不在目录 / 尺寸有歧义 / size 不在档位）时 result 为 null —— 绝不猜。
 */
export function explainProductModel(name, index) {
  const raw = toHalfWidth(String(name ?? '')).trim();
  if (!raw) return { result: null, reason: '空名称' };
  if (!index || !index.size) return { result: null, reason: '型号索引为空' };
  let reason = null;

  for (const cand of candidates(raw, index)) {
    // ① 左边必须边界对齐（串首 或 非字母数字的分隔符）
    if (cand.start > 0 && isAlnum(raw[cand.start - 1])) continue;
    const before = raw.slice(0, cand.start);
    const after = raw.slice(cand.end);
    const gluedOk = /[a-z]$/.test(cand.key);

    const preM = before.match(PREFIX_RE);
    const sufNear = after.match(SUF_NEAR_RE);
    const sufM = sufNear ?? (gluedOk ? after.match(SUF_GLUED_RE) : null)
      ?? after.match(SUF_HASH_AFTER_RE) ?? after.match(SUF_HASH_BEFORE_RE);
    const pre = preM ? preM[1] : null;
    const suf = sufM ? sufM[1] : null;

    // ② 前后都有数字且不同 → 尺寸有歧义，不猜（换下一个候选）
    if (pre && suf && pre !== suf) { reason = '尺寸有歧义（型号前 ' + pre + ' / 型号后 ' + suf + '）'; continue; }

    const base = { series: cand.hit.series, seriesCode: cand.hit.seriesCode, model: cand.hit.model,
      gasType: cand.hit.gasType };

    const size = pre ?? suf;
    if (size == null) {
      // 型号**前面**还有解析不掉的数字（如 0000-GPN 的 0000，不是目录档位）→ 尺寸未定，作废
      const leftRun = before.match(/(^|[^0-9])([0-9]+)\s*#?[\s\-_]*$/);
      if (leftRun) { reason = '尺寸不在目录档位（型号前数字 ' + leftRun[2] + '）'; continue; }
      // 型号后面既没有合法 size，又紧贴着字母数字 → 边界不干净（多半是别的编号），作废
      if (cand.end < raw.length && isAlnum(raw[cand.end])) { reason = '型号边界不干净（右侧紧贴 ' + raw[cand.end] + '）'; continue; }
      return { result: { ...base, size: null, orificeMm: null, thicknessRange: null, sizeKnown: false }, reason: null };
    }
    // ③ size 必须是该型号目录里真实存在的档位（逐字符，含前导零）
    const row = cand.hit.bySize.get(size);
    // size 不在档位里（例如把货号 / 变体号 PNME18 的 18 当 size）→ **整个候选作废、不当成「型号无尺寸」**：
    // 尺寸没定死就放过，会让不同尺寸互相命中（价格错误代价高）。
    if (!row) { reason = '尺寸不在目录档位（候选数字 ' + size + '）'; continue; }
    return { result: { ...base, size, orificeMm: row.orifice, thicknessRange: row.thickness, sizeKnown: true }, reason: null };
  }
  return { result: null, reason: reason ?? '型号未锚定到目录' };
}

/** 只要结论：锚定不到目录（或尺寸有歧义）时返回 null */
export function parseProductModel(name, index) {
  return explainProductModel(name, index).result;
}

/** 「基础型号 + size」是否相同（两个写法都必须能锚定到目录）—— 型号命中的唯一权威判定 */
export function sameCatalogProduct(a, b, index) {
  const x = parseProductModel(a, index);
  const y = parseProductModel(b, index);
  if (!x || !y) return false;
  return x.model === y.model && x.size === y.size;
}
