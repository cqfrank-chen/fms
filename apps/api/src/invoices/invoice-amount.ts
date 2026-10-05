import { BadRequestException } from '@nestjs/common';
import { RATE_SCALE, bpToRate, fromCents, inclCentsOf, rateToBp, taxCentsOf } from '../common/money';

/**
 * 开票金额「三兄弟」校验（I16）—— 纯函数，无 IO，便于单测
 * ------------------------------------------------------------------
 * 恒等式（服务端强校验，全部按「分」的整数运算，禁用浮点直算）：
 *   1) tax_cents            = round(amount_excl_cents × tax_rate)   —— 见 money.taxCentsOf（万分点定点）
 *   2) amount_incl_cents    = amount_excl_cents + tax_cents         —— 整数相加，无尾差
 *   3) 三者均 ≥ 0，且含税金额必须 > 0
 * 校验失败一律 BadRequestException，中文提示明确指出：字段、期望值、实际值。
 */

export interface InvoiceAmountInput {
  /** 不含税金额（分，整数）；与 amountInclCents 至少给一个 */
  amountExclCents?: unknown;
  /** 税率（0 ~ 1，最多 4 位小数，如 0.13；缺省按 0 = 不含税金额与含税金额相同、税额 0） */
  taxRate?: unknown;
  /** 税额（分，选填；填了就必须与 不含税×税率 的定点结果完全一致） */
  taxCents?: unknown;
  /** 含税金额（分，整数）；简化交互主路径：只给这一个，服务端反解不含税与税额 */
  amountInclCents?: unknown;
}

export interface NormalizedInvoiceAmounts {
  amountExclCents: number;
  taxRate: number;
  taxCents: number;
  amountInclCents: number;
}

const isAbsent = (v: unknown): boolean => v === undefined || v === null || v === '';

/** 字段取数：非数字直接拒绝（含中文提示） */
const numField = (v: unknown, field: string, cn: string): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new BadRequestException(`${cn}（${field}）必须是数字，实际：${JSON.stringify(v ?? null)}`);
  }
  return n;
};

/** 整数字段校验（金额单位是「分」，不允许带小数） */
const intField = (v: number, field: string, cn: string): number => {
  if (!Number.isInteger(v)) {
    throw new BadRequestException(`${cn}（${field}）必须是整数「分」，实际：${v}`);
  }
  return v;
};

/** 分 → 中文金额文案：16.05 元（1605 分） */
export const yuanText = (cents: number): string => `${fromCents(cents).toFixed(2)} 元（${cents} 分）`;

/** 税率 → 百分比文案：13%、1%、0% */
export const rateText = (rate: number): string => `${Number((rate * 100).toFixed(4))}%`;

/**
 * 由「含税金额 + 税率」反解「不含税金额」：解 excl 使 taxCentsOf(excl, rate) === incl − excl。
 * 初值 excl ≈ incl × SCALE / (SCALE + bp)，再在 ±2 分内做整数试探（避免浮点直接反解产生分位偏差）。
 * 无解返回 null（该含税金额在给定税率下不存在合法的分位拆分）。
 */
export const solveExclFromIncl = (incl: number, rate: number): number | null => {
  // 负数（红字发票）按绝对值反解后取负，保证与正数完全镜像
  if (Math.round(incl) < 0) {
    const solved = solveExclFromIncl(-Math.round(incl), rate);
    return solved === null ? null : -solved;
  }
  const d = RATE_SCALE + rateToBp(rate);
  const num = Math.round(incl) * RATE_SCALE;
  const base = Math.floor(num / d);
  const rem = num - base * d;
  const guess = rem * 2 >= d ? base + 1 : base;
  for (let off = 0; off <= 2; off += 1) {
    const candidates = off === 0 ? [guess] : [guess - off, guess + off];
    for (const cand of candidates) {
      if (cand < 0) continue;
      if (taxCentsOf(cand, rate) === Math.round(incl) - cand) return cand;
    }
  }
  return null;
};

export interface NormalizeInvoiceOptions {
  /** 红字发票场景：允许（且要求）三金额为负数，恒等式按绝对值对称校验 */
  allowNegative?: boolean;
}

/** 税额期望值：正数用定点半进位；负数按绝对值对称（红字票与原票逐分镜像，净额才可能精确归零） */
const expectTaxOf = (excl: number, rate: number): number =>
  excl < 0 ? -taxCentsOf(-excl, rate) : taxCentsOf(excl, rate);

/**
 * 校验并归一化开票金额。
 * · 简化入参（推荐）：只给 amountInclCents（含税，单位分），税率缺省 0 → 不含税 = 含税、税额 = 0；
 * · 完整入参（兼容既有调用）：给 amountExclCents（± taxCents/amountInclCents），按三金额恒等式强校验；
 * · 红字发票（opts.allowNegative=true）：三金额必须为负，校验口径与正数镜像。
 */
export function normalizeInvoiceAmounts(input: InvoiceAmountInput, opts: NormalizeInvoiceOptions = {}): NormalizedInvoiceAmounts {
  const allowNeg = opts.allowNegative === true;
  const noExcl = isAbsent(input.amountExclCents);
  const noIncl = isAbsent(input.amountInclCents);
  if (noExcl && noIncl) {
    throw new BadRequestException('开票金额必填：请提供不含税金额（amountExclCents）或含税金额（amountInclCents），单位：分');
  }

  const rawRate = isAbsent(input.taxRate) ? 0 : numField(input.taxRate, 'taxRate', '税率');
  const bp = rateToBp(rawRate);
  if (bp < 0 || bp > RATE_SCALE) {
    throw new BadRequestException(`税率（taxRate）须在 0 ~ 1 之间（最多 4 位小数，如 0.13），实际：${rawRate}`);
  }
  const rate = bpToRate(bp);

  // 不含税金额：显式给 → 直接用；只给含税 → 反解（含税 − 税额 或 按税率定点反解）
  let excl: number;
  if (!noExcl) {
    excl = intField(numField(input.amountExclCents, 'amountExclCents', '不含税金额'), 'amountExclCents', '不含税金额');
    if (!allowNeg && excl < 0) {
      throw new BadRequestException(`不含税金额（amountExclCents）不能为负，实际：${excl} 分`);
    }
    if (allowNeg && excl >= 0) {
      throw new BadRequestException(`红字发票的不含税金额必须为负数（红冲金额），实际：${excl} 分`);
    }
  } else {
    const incl = intField(numField(input.amountInclCents, 'amountInclCents', '含税金额'), 'amountInclCents', '含税金额');
    if (!allowNeg && incl < 0) {
      throw new BadRequestException(`含税金额（amountInclCents）不能为负，实际：${incl} 分`);
    }
    if (!allowNeg && incl <= 0) {
      throw new BadRequestException(`含税金额必须大于 0：实际 ${yuanText(incl)}`);
    }
    if (allowNeg && incl >= 0) {
      throw new BadRequestException(`红字发票的含税金额必须为负数（红冲金额），实际：${incl} 分`);
    }
    if (!isAbsent(input.taxCents)) {
      const tax = intField(numField(input.taxCents, 'taxCents', '税额'), 'taxCents', '税额');
      if (!allowNeg && tax < 0) {
        throw new BadRequestException(`税额（taxCents）不能为负，实际：${tax} 分`);
      }
      if (allowNeg && tax > 0) {
        throw new BadRequestException(`红字发票的税额必须为负数或 0，实际：${tax} 分`);
      }
      if (!allowNeg && tax > incl) {
        throw new BadRequestException(`含税金额（amountInclCents）${yuanText(incl)} 小于税额（taxCents）${yuanText(tax)}，无法反解不含税金额`);
      }
      excl = incl - tax;
    } else {
      const solved = solveExclFromIncl(incl, rate);
      if (solved === null) {
        throw new BadRequestException(
          `按含税金额 ${yuanText(incl)} 与税率 ${rateText(rate)} 无法反解出不含税金额与税额（三金额恒等式无整数分解）：请显式提供 amountExclCents 与 taxCents`,
        );
      }
      excl = solved;
    }
  }

  // 恒等式 1：税额 = round(不含税 × 税率)（负数按绝对值对称）
  const expectTax = expectTaxOf(excl, rate);
  let tax = expectTax;
  if (!isAbsent(input.taxCents)) {
    const provided = intField(numField(input.taxCents, 'taxCents', '税额'), 'taxCents', '税额');
    if (!allowNeg && provided < 0) {
      throw new BadRequestException(`税额（taxCents）不能为负，实际：${provided} 分`);
    }
    if (allowNeg && provided > 0) {
      throw new BadRequestException(`红字发票的税额必须为负数或 0，实际：${provided} 分`);
    }
    if (provided !== expectTax) {
      throw new BadRequestException(
        `税额（taxCents）与不含税金额/税率不一致：${yuanText(excl)} × ${rateText(rate)}，期望 ${yuanText(expectTax)}，实际 ${yuanText(provided)}`,
      );
    }
    tax = provided;
  }

  // 恒等式 2：含税 = 不含税 + 税额；恒等式 3：正常票含税 > 0 / 红字票含税 < 0
  const expectIncl = inclCentsOf(excl, tax);
  if (!allowNeg && expectIncl <= 0) {
    throw new BadRequestException(
      `含税金额必须大于 0：不含税 ${yuanText(excl)} + 税额 ${yuanText(tax)} = ${yuanText(expectIncl)}`,
    );
  }
  if (allowNeg && expectIncl >= 0) {
    throw new BadRequestException(
      `红字发票的含税金额必须小于 0：不含税 ${yuanText(excl)} + 税额 ${yuanText(tax)} = ${yuanText(expectIncl)}`,
    );
  }
  let incl = expectIncl;
  if (!isAbsent(input.amountInclCents)) {
    const provided = intField(numField(input.amountInclCents, 'amountInclCents', '含税金额'), 'amountInclCents', '含税金额');
    if (!allowNeg && provided < 0) {
      throw new BadRequestException(`含税金额（amountInclCents）不能为负，实际：${provided} 分`);
    }
    if (provided !== expectIncl) {
      throw new BadRequestException(
        `含税金额（amountInclCents）不等于 不含税金额 + 税额：期望 ${yuanText(expectIncl)}（＝ ${yuanText(excl)} + ${yuanText(tax)}），实际 ${yuanText(provided)}`,
      );
    }
    incl = provided;
  }

  return { amountExclCents: excl, taxRate: rate, taxCents: tax, amountInclCents: incl };
}
