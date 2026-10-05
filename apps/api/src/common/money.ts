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

/**
 * 税率定点助手（I16 开票）—— 纯新增，不改动以上既有行为
 * ------------------------------------------------------------------
 * 背景：税率是 0.13/0.09/0.06/0.01/0 这类最多 4 位小数的比率，
 * 直接「分 × 0.13」是 binary64 乘法，结果再四舍五入会在边界值上漂移。
 * 做法：先把税率放大成整数「万分点」，与整数分相乘得到整数乘积，
 * 再用整数取余做半进位四舍五入 —— 全程整数运算，无浮点参与取整判定。
 */
export const RATE_SCALE = 10000; // 万分点：0.13 → 1300

/** 税率（如 0.13）→ 万分点整数（如 1300）；非有限数按 0 处理 */
export const rateToBp = (rate: number | string | null | undefined): number => {
  const n = typeof rate === 'string' ? Number(rate) : (rate ?? 0);
  return Number.isFinite(n) ? Math.round(n * RATE_SCALE) : 0;
};

/** 万分点整数 → 税率（如 1300 → 0.13） */
export const bpToRate = (bp: number): number => Math.round(bp) / RATE_SCALE;

/** 不含税金额（分）× 税率 → 税额（分）：四舍五入到整分（整数域半进位，无浮点取整） */
export const taxCentsOf = (exclCents: number, rate: number | string | null | undefined): number => {
  const p = Math.round(exclCents) * rateToBp(rate); // 单位：万分之一分
  const r = p % RATE_SCALE; // 精确整数取余
  const q = (p - r) / RATE_SCALE; // 整除（(p-r) 必为 RATE_SCALE 的整数倍，除法无误差）
  return r * 2 >= RATE_SCALE ? q + 1 : q; // 半进位
};

/** 含税金额（分）= 不含税 + 税额（整数相加，无尾差） */
export const inclCentsOf = (exclCents: number, taxCents: number): number =>
  Math.round(exclCents) + Math.round(taxCents);
