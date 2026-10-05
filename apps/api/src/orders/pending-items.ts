import type { PendingItem } from '../db/schema';

/**
 * ============================================================
 * 「待补」判定（I17）—— **服务端纯函数**，无 DB / 无 IO，可单测
 * ------------------------------------------------------------
 * 用途：识单结果（含 .doc 管线）落**草稿订单**时，缺价 / 缺交期 / 缺数量 / 产品未建档 / 客户未建档
 * 逐项写成**中文诊断**，分别挂在订单行（line）与单头（order）上，界面直接展示、可筛选、可逐项补全。
 *
 * 设计约束（甲方要求「严守既有约束」）：
 *   · orders.customer_id / orders.due_date 都是 NOT NULL，本模块**不改既有表结构**；
 *   · 缺交期 → 用哨兵日 ORDERS_DUE_DATE_TBD + due_date_tbd=true（二者成对，界面显示「待定」）；
 *   · 缺客户/缺产品 → 惰性创建**显式占位档案**（（未建档客户·待补）/（未建档产品·待补）），
 *     并把识别到的原名写进 draft_customer_name / product_name_text，人工建档后改指真实档案即可；
 *   · 待补项非空的草稿**禁止确认**（见 plan-sheets.service.confirmOrder），避免脏数据流到计划单/应收。
 */

/** 待补项编码（落库 jsonb 的 code，界面按它做样式/图标；message 是给人看的中文） */
export const PENDING_CODES = {
  /** 客户未建档（customer_id 指向占位档案） */
  CUSTOMER_NOT_FILED: 'customer_not_filed',
  /** 缺交期（due_date 是哨兵日，界面显示「待定」） */
  DUE_DATE_MISSING: 'due_date_missing',
  /** 整单没有产品行 */
  NO_PRODUCT_LINES: 'no_product_lines',
  /** 行级待补汇总（单头可见；明细在行上） */
  LINE_PENDING: 'line_pending',
  /** 缺单价 */
  PRICE_MISSING: 'price_missing',
  /** 缺数量 */
  QUANTITY_MISSING: 'quantity_missing',
  /** 产品未建档（product_id 指向占位产品） */
  PRODUCT_NOT_FILED: 'product_not_filed',
} as const;

export type PendingCode = (typeof PENDING_CODES)[keyof typeof PENDING_CODES];

/** 落草稿时一行识单结果的归一形态（数量/单价可为空 = 原始单据本来就没有） */
export interface DraftLineInput {
  productId?: number | null;
  productName?: string | null;
  quantity?: number | null;
  unitPrice?: number | string | null;
  /** 单价来源：'quote' = 由报价记录补全（补价成功的行不再算「缺单价」） */
  priceFrom?: 'quote' | null;
}

/** 落草稿时单头识单结果的归一形态 */
export interface DraftHeadInput {
  customerId?: number | null;
  customerName?: string | null;
  dueDate?: string | null;
}

const item = (code: PendingCode, message: string): PendingItem => ({ code, message });

/** 行级待补：缺数量 / 缺单价 / 产品未建档（顺序固定，便于界面稳定展示） */
export function computeLinePending(line: DraftLineInput): PendingItem[] {
  const out: PendingItem[] = [];
  if (line.productId == null) out.push(item(PENDING_CODES.PRODUCT_NOT_FILED, '产品未建档：' + (line.productName?.trim() || '（未识别到产品名）') + '（请到设置·产品目录建档后改指）'));
  if (line.quantity == null || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0) {
    out.push(item(PENDING_CODES.QUANTITY_MISSING, '缺数量：原始单据没有可识别的数量，请人工补填'));
  }
  // 注：priceFrom='quote' 只是**来源标记**，不能用来豁免缺价 —— 价格真的为空就一定标待补（防脏数据）
  if (line.unitPrice == null || String(line.unitPrice).trim() === '' || Number(line.unitPrice) < 0) {
    out.push(item(PENDING_CODES.PRICE_MISSING, '缺单价：原始单据没有价格列，也未命中报价记录，请人工补填或先录入报价'));
  }
  return out;
}

/** 单头待补：客户未建档 / 缺交期 / 无产品行 + 行级汇总 */
export function computeOrderPending(head: DraftHeadInput, linePendings: PendingItem[][]): PendingItem[] {
  const out: PendingItem[] = [];
  if (head.customerId == null) {
    out.push(item(PENDING_CODES.CUSTOMER_NOT_FILED, '客户未建档：' + (head.customerName?.trim() || '（未识别到客户名）') + '（当前挂在占位档案「（未建档客户·待补）」下）'));
  }
  if (!head.dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(head.dueDate))) {
    out.push(item(PENDING_CODES.DUE_DATE_MISSING, '缺交期：原始单据未识别到交货日期（交期暂记「待定」，请人工确认后补填）'));
  }
  if (!linePendings.length) {
    out.push(item(PENDING_CODES.NO_PRODUCT_LINES, '整单没有产品行：识别结果为空或全部被判定为噪声行，请人工录入'));
    return out;
  }
  const flat = linePendings.flat();
  if (flat.length) {
    const count = (code: PendingCode) => linePendings.filter((ls) => ls.some((x) => x.code === code)).length;
    const parts: string[] = [];
    if (count(PENDING_CODES.PRICE_MISSING)) parts.push('缺单价 ' + count(PENDING_CODES.PRICE_MISSING) + ' 行');
    if (count(PENDING_CODES.QUANTITY_MISSING)) parts.push('缺数量 ' + count(PENDING_CODES.QUANTITY_MISSING) + ' 行');
    if (count(PENDING_CODES.PRODUCT_NOT_FILED)) parts.push('产品未建档 ' + count(PENDING_CODES.PRODUCT_NOT_FILED) + ' 行');
    out.push(item(PENDING_CODES.LINE_PENDING, '共 ' + linePendings.filter((ls) => ls.length).length + ' 行存在待补项（' + parts.join('、') + '），可在订单列表按「有未补全项的草稿单」筛选后逐项补全'));
  }
  return out;
}

/** 是否还有未补全项（null = 该订单不参与待补机制 → false，向后兼容普通订单） */
export function hasPending(items?: PendingItem[] | null): boolean {
  return Array.isArray(items) && items.length > 0;
}

/** 待补项 → 中文一句话（确认拦截提示、界面 tooltip 共用） */
export function pendingText(items?: PendingItem[] | null): string {
  if (!hasPending(items)) return '';
  return (items ?? []).map((x) => x.message).join('；');
}

/** 统计待补项条数（列表列展示用） */
export function pendingCount(items?: PendingItem[] | null): number {
  return Array.isArray(items) ? items.length : 0;
}
