/**
 * 开票错误/提示文案（I16）—— 纯函数集中管理
 * ------------------------------------------------------------------
 * 目的：把「中文提示」从 service 里抽出来，既可单测断言文案（字段/期望/实际），
 * 又避免同一句提示在多处漂移（接口 400 与前端展示共用同一口径）。
 */

/** 未作废票号重复（预检查与唯一索引兜底共用同一句） */
export const invoiceNoConflictMessage = (invoiceNo: string): string =>
  `发票号码「${invoiceNo}」已存在（未作废），请核对后重新录入；如确需重开请先作废原发票`;

/** 金额关键字段不可直接编辑 */
export const amountImmutableMessage = (field: string): string =>
  `${field}为开票凭证关键字段，不可直接修改：请先作废（POST /api/invoices/:id/void）后重新开票`;

/** 已作废发票不可编辑 */
export const voidedImmutableMessage = (invoiceNo: string): string =>
  `发票 ${invoiceNo} 已作废，不可修改（如需更正请重新开票）`;

/** 重复作废 */
export const alreadyVoidedMessage = (invoiceNo: string, whenYmdHm: string, reason?: string | null): string =>
  `发票「${invoiceNo}」已作废（${whenYmdHm || '时间未知'}${reason ? '，原因：' + reason : ''}），请勿重复作废`;

/** 关联订单客户与发票客户不一致 */
export const orderCustomerMismatchMessage = (orderNos: string[], customerId: number): string =>
  `关联订单客户与本发票客户不一致：${orderNos.join('、')} 属于其他客户（发票客户 id=${customerId}）`;

/** 关联订单不存在 */
export const ordersMissingMessage = (ids: number[]): string =>
  `关联订单不存在（id=${ids.join('、')}），请刷新订单列表后重选`;
