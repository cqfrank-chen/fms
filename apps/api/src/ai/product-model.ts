import { CATALOG_SERIES } from './catalog-models';
import type { CatalogModel, CatalogSeries } from './catalog-models';

/**
 * ============================================================
 * 「基础型号 + size」型号命中口径（甲方规则 2026，**最高优先级**）
 * ------------------------------------------------------------
 * 甲方规则原文口径：**型号名前面或后面跟的数字、或 # 号后的数字 = 同一型号的不同 size**。
 *   · 0-GPN / 00-GPN / 000-GPN   → 型号 GPN，size 0 / 00 / 000（三档不同尺寸，各自是独立产品）
 *   · 106 #1 / 106 1#             → 型号 106，size 1
 *   · 1-1-101                    → 型号 1-101，size 1（前导数字 = size，其余是基础型号）
 *   · 1-101 size0 / 1-101 size 0 → 型号 1-101，size 0（「size」二字显式标注；与 0-1-101 同一产品）
 *   · Victor 乙炔割嘴 1-1-101      → 同上（品牌 / 描述前缀**不影响**命中）
 *   · 割嘴 1#-3-101 / 乙炔割嘴1-101-2 → 型号 3-101 size 1 / 型号 1-101 size 2
 *
 * 为什么要有这个模块：报价记录里写的是「Victor 乙炔割嘴 1-1-101」，计划单里写的是
 * 「1-1-101" —— 两者**字面不同**，旧的「归一后必须完全相等」口径取不到价（1264 行缺价的主因）。
 * 本模块把两边都解析成 (基础型号, size) 再比，于是**品牌前缀差异被忽略、size 必须逐字符一致**。
 *
 * 安全口径（宁缺勿错，价格错误代价高）：
 *   ① 型号必须**锚定到官方目录**（6 系列 / 37 型号，见 catalog-models.ts），不锚定一律不算命中；
 *   ② size 必须**逐字符等于**目录档位（0 != 00 != 000 != 0000），且与型号之间有分隔符
 *      （型号紧凑键以字母结尾时才允许紧贴，如 G1-P16/10、6290NX2）；
 *   ③ 型号前后**同时**出现数字且互不相同 → 尺寸有歧义，**不猜**（如「割嘴 1-GPN 2#」）；
 *   ④ 型号边界必须干净：左侧是分隔符/串首；右侧要么是分隔符/串尾，要么紧跟一个**合法 size**
 *      —— 否则作废（防止货号 4154 被当成型号 41、PNME18 的 18 被当成 size）；
 *   ⑤ 不做无约束子串匹配、不做模糊数字比较、不臆造目录里没有的型号。
 *
 * ⚠️ 本文件与 tools/catalog/lib/product-model.mjs 是同一算法的**两份实现**（服务端 TS / 工具 JS），
 * 由 tools/catalog/verify_parity.mjs 用同一批名称逐条比对（含 1444 条产品名 + 2582 条报价名），
 * 任何一边改了算法而另一边没跟上，脚本立刻报差异。
 */

/** 紧凑键：只留字母数字并小写（连字符/空格/点号/斜杠等分隔符一律忽略）——用于「型号写法」匹配 */
export function compactKey(s: string | null | undefined): string {
  return String(s ?? '').replace(/[^0-9A-Za-z]/g, '').toLowerCase();
}

/** 全角 → 半角（与 table-parser.service.ts 的 normalizeToken 第一步同口径） */
export function toHalfWidth(s: string | null | undefined): string {
  return String(s ?? '').replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 目录型号的索引条目（含该型号的全部 size 档位） */
export interface CatalogModelEntry {
  /** 紧凑键（索引键） */
  key: string;
  /** 目录印刷型号 */
  model: string;
  /** 系列 / 款式名 */
  series: string;
  /** 系列编号 */
  seriesCode: string;
  /** 气体类型 */
  gasType: 'LPG' | 'ACETYLENE' | null;
  /** 该型号目录里的全部 size（原样，含前导零） */
  sizes: string[];
  /** size → 目录行（孔径 / 厚度） */
  bySize: Map<string, { size: string; orifice: string; thickness: string }>;
}

/** 解析结论：基础型号 + size + 系列 + 气体（sizeKnown=false 表示只认到型号、没写尺寸） */
export interface ProductModelInfo {
  series: string;
  seriesCode: string;
  model: string;
  gasType: 'LPG' | 'ACETYLENE' | null;
  /** 目录 size setting；null = 名字里没写尺寸（**不等于**任意尺寸） */
  size: string | null;
  /** 切割孔径(mm) */
  orificeMm: string | null;
  /** 切割厚度范围(mm) */
  thicknessRange: string | null;
  sizeKnown: boolean;
}

export interface ExplainResult {
  result: ProductModelInfo | null;
  /** 未锚定的原因（中文，供报告 / 排障） */
  reason: string | null;
}

/**
 * 型号条目 → 索引。key = compactKey(型号或别名)。
 * 只有「紧凑键长度 >= 2」的才进索引：目录里 A / M 两族是单字母，必须连气体后缀
 * （A(ACE) / M(LPG) / A_AC / M_LPG）一起写出来才认，避免把名字里随便一个 A / M 当成型号。
 */
export function buildModelIndex(series: CatalogSeries[] = CATALOG_SERIES): Map<string, CatalogModelEntry> {
  const byKey = new Map<string, CatalogModelEntry>();
  for (const s of series) {
    for (const m of s.models) {
      const keys = new Set<string>([compactKey(m.model), ...(m.aliases ?? []).map((a) => compactKey(a))]);
      for (const k of keys) {
        if (k.length < 2) continue;
        if (byKey.has(k)) continue;
        byKey.set(k, {
          key: k,
          model: m.model,
          series: s.series,
          seriesCode: s.code,
          gasType: m.gasType,
          sizes: m.sizes.map((r) => r.size),
          bySize: new Map(m.sizes.map((r) => [r.size, { size: r.size, orifice: r.orifice, thickness: r.thickness }])),
        });
      }
    }
  }
  return byKey;
}

/** 进程内默认索引（模块级缓存一次；目录是编译期常量，不会变） */
let defaultIndex: Map<string, CatalogModelEntry> | null = null;
export function catalogModelIndex(): Map<string, CatalogModelEntry> {
  if (!defaultIndex) defaultIndex = buildModelIndex();
  return defaultIndex;
}

const isAlnum = (ch: string | undefined): boolean => ch !== undefined && /[0-9A-Za-z]/.test(ch);

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
// 型号后用「size」二字**显式**标注尺寸（甲方点名的第三种写法）：1-101 size0 / 1-101 size 0 / GPN size #1
// 只在前面几种写法都没命中时才用；取到的数字仍必须逐字符命中该型号的目录档位，否则整个候选作废
const SUF_SIZE_WORD_RE = new RegExp('^[^0-9]{0,14}?(?:^|[^A-Za-z])size[\\s\\-_]*#?[\\s\\-_]*' + SIZE + '(?![0-9])\\s*#?', 'i');

interface Candidate {
  hit: CatalogModelEntry;
  key: string;
  start: number;
  end: number;
}

/** 名字里所有「目录型号」候选（按紧凑键长度从长到短，同长取靠左） */
function candidates(raw: string, index: Map<string, CatalogModelEntry>): Candidate[] {
  let c = '';
  const rawAt: number[] = []; // 紧凑串第 i 位对应的原串下标
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/[0-9A-Za-z]/.test(ch)) {
      c += ch.toLowerCase();
      rawAt.push(i);
    }
  }
  const out: Candidate[] = [];
  for (const [key, hit] of index) {
    let from = 0;
    for (;;) {
      const p = c.indexOf(key, from);
      if (p < 0) break;
      out.push({ hit, key, start: rawAt[p], end: rawAt[p + key.length - 1] + 1 });
      from = p + 1;
    }
  }
  out.sort((a, b) => b.key.length - a.key.length || a.start - b.start);
  return out;
}

/**
 * 解析产品名并给出「为什么没锚定」的说明（报告用）。
 * 锚定不到目录（型号不在目录 / 尺寸有歧义 / size 不在档位）时 result 为 null —— 绝不猜。
 */
export function explainProductModel(
  name: string | null | undefined,
  index: Map<string, CatalogModelEntry> = catalogModelIndex(),
): ExplainResult {
  const raw = toHalfWidth(name).trim();
  if (!raw) return { result: null, reason: '空名称' };
  if (!index || index.size === 0) return { result: null, reason: '型号索引为空' };
  let reason: string | null = null;

  for (const cand of candidates(raw, index)) {
    // ① 左边必须边界对齐（串首 或 非字母数字的分隔符）
    if (cand.start > 0 && isAlnum(raw[cand.start - 1])) continue;
    const before = raw.slice(0, cand.start);
    const after = raw.slice(cand.end);
    const gluedOk = /[a-z]$/.test(cand.key);

    const preM = before.match(PREFIX_RE);
    const sufNear = after.match(SUF_NEAR_RE);
    const sufM =
      sufNear ??
      (gluedOk ? after.match(SUF_GLUED_RE) : null) ??
      after.match(SUF_HASH_AFTER_RE) ??
      after.match(SUF_HASH_BEFORE_RE) ?? after.match(SUF_SIZE_WORD_RE);
    const pre = preM ? preM[1] : null;
    const suf = sufM ? sufM[1] : null;

    // ② 前后都有数字且不同 → 尺寸有歧义，不猜（换下一个候选）
    if (pre && suf && pre !== suf) {
      reason = '尺寸有歧义（型号前 ' + pre + ' / 型号后 ' + suf + '）';
      continue;
    }

    const base = {
      series: cand.hit.series,
      seriesCode: cand.hit.seriesCode,
      model: cand.hit.model,
      gasType: cand.hit.gasType,
    };

    const size = pre ?? suf;
    if (size == null) {
      // 型号**前面**还有解析不掉的数字（如 0000-GPN 的 0000，不是目录档位）→ 尺寸未定，作废
      const leftRun = before.match(/(^|[^0-9])([0-9]+)\s*#?[\s\-_]*$/);
      if (leftRun) {
        reason = '尺寸不在目录档位（型号前数字 ' + leftRun[2] + '）';
        continue;
      }
      // 型号后面既没有合法 size，又紧贴着字母数字 → 边界不干净（多半是别的编号），作废
      if (cand.end < raw.length && isAlnum(raw[cand.end])) {
        reason = '型号边界不干净（右侧紧贴 ' + raw[cand.end] + '）';
        continue;
      }
      return {
        result: { ...base, size: null, orificeMm: null, thicknessRange: null, sizeKnown: false },
        reason: null,
      };
    }
    // ③ size 必须是该型号目录里真实存在的档位（逐字符，含前导零）
    const row = cand.hit.bySize.get(size);
    // size 不在档位里（例如把货号 / 变体号 PNME18 的 18 当 size）→ **整个候选作废、不当成「型号无尺寸」**：
    // 尺寸没定死就放过，会让不同尺寸互相命中（价格错误代价高）。
    if (!row) {
      reason = '尺寸不在目录档位（候选数字 ' + size + '）';
      continue;
    }
    return {
      result: { ...base, size, orificeMm: row.orifice, thicknessRange: row.thickness, sizeKnown: true },
      reason: null,
    };
  }
  return { result: null, reason: reason ?? '型号未锚定到目录' };
}

/** 只要结论：锚定不到目录（或尺寸有歧义）时返回 null */
export function parseProductModel(
  name: string | null | undefined,
  index: Map<string, CatalogModelEntry> = catalogModelIndex(),
): ProductModelInfo | null {
  return explainProductModel(name, index).result;
}

/**
 * 「基础型号 + size」是否相同 —— **型号命中的唯一权威判定**（两个写法都必须能锚定到目录）。
 * 任一写法锚定不到 → false（保持缺价，绝不编造）。
 */
export function sameCatalogProduct(
  a: string | null | undefined,
  b: string | null | undefined,
  index: Map<string, CatalogModelEntry> = catalogModelIndex(),
): boolean {
  const x = parseProductModel(a, index);
  const y = parseProductModel(b, index);
  if (!x || !y) return false;
  return x.model === y.model && x.size === y.size;
}

/** 目录里是否存在该型号（名称锚定用，不看 size） */
export function catalogModelOf(name: string | null | undefined): CatalogModel | null {
  const hit = parseProductModel(name);
  if (!hit) return null;
  for (const s of CATALOG_SERIES) {
    const m = s.models.find((x) => x.model === hit.model);
    if (m) return m;
  }
  return null;
}

/**
 * ============================================================
 * 产品档案候选匹配（识单补价 / 落草稿 / 报价导入**共用同一实现**）
 * ------------------------------------------------------------
 * 这是「产品名 → 档案」的唯一权威选法，优先级从高到低：
 *   ① exact     —— 产品名 trim 后完全相同（老口径，最可靠）；
 *   ② catalog   —— **基础型号 + size 相同**（甲方规则；品牌/描述前缀差异不影响，
 *                  但 size 必须逐字符一致：0 / 00 / 000 是三个不同尺寸，绝不互相命中）；
 *   ③ substring —— 老口径的子串容错（只允许描述/品牌前缀差异），**必须带数字指纹守卫**
 *                  （sameProductDigits），否则「1-101」会错落到「1-101 割嘴 00#」。
 * 命中多个候选时**不自动选**：返回全部候选，由调用方按「多候选 = 待人工选择」处理（宁缺勿错）。
 */
export type ProductMatchKind = 'exact' | 'catalog' | 'substring' | 'none';

export interface ProductCandidate {
  id: number;
  name: string;
}

export interface ProductCandidateResult<T extends ProductCandidate> {
  kind: ProductMatchKind;
  hits: T[];
}

/**
 * 在档案集合里找 name 的候选档案。
 * @param opts.substring 是否允许第 ③ 档子串容错（默认 true；报价导入按老口径传 false）
 * @param opts.sameDigits 数字指纹守卫（由调用方注入 table-parser 的 sameProductDigits，避免循环依赖）
 * @param opts.normName 文本归一（默认与 table-parser 的 normalizeToken 同口径，可注入覆盖）
 */
export function findProductCandidates<T extends ProductCandidate>(
  name: string,
  all: T[],
  opts: { substring?: boolean; sameDigits?: (a: string, b: string) => boolean; normName?: (s: string) => string } = {},
): ProductCandidateResult<T> {
  const raw = (name ?? '').trim();
  if (!raw) return { kind: 'none', hits: [] };

  // ① 名称完全相同
  const exact = all.filter((p) => p.name.trim() === raw);
  if (exact.length) return { kind: 'exact', hits: exact };

  const index = catalogModelIndex();
  const mine = parseProductModel(raw, index);

  // ② 基础型号 + size 相同（目录锚定口径）
  if (mine) {
    let hits = all.filter((p) => {
      const other = parseProductModel(p.name, index);
      return !!other && other.model === mine.model && other.size === mine.size;
    });
    // ②' 多个档案是「同一型号同一尺寸的不同写法」时，用**整名数字指纹**再收一次窄：
    //     例如 ANME 3/64 与「乙炔割嘴 ANME 3/64 92g」同为 (ANME, 3/64)，但数字指纹 3-64 ≠ 3-64-92，
    //     后者是带重量的另一写法 → 收窄到指纹一致的那一条，避免「多候选」把本来唯一的命中弄丢。
    //     收窄后仍多候选 → 如实返回多候选（交人工，绝不乱挑）。
    if (hits.length > 1 && opts.sameDigits) {
      const tight = hits.filter((p) => opts.sameDigits!(raw, p.name));
      if (tight.length) hits = tight;
    }
    if (hits.length) return { kind: 'catalog', hits };
  }

  // ③ 子串容错（老口径）+ 数字指纹守卫
  if (opts.substring !== false) {
    const norm = opts.normName ?? defaultNormName;
    const sameDigits = opts.sameDigits ?? (() => false);
    const nn = norm(raw);
    const hits = nn
      ? all.filter((p) => sameDigits(raw, p.name) && (nn.includes(norm(p.name)) || norm(p.name).includes(nn)))
      : [];
    if (hits.length) return { kind: 'substring', hits };
  }
  return { kind: 'none', hits: [] };
}

/** 兜底文本归一（与 table-parser.service.ts 的 normalizeToken 同口径；调用方可注入覆盖） */
function defaultNormName(s: string): string {
  return String(s ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[（）()：:*，,。、.．\-_/／【】\[\]「」'’“”"]/g, '');
}
