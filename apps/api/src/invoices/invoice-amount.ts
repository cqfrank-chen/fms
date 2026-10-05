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
  /** 不含税金额（分，必填，整数） */
  amountExclCents?: unknown;
  /** 税率（0 ~ 1，最多 4 位小数，如 0.13；缺省按 0） */
  taxRate?: unknown;
  /** 税额（分，选填；填了就必须与 不含税×税率 的定点结果完全一致） */
  taxCents?: unknown;
  /** 含税金额（分，选填；填了就必须等于 不含税+税额） */
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
 * 校验并归一化开票金额。
 * 税额/含税金额未提供时按恒等式自动计算（前端可只填不含税金额与税率）。
 */
export function normalizeInvoiceAmounts(input: InvoiceAmountInput): NormalizedInvoiceAmounts {
  if (isAbsent(input.amountExclCents)) {
    throw new BadRequestException('不含税金额（amountExclCents，单位：分）必填');
  }
  const excl = intField(numField(input.amountExclCents, 'amountExclCents', '不含税金额'), 'amountExclCents', '不含税金额');
  if (excl < 0) {
    throw new BadRequestException(`不含税金额（amountExclCents）不能为负，实际：${excl} 分`);
  }

  const rawRate = isAbsent(input.taxRate) ? 0 : numField(input.taxRate, 'taxRate', '税率');
  const bp = rateToBp(rawRate);
  if (bp < 0 || bp > RATE_SCALE) {
    throw new BadRequestException(`税率（taxRate）须在 0 ~ 1 之间（最多 4 位小数，如 0.13），实际：${rawRate}`);
  }
  const rate = bpToRate(bp);

  // 恒等式 1：税额 = round(不含税 × 税率)
  const expectTax = taxCentsOf(excl, rate);
  let tax = expectTax;
  if (!isAbsent(input.taxCents)) {
    const provided = intField(numField(input.taxCents, 'taxCents', '税额'), 'taxCents', '税额');
    if (provided < 0) {
      throw new BadRequestException(`税额（taxCents）不能为负，实际：${provided} 分`);
    }
    if (provided !== expectTax) {
      throw new BadRequestException(
        `税额（taxCents）与不含税金额/税率不一致：${yuanText(excl)} × ${rateText(rate)}，期望 ${yuanText(expectTax)}，实际 ${yuanText(provided)}`,
      );
    }
    tax = provided;
  }

  // 恒等式 2：含税 = 不含税 + 税额；恒等式 3：含税 > 0
  const expectIncl = inclCentsOf(excl, tax);
  if (expectIncl <= 0) {
    throw new BadRequestException(
      `含税金额必须大于 0：不含税 ${yuanText(excl)} + 税额 ${yuanText(tax)} = ${yuanText(expectIncl)}`,
    );
  }
  let incl = expectIncl;
  if (!isAbsent(input.amountInclCents)) {
    const provided = intField(numField(input.amountInclCents, 'amountInclCents', '含税金额'), 'amountInclCents', '含税金额');
    if (provided < 0) {
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
