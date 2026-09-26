/**
 * 金额定点工具（以“分”为最小单位）
 * ------------------------------------------------------------------
 * 背景：DB 金额列为 numeric(10,2)；Drizzle 以 mode:'number' 读取为 JS number，
 * 跨行累加在 binary64 下会产生分位尾差（如 0.1+0.2）。所有“计算后落库/比较”的
 * 金额一律走本工具，消除浮点不确定性。
 * 约定：单价最多 2 位小数、数量为整数，因此 行金额(分) = 数量 × round(单价×100) 为精确值。
 */

/** 元 → 分（四舍五入到整分） */
export const toCents = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? Number(v) : (v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/** 分 → 元 */
export const fromCents = (cents: number): number => Math.round(cents) / 100;

/** 行金额（分）：整数数量 × 单价（2 位小数内），精确无浮点 */
export const lineCents = (quantity: number, unitPrice: number | string): number =>
  Math.round(quantity) * toCents(unitPrice);

/** 多行金额合计（分） */
export const sumLineCents = (
  lines: Array<{ quantity: number; unitPrice: number | string }>,
): number => lines.reduce((s, l) => s + lineCents(l.quantity, l.unitPrice), 0);

/** 元 → 两位小数（写入/展示前的最后一步） */
export const round2 = (v: number | string): number => fromCents(toCents(v));

/** 金额比较容差：半分（与 2 位小数精度一致；原实现用 0.009 ≈ 1 分，过宽） */
export const MONEY_EPS = 0.005;

/** 两金额是否相等（按分） */
export const centsEq = (a: number | string, b: number | string): boolean => toCents(a) === toCents(b);

/** a 是否大于 b（按分，严格） */
export const centsGt = (a: number | string, b: number | string): boolean => toCents(a) > toCents(b);

/** 剩余金额（元，非负）：amount - settled，按分计算 */
export const remainOf = (amount: number | string, settled: number | string): number =>
  Math.max(0, fromCents(toCents(amount) - toCents(settled)));
