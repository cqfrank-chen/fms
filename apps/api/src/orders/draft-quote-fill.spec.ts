import { quoteFillTargets, resolveQuoteFills } from './draft-quote-fill';
import type { PriceHit } from '../quotes/quote-pricing';

/**
 * 落草稿「缺价 → 报价补价」纯逻辑单测（I17 甲方裁定④）
 * ------------------------------------------------------------------
 * 裁定：识单/落草稿管线里，缺 unitPrice 的行按「文件夹客户 + 产品」查报价记录补价并标 priceFrom='quote'；
 * 未命中保持待补。本文件覆盖目标挑选、查询条件、命中/未命中回填，以及「已带价的行不被覆盖」。
 */
const hit = (o: Partial<PriceHit> = {}): PriceHit => ({
  quoteId: 3,
  rule: 'customer_product',
  ruleText: '客户+产品',
  unitPriceCents: 1450,
  currency: 'CNY',
  validFrom: null,
  validTo: null,
  source: 'manual',
  productName: null,
  remark: null,
  ...o,
});

describe('quoteFillTargets：只有缺价行参与补价', () => {
  it('缺价行（unitPrice 为空）才生成取价查询；已带价的行跳过', () => {
    const targets = quoteFillTargets(7, [
      { productId: 22, productName: '1-101 割嘴', hasPrice: false },
      { productId: 23, productName: 'PNM 1/32', hasPrice: true },
      { productId: null, productName: '未建档产品', hasPrice: false },
    ]);
    expect(targets.map((t) => t.index)).toEqual([0, 2]);
    expect(targets[0].query).toEqual({ customerId: 7, productId: 22, productName: '1-101 割嘴' });
    expect(targets[1].query).toEqual({ customerId: 7, productId: null, productName: '未建档产品' });
  });

  it('客户未建档（customerId=null）时查询只可能命中通用价', () => {
    const targets = quoteFillTargets(null, [{ productId: null, productName: 'X', hasPrice: false }]);
    expect(targets[0].query.customerId).toBeNull();
  });

  it('全部带价 → 不需要补价', () => {
    expect(quoteFillTargets(7, [{ productId: 1, productName: 'A', hasPrice: true }])).toEqual([]);
  });
});

describe('resolveQuoteFills：命中补价、未命中保持缺价待补', () => {
  it('命中行回填单价（分）+ 报价单号 + 规则说明，未命中为 null', () => {
    const lines = [
      { productId: 22, productName: 'A', hasPrice: false },
      { productId: 23, productName: 'B', hasPrice: true },
      { productId: 24, productName: 'C', hasPrice: false },
    ];
    const targets = quoteFillTargets(7, lines);
    const fills = resolveQuoteFills(lines.length, targets, [hit({ quoteId: 5, unitPriceCents: 980 }), null]);
    expect(fills[0]).toEqual({ unitPriceCents: 980, quoteId: 5, ruleText: '客户+产品' });
    expect(fills[1]).toBeNull(); // 已带价的行不参与、也不被覆盖
    expect(fills[2]).toBeNull(); // 未命中 → 保持缺价待补（绝不编造价格）
  });

  it('空目标 / 空命中不炸', () => {
    expect(resolveQuoteFills(0, [], [])).toEqual([]);
    expect(resolveQuoteFills(2, quoteFillTargets(7, [{ productId: null, productName: null, hasPrice: false }]), [null])).toEqual([null, null]);
  });
});
