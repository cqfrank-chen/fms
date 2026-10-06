import { isPendingEntityName } from '../db/schema';

/**
 * 占位档案的「默认隐藏 + 开关显示」（I17 甲方裁定 2026-10-05）
 * ------------------------------------------------------------------
 * 裁定原文：「占位档案（未建档客户·待补 / 未建档产品·待补）在前端列表默认隐藏：
 * 客户/产品/订单相关列表都不展示这两个占位档案（后端保留、内部引用不变），
 * 并提供「显示占位档案」开关供排查。」
 *
 * 实现口径：
 *   · 后端一律**默认隐藏**（列表查询不带参数时看不到占位档案）；
 *   · 需要排查时传 includePlaceholders=1（前端「显示占位档案」开关）即可看到；
 *   · 占位档案本身、以及订单对其的引用**一律保留**（外键与内部逻辑不变）。
 *
 * 【口径收窄 · 2026-10-05 甲方裁定】订单列表隐藏口径改为「**只看客户**」：
 *   · 只有「客户是占位档案」的订单默认隐藏（这类单据连客户都没建档，排查价值最低）；
 *   · 「任一产品行是占位产品」的订单**照常显示**，改由前端在单据上加醒目标记
 *     （行上仍标「待补：产品未建档」）—— 隐藏它们等于把待补单藏起来，人工无从补全。
 *   · includePlaceholders=1（显示占位档案开关）与 hasPending=1（只看未补全草稿单）都不受影响。
 *   判定实现见下方 hiddenCustomerIdForOrders（纯函数，单测直接覆盖）。
 */

/** includePlaceholders 参数解析：'1' / 'true' / 'yes' / 'on' / true 视为包含 */
export function includePlaceholders(v?: string | boolean | null): boolean {
  if (v === true) return true;
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** 过滤掉占位档案行（客户/产品列表共用；默认隐藏） */
export function hidePlaceholders<T extends { name?: string | null }>(
  rows: T[],
  include?: string | boolean | null,
): T[] {
  return includePlaceholders(include) ? rows : rows.filter((r) => !isPendingEntityName(r.name));
}

/**
 * **订单列表**默认隐藏口径（纯函数，供单测直接验证；服务端据此拼 SQL 条件）。
 *
 * 返回「需要从订单列表排除的占位客户 id」：
 *   · 返回 null → 不做任何隐藏（全部订单可见）；
 *   · 返回 id   → 仅排除「客户 = 该占位档案」的订单。
 *
 * 规则（按优先级）：
 *   ① includePlaceholders=1（前端「显示占位客户档案」开关）→ null（全显示，排查用）；
 *   ② hasPending=1（「仅看有未补全项的草稿单」）→ null（补全工作流必须能看到占位单）；
 *   ③ 其余 → 占位客户 id（未建档客户占位档案不存在时 → null，无单可藏）。
 *
 * 关键口径：**产品行挂占位产品的订单不在此列** —— 它们默认可见，由界面加醒目标记。
 */
export function hiddenCustomerIdForOrders(
  include?: string | boolean | null,
  hasPendingOnly?: boolean,
  pendingCustomerId?: number | null,
): number | null {
  if (includePlaceholders(include)) return null;
  if (hasPendingOnly) return null;
  return pendingCustomerId ?? null;
}
