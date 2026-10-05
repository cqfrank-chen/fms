import { normalizeToken } from '../ai/table-parser.service';

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
  /** 报价记录里的原币种（CNY / RMB / USD） */
  currency: string;
  validFrom: string | null;
  validTo: string | null;
  source: string;
  productName: string | null;
  remark: string | null;
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

/** 产品匹配方式：productId 精确 / productName 文本 / anyProduct 完全通用（该报价不限定产品） */
type ProductMatch = 'productId' | 'productName' | 'anyProduct';

/** 报价是否与本条查询的产品对得上；null = 对不上 */
export function matchQuoteProduct(q: QuoteLike, query: PriceQuery): ProductMatch | null {
  if (query.productId != null && q.productId != null && q.productId === query.productId) return 'productId';
  const qn = normalizeToken(q.productName ?? '');
  const pn = normalizeToken(query.productName ?? '');
  if (qn && pn && qn === pn) return 'productName';
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
  const tiers: Record<PriceRule, QuoteLike[]> = { customer_product: [], customer_name: [], generic: [] };

  for (const q of quotes) {
    if (!quoteIsEffective(q, onDate)) continue;
    const m = matchQuoteProduct(q, query);
    if (!m) continue;
    // 客户档：只有「本客户」或「通用价」两种归属，不跨客户取价
    if (q.customerId != null && (query.customerId == null || q.customerId !== query.customerId)) continue;
    tiers[ruleOf(q, m)].push(q);
  }

  for (const rule of ['customer_product', 'customer_name', 'generic'] as PriceRule[]) {
    const pool = tiers[rule];
    if (!pool.length) continue;
    // 同一档内：valid_from 最新（null 视为最早）；再取 id 最大（最近录入）
    const best = pool.slice().sort((a, b) => {
      const af = a.validFrom ?? '';
      const bf = b.validFrom ?? '';
      if (af !== bf) return af < bf ? 1 : -1;
      return b.id - a.id;
    })[0];
    return {
      quoteId: best.id,
      rule,
      ruleText: PRICE_RULE_LABEL[rule],
      unitPriceCents: Math.round(best.unitPriceCents),
      currency: best.currency || 'CNY',
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
 * 报价币种 → 订单行币种枚举（orders 侧只有 RMB / USD，报价侧默认 CNY）。
 * CNY / RMB / 人民币 / ￥ 一律归一为 RMB；其余（USD / 美元 / $）归一为 USD，无法识别按 RMB。
 */
export function currencyToOrderEnum(currency?: string | null): 'RMB' | 'USD' {
  const c = normalizeToken(currency ?? '');
  if (!c) return 'RMB';
  if (c === 'usd' || c.includes('美元') || c === '$' || c.includes('usd')) return 'USD';
  return 'RMB';
}

/** 命中说明（中文一句话，识单 notes / 界面提示共用，保证「来源可追溯」） */
export function describeHit(hit: PriceHit): string {
  const p = (hit.unitPriceCents / 100).toFixed(2);
  const span = hit.validFrom || hit.validTo
    ? '（有效期 ' + (hit.validFrom ?? '不限') + ' ~ ' + (hit.validTo ?? '不限') + '）'
    : '';
  return '单价 ' + p + ' ' + hit.currency + ' 取自报价记录 #' + hit.quoteId + '［' + hit.ruleText + '］' + span;
}
