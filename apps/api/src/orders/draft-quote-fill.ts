import type { PriceHit, PriceQuery } from '../quotes/quote-pricing';

/**
 * 落草稿的「缺价 → 报价补价」纯逻辑（I17 甲方裁定④）
 * ==================================================================
 * 裁定原文：「.doc 计划单缺价按报价记录自动回填历史价：识单/落草稿管线里，缺 unitPrice 的行按
 * 「文件夹客户 + 产品」查报价记录补价并标 priceFrom='quote'（已有能力，请确保 .doc 管线也走同一补价路径），
 * 未命中保持待补。」
 *
 * 为什么单独抽一个纯函数模块：
 *   · .doc 切片管线的识单接口（/ai/orders/parse）与落草稿接口（/orders/draft）必须**同一口径**；
 *   · 把「哪些行要补价 / 查询条件是什么 / 命中怎么回填」做成无 DB 纯函数 → 可单测、可复用，
 *     不会因为两条通道各自实现而漂移。
 *
 * 判定口径：
 *   · 只有**缺单价**的行参与补价（单据自带价格的行绝不被覆盖）；
 *   · 查询条件 = 客户（真实档案 id；客户未建档时只能命中「通用价」）+ 产品（档案 id 优先，
 *     其次产品名文本）；
 *   · 命中的行回填单价并标 priceFrom='quote'（可追溯报价单号）；未命中保持缺价待补。
 */

/** 参与补价判定的一行（与 orders.service 的落草稿行一一对应） */
export interface DraftQuoteLine {
  /** 已建档产品 id；未建档传 null */
  productId: number | null;
  /** 产品原文（未建档时按名称文本匹配） */
  productName: string | null;
  /** 该行是否已经有单价（有 → 不参与补价） */
  hasPrice: boolean;
}

/** 需要补价的行：原行下标 + 取价查询条件 */
export interface DraftQuoteTarget {
  index: number;
  query: PriceQuery;
}

/** 命中结果（回填用）：单价（分）+ 报价单号 + 中文规则说明 */
export interface DraftQuoteFill {
  unitPriceCents: number;
  quoteId: number;
  ruleText: string;
}

/**
 * 挑出需要补价的行并给出取价条件（顺序与入参一致，可直接喂给 quotes.lookupMany）。
 * @param customerId 客户档案 id；null = 客户未建档（只能命中通用价）
 */
export function quoteFillTargets(customerId: number | null, lines: DraftQuoteLine[]): DraftQuoteTarget[] {
  const out: DraftQuoteTarget[] = [];
  lines.forEach((l, index) => {
    if (l.hasPrice) return;
    out.push({
      index,
      query: {
        customerId,
        productId: l.productId ?? null,
        productName: l.productName ?? null,
      },
    });
  });
  return out;
}

/**
 * 把批量取价结果映射回行（入参为 quoteFillTargets 的顺序）。
 * @returns 与 lines 等长的数组；未命中的位置是 null（调用方保持缺价待补，绝不编造价格）
 */
export function resolveQuoteFills(
  lineCount: number,
  targets: DraftQuoteTarget[],
  hits: Array<PriceHit | null>,
): Array<DraftQuoteFill | null> {
  const out: Array<DraftQuoteFill | null> = new Array(lineCount).fill(null);
  targets.forEach((t, k) => {
    const h = hits[k];
    if (!h) return;
    out[t.index] = { unitPriceCents: Math.round(h.unitPriceCents), quoteId: h.quoteId, ruleText: h.ruleText };
  });
  return out;
}
