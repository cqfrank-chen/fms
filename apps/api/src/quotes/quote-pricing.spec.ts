import {
  currencyToOrderEnum, describeHit, matchQuoteProduct, pickQuote, PRICE_RULE_LABEL, quoteIsEffective, todayYmd,
} from './quote-pricing';
import type { QuoteLike } from './quote-pricing';

/**
 * 报价取价规则单元测试（纯函数，不连数据库）
 * ------------------------------------------------------------------
 * 甲方口径：报价单是独立单据，价格会变，要能快速改、留历史、按有效期生效。
 * 覆盖：
 *   ① 取价优先级：客户+产品 > 客户+产品名文本 > 通用价（逐档取，命中即止）
 *   ② 有效期过滤：enabled / valid_from 未生效 / valid_to 已过期
 *   ③ 同一档内取「valid_from 最新」，同 valid_from 取最近录入（id 最大）
 *   ④ 同档并列时不会跨客户取价（不串客户）
 *   ⑤ 币种归一到订单行枚举
 */

const q = (o: Partial<QuoteLike> & { id: number }): QuoteLike => ({
  customerId: null,
  productId: null,
  productName: null,
  unitPriceCents: 1000,
  currency: 'CNY',
  validFrom: null,
  validTo: null,
  source: 'manual',
  enabled: true,
  ...o,
});

const ON = '2026-06-15';

describe('① 取价优先级：客户+产品 > 客户+产品名文本 > 通用价', () => {
  const quotes: QuoteLike[] = [
    q({ id: 1, customerId: null, productId: null, productName: null, unitPriceCents: 300 }), // 通用兜底
    q({ id: 2, customerId: 7, productId: null, productName: '1-101 割嘴 00#', unitPriceCents: 900 }), // 客户+文本
    q({ id: 3, customerId: 7, productId: 22, productName: '1-101 割嘴 00# 特价', unitPriceCents: 1320 }), // 客户+产品
  ];

  it('三档都在 → 命中「客户+产品」', () => {
    const hit = pickQuote(quotes, { customerId: 7, productId: 22, productName: '1-101 割嘴 00#', onDate: ON })!;
    expect(hit.quoteId).toBe(3);
    expect(hit.rule).toBe('customer_product');
    expect(hit.ruleText).toBe(PRICE_RULE_LABEL.customer_product);
    expect(hit.unitPriceCents).toBe(1320);
  });

  it('没有「客户+产品」→ 退「客户+产品名文本」（产品名归一后相同即可：全角/空格/大小写不敏感）', () => {
    const hit = pickQuote(quotes, { customerId: 7, productId: 999, productName: '1-101　割嘴  00#', onDate: ON })!;
    expect(hit.quoteId).toBe(2);
    expect(hit.rule).toBe('customer_name');
    expect(hit.unitPriceCents).toBe(900);
  });

  it('「客户+产品」档按 product_id 命中时，产品名文本不一致也照样命中（id 是精确口径）', () => {
    const hit = pickQuote(quotes, { customerId: 7, productId: 22, productName: '别的写法', onDate: ON })!;
    expect(hit.quoteId).toBe(3);
    expect(hit.rule).toBe('customer_product');
  });

  it('客户档都没有 → 退「通用价（customer_id 为空）」', () => {
    const hit = pickQuote(quotes, { customerId: 99, productId: 22, productName: '1-101 割嘴 00#', onDate: ON })!;
    expect(hit.quoteId).toBe(1);
    expect(hit.rule).toBe('generic');
  });

  it('未识别到客户（customerId 为空）→ 只能命中通用价，绝不串到别家客户', () => {
    const hit = pickQuote(quotes, { customerId: null, productId: 22, productName: '1-101 割嘴 00#', onDate: ON })!;
    expect(hit.quoteId).toBe(1);
    expect(hit.rule).toBe('generic');
  });

  it('「完全通用价」（既不限客户也不限产品）是兜底：任何产品都能命中它', () => {
    const hit = pickQuote(quotes, { customerId: 7, productId: 88, productName: '完全不存在的产品', onDate: ON })!;
    expect(hit.quoteId).toBe(1);
    expect(hit.rule).toBe('generic');
  });

  it('没有任何可用报价 → 返回 null（保持缺价待补，不编造价格）', () => {
    const only = [q({ id: 5, customerId: 7, productId: 22, unitPriceCents: 500 })];
    expect(pickQuote(only, { customerId: 7, productId: 88, productName: '完全不存在的产品', onDate: ON })).toBeNull();
  });

  it('客户档不跨客户：客户 8 拿不到客户 7 的价（通用价仍可用）', () => {
    const onlyCustomer7 = [q({ id: 5, customerId: 7, productId: 22, unitPriceCents: 500 })];
    expect(pickQuote(onlyCustomer7, { customerId: 8, productId: 22, onDate: ON })).toBeNull();
  });
});

describe('② 有效期过滤（enabled / 未生效 / 已过期）', () => {
  it('停用的报价不参与取价', () => {
    const hit = pickQuote([q({ id: 1, productId: 22, enabled: false })], { productId: 22, onDate: ON });
    expect(hit).toBeNull();
  });

  it('valid_from 还没到 → 不生效', () => {
    const hit = pickQuote([q({ id: 1, productId: 22, validFrom: '2026-07-01' })], { productId: 22, onDate: ON });
    expect(hit).toBeNull();
  });

  it('valid_to 已过期 → 不生效', () => {
    const hit = pickQuote([q({ id: 1, productId: 22, validTo: '2026-06-14' })], { productId: 22, onDate: ON });
    expect(hit).toBeNull();
  });

  it('边界日含当日：valid_from = valid_to = 基准日 → 命中', () => {
    const hit = pickQuote([q({ id: 1, productId: 22, validFrom: ON, validTo: ON })], { productId: 22, onDate: ON })!;
    expect(hit.quoteId).toBe(1);
  });

  it('quoteIsEffective 直接判定（含默认基准日 = 今天）', () => {
    expect(quoteIsEffective(q({ id: 1 }), todayYmd())).toBe(true);
    expect(quoteIsEffective(q({ id: 1, enabled: false }), todayYmd())).toBe(false);
  });
});

describe('③ 同一档内取 valid_from 最新（同 valid_from 取 id 最大）', () => {
  it('客户+产品档有两条 → 取 valid_from 较新的那条', () => {
    const quotes = [
      q({ id: 1, customerId: 7, productId: 22, unitPriceCents: 1000, validFrom: '2026-01-01' }),
      q({ id: 2, customerId: 7, productId: 22, unitPriceCents: 1500, validFrom: '2026-06-01' }),
    ];
    const hit = pickQuote(quotes, { customerId: 7, productId: 22, onDate: ON })!;
    expect(hit.quoteId).toBe(2);
    expect(hit.unitPriceCents).toBe(1500);
  });

  it('valid_from 都为空 → 取 id 最大（最近录入）', () => {
    const quotes = [
      q({ id: 11, customerId: 7, productId: 22, unitPriceCents: 1000 }),
      q({ id: 12, customerId: 7, productId: 22, unitPriceCents: 1200 }),
    ];
    expect(pickQuote(quotes, { customerId: 7, productId: 22, onDate: ON })!.quoteId).toBe(12);
  });

  it('有 valid_from 的优先于没写的（视为最早）', () => {
    const quotes = [
      q({ id: 21, customerId: 7, productId: 22, unitPriceCents: 1000, validFrom: null }),
      q({ id: 22, customerId: 7, productId: 22, unitPriceCents: 900, validFrom: '2025-01-01' }),
    ];
    expect(pickQuote(quotes, { customerId: 7, productId: 22, onDate: ON })!.quoteId).toBe(22);
  });

  it('过期的最新价不参与（回退到仍有效的旧价）——「按有效期生效」的核心', () => {
    const quotes = [
      q({ id: 31, customerId: 7, productId: 22, unitPriceCents: 1000, validFrom: '2026-01-01', validTo: '2026-06-10' }), // 已过期的新价
      q({ id: 32, customerId: 7, productId: 22, unitPriceCents: 900, validFrom: '2025-01-01' }),
    ];
    const hit = pickQuote(quotes, { customerId: 7, productId: 22, onDate: '2026-06-15' })!;
    expect(hit.quoteId).toBe(32);
  });
});

describe('④ 产品匹配与其它', () => {
  it('matchQuoteProduct：按 id / 按名称 / 完全通用 三种命中，其余为 null', () => {
    expect(matchQuoteProduct(q({ id: 1, productId: 22 }), { productId: 22 })).toBe('productId');
    expect(matchQuoteProduct(q({ id: 1, productName: 'PNM 1/32' }), { productName: 'pnm 1/32' })).toBe('productName');
    expect(matchQuoteProduct(q({ id: 1 }), { productId: 22 })).toBe('anyProduct');
    expect(matchQuoteProduct(q({ id: 1, productId: 33 }), { productId: 22 })).toBeNull();
  });

  it('「客户整体价」（客户档、不指定产品）归入「客户+产品名文本」档，优先级低于精确产品价', () => {
    const quotes = [
      q({ id: 1, customerId: 7, unitPriceCents: 111 }), // 客户整体价
      q({ id: 2, customerId: 7, productId: 22, unitPriceCents: 222 }),
    ];
    expect(pickQuote(quotes, { customerId: 7, productId: 22, onDate: ON })!.quoteId).toBe(2);
    expect(pickQuote(quotes, { customerId: 7, productId: 999, onDate: ON })!.quoteId).toBe(1);
  });

  it('币种归一：CNY/RMB → RMB，USD → USD，缺省 RMB', () => {
    expect(currencyToOrderEnum('CNY')).toBe('RMB');
    expect(currencyToOrderEnum('rmb')).toBe('RMB');
    expect(currencyToOrderEnum('USD')).toBe('USD');
    expect(currencyToOrderEnum(null)).toBe('RMB');
  });

  it('describeHit：中文说明含报价单号、规则与有效期（来源可追溯）', () => {
    const hit = pickQuote([q({ id: 66, customerId: 7, productId: 22, unitPriceCents: 1320, validFrom: '2026-01-01' })],
      { customerId: 7, productId: 22, onDate: ON })!;
    const text = describeHit(hit);
    expect(text).toContain('13.20');
    expect(text).toContain('#66');
    expect(text).toContain(PRICE_RULE_LABEL.customer_product);
  });
});
