import { fromCents } from '../common/money';

/**
 * 开票统计（I16）—— 纯函数，无 IO，便于单测
 * ------------------------------------------------------------------
 * **净额口径（I16 红冲）**：未作废的票全部计入 —— 正常票为正数、红字票为负数（amount_* 均为负），
 * 已被红冲的原票（status='red_flushed'）**仍计入其正数**，由红字票的负数冲减，净额才能正确归零：
 *     已开票净额 = Σ(未作废且非红字票含税) + Σ(未作废红字票含税，负数)
 * 只有 status='voided'（已作废）的票被完全剔除；作废/红冲都保留记录可查。
 * 金额单位：分（整数），累加即精确；转元只发生在展示层。
 */

export interface InvoiceAmountRow {
  status: string;
  amountExclCents: number;
  taxCents: number;
  amountInclCents: number;
}

export interface InvoiceTotals {
  count: number;
  amountExclCents: number;
  taxCents: number;
  amountInclCents: number;
}

export const emptyTotals = (): InvoiceTotals => ({ count: 0, amountExclCents: 0, taxCents: 0, amountInclCents: 0 });

/** 是否计入统计（净额口径）：未作废即计入——已红冲的原票计正数、红字票计负数 */
export const isCountedInvoice = (status: string): boolean => status !== 'voided';

/** 汇总开票张数与金额（不含税/税额/含税，净额），作废发票不计入 */
export function summarizeInvoices(rows: InvoiceAmountRow[]): InvoiceTotals {
  const t = emptyTotals();
  for (const r of rows) {
    if (!isCountedInvoice(r.status)) continue;
    t.count += 1;
    t.amountExclCents += Math.round(r.amountExclCents ?? 0);
    t.taxCents += Math.round(r.taxCents ?? 0);
    t.amountInclCents += Math.round(r.amountInclCents ?? 0);
  }
  return t;
}

/** 某张原票的已红冲金额（正数，分）：其未作废红字票金额绝对值之和 */
export function redFlushedCents(rows: InvoiceAmountRow[]): number {
  return rows
    .filter((r) => isCountedInvoice(r.status))
    .reduce((s, r) => s + Math.abs(Math.min(0, Math.round(r.amountInclCents ?? 0))), 0);
}

/** 原票还可红冲金额（正数，分）：原票含税绝对值 − 已红冲；红冲累计不得超过它 */
export function redRemainCents(originalInclCents: number, rows: InvoiceAmountRow[]): number {
  return Math.max(0, Math.abs(Math.round(originalInclCents ?? 0)) - redFlushedCents(rows));
}

/**
 * 超开闸门（I16 收敛⑤）：默认**阻止**超出订单金额的开票，只有显式 allow=true（前端「高级」勾选）才放行。
 * 一律按「分」整数比较：投影净额 = 当前已开票净额 + 本次开票金额。
 */
export function overInvoiceBlocked(
  orderAmountCents: number,
  currentNetCents: number,
  newAmountCents: number,
  allow: boolean,
): boolean {
  if (allow) return false;
  return Math.round(currentNetCents ?? 0) + Math.round(newAmountCents ?? 0) > Math.round(orderAmountCents ?? 0);
}

/**
 * 订单开票状态（简化交互的三态）：未开票 / 部分开票 / 已开完。
 * 规则（金额一律按「分」整数比较，避免浮点误差）：
 *   已开票 = 0            → none（未开票）
 *   0 < 已开票 < 订单金额  → partial（部分开票）
 *   已开票 ≥ 订单金额      → done（已开完；超额开票同样算已开完，不报错）
 */
export type OrderInvoiceState = 'none' | 'partial' | 'done';

export function orderInvoiceState(orderAmountCents: number, invoicedCents: number): OrderInvoiceState {
  const amount = Math.round(orderAmountCents ?? 0);
  const invoiced = Math.round(invoicedCents ?? 0);
  if (invoiced <= 0) return 'none';
  return invoiced >= amount ? 'done' : 'partial';
}

export interface OrderInvoiceView {
  /** 订单金额（分，按订单行 Σ 数量×单价 精确定点计算） */
  orderAmountCents: number;
  /** 已开票金额（分，含税；实时聚合，只计未作废） */
  invoicedCents: number;
  /** 未开票余额（分，非负；超额开票时为 0，另见 overInvoiced/warning） */
  uninvoicedCents: number;
  /** 是否超额开票（累计含税 > 订单金额） */
  overInvoiced: boolean;
  /** 开票状态三态：none 未开票 / partial 部分开票 / done 已开完 */
  invoiceState: OrderInvoiceState;
  /** 有效发票张数（未作废） */
  invoiceCount: number;
  /** 已作废发票张数 */
  voidedCount: number;
  /** 超额提示（业务弹性：不阻断开票，只回传提示） */
  warning?: string;
}

/**
 * 订单开票进度：已开票金额一律实时聚合（不落冗余字段，避免漂移）。
 * 允许部分开票；累计超出订单金额时不阻断写入，仅返回 warning 说明。
 */
export function buildOrderInvoiceView(orderAmountCents: number, rows: InvoiceAmountRow[]): OrderInvoiceView {
  const amount = Math.round(orderAmountCents ?? 0);
  // 净额口径：未作废的票全部计入（红字票为负数、已红冲原票仍计正数）
  const counted = rows.filter((r) => isCountedInvoice(r.status));
  const invoicedCents = counted.reduce((s, r) => s + Math.round(r.amountInclCents ?? 0), 0);
  const over = invoicedCents > amount;
  const diffCents = invoicedCents - amount;
  return {
    orderAmountCents: amount,
    invoicedCents,
    uninvoicedCents: Math.max(0, amount - invoicedCents),
    overInvoiced: over,
    invoiceState: orderInvoiceState(amount, invoicedCents),
    invoiceCount: counted.length,
    voidedCount: rows.filter((r) => !isCountedInvoice(r.status)).length,
    warning: over
      ? `已开票金额（含税）${fromCents(invoicedCents).toFixed(2)} 元超出订单金额 ${fromCents(amount).toFixed(2)} 元，超出 ${fromCents(diffCents).toFixed(2)} 元：请核对是否存在多单合并开票或订单金额变更`
      : undefined,
  };
}

/** 部分开票（0 < 已开票 < 订单金额）提示文案；未开票或已开满返回 undefined */
export function partialInvoiceNote(view: OrderInvoiceView): string | undefined {
  if (view.overInvoiced || view.invoicedCents <= 0 || view.invoicedCents >= view.orderAmountCents) return undefined;
  return `本单为部分开票：已开票 ${fromCents(view.invoicedCents).toFixed(2)} 元，未开票余额 ${fromCents(view.uninvoicedCents).toFixed(2)} 元`;
}
