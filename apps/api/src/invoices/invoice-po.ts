/**
 * 发票 ↔ 客户 PO 号（I18 开票做账核对 PO）
 * ------------------------------------------------------------------
 * 背景：订单有两个号 —— 订单号 orderNo（系统生成、唯一）与 PO 号 poNo（客户给的采购单号，
 * 可空、可重复）。发票与订单是 invoice_orders 多对多，**一张发票可能对应多个订单、多个 PO**。
 *
 * 口径（纯函数，无 IO，便于单测）：
 *   · PO 一律**从关联订单动态派生**，发票表不落冗余列 —— 订单 PO 改了，发票侧视图随之改变，
 *     不存在两处存储漂移的可能；
 *   · 聚合结果 = 去重（同一 PO 出现在多张订单只算一次）+ 保序（按关联订单顺序）+ 丢弃空值；
 *   · 「无 PO」在数据层就是空数组，占位（—/无 PO）由展示层决定，服务端不发明占位字符串。
 */

/** 归一化单个 PO 号：去除首尾空白；空白/缺省 → null（订单 poNo 本身可空，未做其它规范化） */
export function normalizePoNo(raw?: string | null): string | null {
  const v = String(raw ?? '').trim();
  return v ? v : null;
}

/**
 * 从关联订单聚合 PO 号：去重 + 保序（按入参顺序，即关联订单的落库顺序）+ 丢弃空值。
 * 返回**数组**（而非拼接文本）的理由：
 *   · 一票多单多 PO 时，数组保留 PO 的边界；PO 本身可能含空格（如「AB25 758」），
 *     拼接文本后续无法可靠地再拆开，前端也无法逐条加 Tooltip / 复制；
 *   · 无 PO → [] 语义唯一，展示占位与筛选判断都不需要额外约定。
 */
export function aggregatePoNos(refs: Array<{ poNo?: string | null }> | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of refs ?? []) {
    const v = normalizePoNo(r?.poNo);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * 列表按 PO 号筛选：把查询串转成 ilike 模式串；空查询返回 null（= 不筛选）。
 * 与既有 keyword 同口径（模糊匹配、不转义 %/_），保证两个筛选框的行为一致、可叠加（AND）。
 */
export function poFilterPattern(q?: string | null): string | null {
  const v = String(q ?? '').trim();
  return v ? `%${v}%` : null;
}

/** 一条「该 PO 已开过票」的事实：PO 号 + 已存在的（未作废）发票号 */
export interface PoInvoiceHit {
  poNo?: string | null;
  invoiceNo?: string | null;
}

/**
 * 重复开票提示（**不阻断**，对账安全）：所选订单的 PO 若已被**未作废**发票占用，
 * 返回中文 warning 列出「PO + 已存在的发票号」，例如：
 *   PO AB25 758 已开过票（发票号 INV-2026-001），请确认是否重复开票
 * 同一 PO 命中多张发票时合并列出（发票号用「、」分隔）；多个 PO 用「；」分隔。
 * 无命中（或 PO 为空）返回 undefined —— 调用方据此决定是否附带 warning。
 */
export function duplicatePoWarning(hits: PoInvoiceHit[] | null | undefined): string | undefined {
  const byPo = new Map<string, string[]>();
  for (const h of hits ?? []) {
    const po = normalizePoNo(h?.poNo);
    const no = String(h?.invoiceNo ?? '').trim();
    if (!po || !no) continue;
    const arr = byPo.get(po) ?? [];
    if (!arr.includes(no)) arr.push(no);
    byPo.set(po, arr);
  }
  if (!byPo.size) return undefined;
  return [...byPo.entries()]
    .map(([po, nos]) => `PO ${po} 已开过票（发票号 ${nos.join('、')}），请确认是否重复开票`)
    .join('；');
}
