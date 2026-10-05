import { digitSignature, normalizeToken } from '../ai/table-parser.service';
import { sameCatalogProduct } from '../ai/product-model';
import { normalizeCurrency } from '../common/currency';
import type { CanonicalCurrency } from '../common/currency';

/**
 * ============================================================
 * 报价取价规则（I17）—— **服务端纯函数**，无 DB / 无 IO，可单测
 * ------------------------------------------------------------
 * 甲方口径：报价单是独立单据，价格会变，要能快速改、留历史、按有效期生效。
 * 取价优先级（逐档取，命中即止）：
 *   ① customer_product  客户 + 产品（按 product_id 精确命中）
 *   ② customer_name     客户 + 产品名文本（按产品名归一后相同；含「客户整体价」= 该客户下未指定产品的一条）
 *   ③ generic           通用价（customer_id 为空），同样须与产品对上（按 id / 按名称 / 完全通用）
 * 同一档内：先按「有效期过滤」（enabled = true、valid_from ≤ 当日、valid_to ≥ 当日），
 * 再取 **valid_from 最新** 的一条；valid_from 相同（含都为空）取 id 最大（最近录入）的一条。
 *
 * 说明：本文件与识单补价（ai/order-parser.service）和 /api/quotes/lookup 共用同一实现，
 * 避免「界面试算」与「识单补价」两套口径漂移。
 */

/** 命中的规则（返回值里的 priceSource，供前端标注「按哪条规则取到价」） */
export type PriceRule = 'customer_product' | 'customer_name' | 'generic';

export const PRICE_RULE_LABEL: Record<PriceRule, string> = {
  customer_product: '客户+产品',
  customer_name: '客户+产品名文本',
  generic: '通用价（不限客户）',
};

/** 取价输入的一条报价（DB 行 / 导入行的归一形态） */
export interface QuoteLike {
  id: number;
  /** 客户档案 id；null = 通用价（不限客户） */
  customerId: number | null;
  /** 产品档案 id；null = 只按产品名文本匹配 */
  productId: number | null;
  productName: string | null;
  unitPriceCents: number;
  currency: string;
  /** YYYY-MM-DD；null = 不设起始边界 */
  validFrom: string | null;
  /** YYYY-MM-DD；null = 不设到期边界 */
  validTo: string | null;
  source: string;
  enabled: boolean;
  remark?: string | null;
}

/** 取价查询条件（customerId / productId 可空：识别结果里客户或产品未建档时就是这种形态） */
export interface PriceQuery {
  customerId?: number | null;
  productId?: number | null;
  productName?: string | null;
  /** 取价基准日 YYYY-MM-DD（默认今天）；有效期按「含当日」判定 */
  onDate?: string | null;
}

export interface PriceHit {
  quoteId: number;
  rule: PriceRule;
  ruleText: string;
  unitPriceCents: number;
  /** 报价记录里的币种（甲方裁定后统一为 CNY / USD） */
  currency: string;
  validFrom: string | null;
  validTo: string | null;
  source: string;
  productName: string | null;
  remark: string | null;
  /** 这次是按哪种方式命中的（productId / 文本 / 基础型号+尺寸 / 通用），供上层留痕 */
  matchKind: ProductMatch;
}

/** 今天（本地时区）YYYY-MM-DD */
export function todayYmd(now: Date = new Date()): string {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
}

/**
 * 报价是否在基准日有效：停用的不算；valid_from / valid_to 为 null = 该侧不设边界。
 * 日期一律是 YYYY-MM-DD 字符串，字典序比较即日期比较（无时区换算，避免边界漂移）。
 */
export function quoteIsEffective(q: QuoteLike, onDate: string = todayYmd()): boolean {
  if (!q.enabled) return false;
  if (q.validFrom && q.validFrom > onDate) return false; // 尚未生效
  if (q.validTo && q.validTo < onDate) return false; // 已过期
  return true;
}

/**
 * 产品匹配方式：
 *   productId    报价挂的是同一个产品档案 id（精确口径）
 *   productName  产品名文本归一 + 数字指纹都相同
 *   catalogModel **基础型号 + size 相同**（甲方规则 2026：品牌/描述前缀差异可忽略，size 必须逐字符一致）
 *   anyProduct   完全通用（该报价既不挂产品也不写产品名）
 */
type ProductMatch = 'productId' | 'productName' | 'catalogModel' | 'anyProduct';

/** 命中方式的说明后缀（写进 ruleText，界面/识单备注可追溯「按哪条规则命中」） */
const MATCH_KIND_NOTE: Partial<Record<ProductMatch, string>> = {
  catalogModel: '基础型号+尺寸',
};

/**
 * 同一档内的**命中方式优先级**：数字越小越优先。
 * 文本完全相同（productName）比「基础型号+尺寸」（catalogModel）更强 —— 保留老口径的既有结果，
 * 只有在同档内没有文本/ID 级命中时才用 catalogModel 命中（这正是解锁缺价的新增路径）。
 */
const MATCH_RANK: Record<ProductMatch, number> = {
  productId: 0, productName: 1, catalogModel: 2, anyProduct: 3,
};

/** 命中档 + 命中方式 → 人读文案（如「客户+产品名文本（基础型号+尺寸）」） */
export function ruleTextOf(rule: PriceRule, kind: ProductMatch): string {
  const note = MATCH_KIND_NOTE[kind];
  return PRICE_RULE_LABEL[rule] + (note ? '（' + note + '）' : '');
}

/** 报价是否与本条查询的产品对得上；null = 对不上 */
export function matchQuoteProduct(q: QuoteLike, query: PriceQuery): ProductMatch | null {
  if (query.productId != null && q.productId != null && q.productId === query.productId) return 'productId';
  const qn = normalizeToken(q.productName ?? '');
  const pn = normalizeToken(query.productName ?? '');
  // 按名称匹配必须**双重相等**：文本归一相同（空格/全角/大小写/标点）+ 数字指纹相同。
  // 甲方更正：0-GPN 与 00-GPN 是同一型号的不同尺寸 → 0-GPN 的价**绝不允许**命中 00-GPN；
  // 同理 1-1-101 的价也不能命中 111-01（标点被归一后文本会假相等）。价格错误代价高，宁缺勿错。
  const qd = digitSignature(q.productName ?? '');
  const pd = digitSignature(query.productName ?? '');
  if (qn && pn && qn === pn && qd === pd) return 'productName';
  // ③ 按「基础型号 + size」匹配（甲方规则 2026，**解锁缺价的主路径**）：
  //    计划单写「1-1-101」、合同写「Victor 乙炔割嘴 1-1-101」→ 品牌/描述前缀差异不影响，命中；
  //    但 size 必须逐字符一致（0 / 00 / 000 是三档不同尺寸），跨 size **一律不命中**（宁缺勿错）。
  if (sameCatalogProduct(q.productName, query.productName)) return 'catalogModel';
  // 完全通用价：报价既不限产品也不写产品名 → 任何产品都可用（最低优先级的兜底）
  if (q.productId == null && !qn) return 'anyProduct';
  return null;
}

/** 归一化的命中档：仅在三档之间取，且与 productMatch 一一对应 */
function ruleOf(q: QuoteLike, match: ProductMatch): PriceRule {
  if (q.customerId == null) return 'generic'; // 客户为空 → 通用价（无论按 id 还是按名称对上产品）
  return match === 'productId' ? 'customer_product' : 'customer_name';
}

/**
 * 在候选集合里按「①客户+产品 > ②客户+产品名文本 > ③通用价」取价。
 * @returns 命中报价 + priceSource 说明；无命中返回 null（调用方保持「缺价待补」，不编造价格）
 */
export function pickQuote(quotes: QuoteLike[], query: PriceQuery): PriceHit | null {
  const onDate = query.onDate || todayYmd();
  const tiers: Record<PriceRule, Array<{ q: QuoteLike; m: ProductMatch }>> = {
    customer_product: [], customer_name: [], generic: [],
  };

  for (const q of quotes) {
    if (!quoteIsEffective(q, onDate)) continue;
    const m = matchQuoteProduct(q, query);
    if (!m) continue;
    // 客户档：只有「本客户」或「通用价」两种归属，不跨客户取价
    if (q.customerId != null && (query.customerId == null || q.customerId !== query.customerId)) continue;
    tiers[ruleOf(q, m)].push({ q, m });
  }

  for (const rule of ['customer_product', 'customer_name', 'generic'] as PriceRule[]) {
    const pool = tiers[rule];
    if (!pool.length) continue;
    // 同一档内：valid_from 最新（null 视为最早）；再取 id 最大（最近录入）
    const picked = pool.slice().sort((x, y) => {
      // 先按命中方式强度（文本 > 基础型号+尺寸），再按 valid_from 最新，最后按 id 最大
      const rx = MATCH_RANK[x.m];
      const ry = MATCH_RANK[y.m];
      if (rx !== ry) return rx - ry;
      const af = x.q.validFrom ?? '';
      const bf = y.q.validFrom ?? '';
      if (af !== bf) return af < bf ? 1 : -1;
      return y.q.id - x.q.id;
    })[0];
    const best = picked.q;
    return {
      quoteId: best.id,
      rule,
      ruleText: ruleTextOf(rule, picked.m),
      matchKind: picked.m,
      unitPriceCents: Math.round(best.unitPriceCents),
      currency: normalizeCurrency(best.currency),
      validFrom: best.validFrom,
      validTo: best.validTo,
      source: best.source,
      productName: best.productName,
      remark: best.remark ?? null,
    };
  }
  return null;
}

/**
 * 报价币种 → 订单行币种（I17 甲方裁定 2026-10-05：**币种统一归一为 CNY**）。
 * RMB / RMB¥ / ￥ / ¥ / 人民币 → CNY；USD / 美元 / $ → USD；缺省或认不出 → CNY。
 * 实现委托 common/currency.ts 的 normalizeCurrency（唯一权威实现，避免两处口径漂移）。
 * 保留本函数名是为兼容既有调用点（识单补价）。
 */
export function currencyToOrderEnum(currency?: string | null): CanonicalCurrency {
  return normalizeCurrency(currency);
}

/** 命中说明（中文一句话，识单 notes / 界面提示共用，保证「来源可追溯」） */
export function describeHit(hit: PriceHit): string {
  const p = (hit.unitPriceCents / 100).toFixed(2);
  const span = hit.validFrom || hit.validTo
    ? '（有效期 ' + (hit.validFrom ?? '不限') + ' ~ ' + (hit.validTo ?? '不限') + '）'
    : '';
  return '单价 ' + p + ' ' + hit.currency + ' 取自报价记录 #' + hit.quoteId + '［' + hit.ruleText + '］' + span;
}
