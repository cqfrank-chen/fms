import { BadRequestException } from '@nestjs/common';
import { RATE_SCALE, bpToRate, rateToBp } from '../common/money';

/**
 * 开票设置（I16 收敛②）—— 纯函数，便于单测
 * ------------------------------------------------------------------
 * 极简实现：复用既有 `app_settings`（key/value，AI 配置同一张表），不引入任何配置框架。
 * 目前只有一个设置项：开票默认税率（0 / 1% / 6% / 9% / 13%）。
 */

/** app_settings.key（与 AI 配置的 ai.* 前缀并列，互不影响） */
export const INVOICE_DEFAULT_TAX_RATE_KEY = 'invoice.default_tax_rate';

/** 设置页可选的默认税率（与前端 TAX_RATE_OPTIONS 一致） */
export const ALLOWED_DEFAULT_TAX_RATES = [0, 0.01, 0.06, 0.09, 0.13] as const;

/** 校验并归一化「开票默认税率」：仅允许 0 / 0.01 / 0.06 / 0.09 / 0.13（按万分点整数比较，避免浮点误差） */
export function normalizeDefaultTaxRate(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new BadRequestException(`开票默认税率（defaultTaxRate）必须是数字，实际：${JSON.stringify(value ?? null)}`);
  }
  const bp = rateToBp(n);
  if (bp < 0 || bp > RATE_SCALE) {
    throw new BadRequestException(`开票默认税率（defaultTaxRate）须在 0 ~ 1 之间，实际：${n}`);
  }
  const hit = ALLOWED_DEFAULT_TAX_RATES.find((r) => rateToBp(r) === bp);
  if (hit === undefined) {
    throw new BadRequestException(
      `开票默认税率仅支持 0 / 1% / 6% / 9% / 13%，实际：${n}（=${bp / 100}%）`,
    );
  }
  return bpToRate(bp);
}
