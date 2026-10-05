/**
 * 币种归一（I17 甲方裁定，2026-10-05）
 * ------------------------------------------------------------------
 * 裁定原文：「**币种统一归一为 CNY**：识别到的 RMB / RMB¥ / ￥ / ¥ / 人民币 等一律归一到 CNY
 * 存储与展示（写入前归一，加单测）。」
 *
 * 落地口径：
 *   · 唯一权威实现在本文件（纯函数，无 DB / 无 IO，可单测）；
 *   · 报价记录（product_quotes.currency）、识单结果（order_lines.currency）、
 *     计划/应收快照等**所有写入路径**都先过 normalizeCurrency() 再落库；
 *   · 只保留两个规范值：CNY（人民币）/ USD（美元），其余写法一律视为别名；
 *   · 未填写 / 无法识别 → CNY（一期单币种记账，人民币是默认口径，不做「猜外币」）。
 *
 * 已知边界（如实记录，未擅自扩大改动面）：
 *   · orders.order_lines / plan 侧历史行里已有的 'RMB' 不迁移（迁移只新增）；
 *     新写入一律 CNY；历史 RMB 行在展示口径上仍是 RMB（如需一次性刷成 CNY，见报告里的可选 SQL）。
 */

/** 规范币种（存储与展示的唯一取值） */
export const CANONICAL_CURRENCIES = ['CNY', 'USD'] as const;
export type CanonicalCurrency = (typeof CANONICAL_CURRENCIES)[number];

/** 人民币家族的写法（全部归一到 CNY） */
const CNY_ALIASES = ['rmb', 'cny', '人民币', '人民幣', '元', '圆', '圓', '块', '塊', '￥', '¥', 'rmb¥', 'rmb￥'];
/** 美元家族的写法（全部归一到 USD） */
const USD_ALIASES = ['usd', 'us$', 'usd$', '$', '美元', '美金', 'us dollar', 'usdollar'];

/**
 * 币种文本 → 规范币种（CNY / USD）。
 * 匹配规则：先做归一化（去空白 + 转小写 + 全角转半角符号），再按「美元家族 → 人民币家族」判定，
 * 命中即返回；都不命中（含空值）按 CNY 处理 —— 绝不因为认不出就编造外币。
 */
export function normalizeCurrency(input?: string | null): CanonicalCurrency {
  const raw = String(input ?? '')
    .replace(/[\uFF04\uFFE0\uFFE1]/g, '$') // 全角 ＄ ￠ ￡ 归一（仅符号层面）
    .trim();
  if (!raw) return 'CNY';
  const c = raw.toLowerCase().replace(/[\s\u3000]/g, '');
  if (USD_ALIASES.some((a) => c === a || c.includes(a))) return 'USD';
  if (CNY_ALIASES.some((a) => c === a || c.includes(a))) return 'CNY';
  return 'CNY';
}

/** 是否为规范币种（用于校验入参；大小写不敏感） */
export function isCanonicalCurrency(v?: string | null): v is CanonicalCurrency {
  const c = String(v ?? '').trim().toUpperCase();
  return (CANONICAL_CURRENCIES as readonly string[]).includes(c);
}

/** 展示用标签（与规范值一致；留出扩展余地） */
export function currencyLabel(v?: string | null): string {
  return normalizeCurrency(v);
}
