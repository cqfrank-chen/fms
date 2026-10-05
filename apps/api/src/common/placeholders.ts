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
