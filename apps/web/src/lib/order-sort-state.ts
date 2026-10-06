/**
 * 订单列表「组合排序」的**前端状态机**（纯函数，可单测）
 * =============================================================================
 * 口径与后端 apps/api/src/orders/order-sort.ts 一一对应（字段白名单 / 优先级 / 默认值），
 * 并把「默认排序」与「用户已选排序」**明确区分开**（甲方 2026-10-06 修复）。
 *
 * · **默认排序 = 交期 DESC**，与后端「不传 sort」时的缺省完全一致（orderSortParam([]) === ''，
 *   调用方据此**不发 sort 参数**，让后端走缺省 —— 前后端只有一套默认口径）；
 * · 默认是**隐式**的：它不存在于「用户已选排序键」里，所以表头箭头 / 排序条 / 优先级数字
 *   在默认状态下都不显示「1. 交期 降序」，用户一眼能分清「在看默认」还是「刚点了排序」；
 * · 表头点击由 AntD 驱动（受控 sortOrder，sortDirections 默认 ['ascend','descend']）：
 *   空 → 升序 → 降序 → 取消（第三次点击取消该列）；
 * · **取消 = 用户选择清空 = 回到默认口径**（交期降序）。
 *
 * 原 bug：默认被当成「不可取消的隐式排序键」写进了 state（初始值就是 [{dueDate,desc}]），
 * 于是「取消」算出来的结果仍是 [{dueDate,desc}]，state 没变化 → 第三次点击看起来没反应、
 * 也无法先切到升序（AntD 对最后一档 descend 的下一次就是取消）。
 */

/** 排序字段白名单（顺序 = 后端白名单顺序；新加入的键按此顺序追加在末尾） */
export const ORDER_SORT_FIELDS = [
  'dueDate', 'orderNo', 'poNo', 'customer', 'status', 'invoiceState',
  'amount', 'invoiced', 'pendingCount', 'createdAt', 'lineCount',
] as const

export type OrderSortField = (typeof ORDER_SORT_FIELDS)[number]
export type OrderSortDir = 'asc' | 'desc'
export interface OrderSortKey { field: OrderSortField; dir: OrderSortDir }

/** 默认排序口径：交期 DESC（与后端缺省一致） */
export const DEFAULT_ORDER_SORT: readonly OrderSortKey[] = [{ field: 'dueDate', dir: 'desc' }]

/** 是否处于默认口径（用户没有显式选择任何排序键） */
export const isDefaultOrderSort = (keys: OrderSortKey[]): boolean => keys.length === 0

/** 实际生效的排序键：用户没选 → 默认（交期 DESC）。**只读**，不要写回 state */
export const effectiveOrderSort = (keys: OrderSortKey[]): OrderSortKey[] =>
  (keys.length ? keys : [...DEFAULT_ORDER_SORT])

/**
 * 发给后端的 `sort` 参数。空串 = 不传该参数（后端缺省 = dueDate:desc，两边同一口径）。
 */
export const orderSortParam = (keys: OrderSortKey[]): string =>
  keys.map((k) => k.field + ':' + k.dir).join(',')

/** 该字段在组合排序中的优先级（1 起）；未参与 → undefined（表头不显示序号） */
export function sortIndexOf(keys: OrderSortKey[], field: OrderSortField): number | undefined {
  const i = keys.findIndex((k) => k.field === field)
  return i < 0 ? undefined : i + 1
}

/** 表头受控排序方向：只反映**用户显式选择**；默认口径下为 null（箭头不亮） */
export function sortDirOf(keys: OrderSortKey[], field: OrderSortField): 'ascend' | 'descend' | null {
  const k = keys.find((x) => x.field === field)
  return k ? (k.dir === 'desc' ? 'descend' : 'ascend') : null
}

/**
 * AntD `sorter.multiple`：**必须恒为数字**（不能是 false/缺省），否则 AntD 会退回单列排序
 * 模式、点第二列会清掉第一列。参与组合排序 → 当前优先级；未参与 → 「加入后」的优先级。
 */
export const sortMultiple = (keys: OrderSortKey[], field: OrderSortField): number =>
  sortIndexOf(keys, field) ?? keys.length + 1

/**
 * 表头点击 → 新的「用户显式排序键」。
 * `active` 只包含 AntD 认为**当前仍生效**的列（被取消的列不在里面），因此：
 *   · 取消最后一列 → active 为空 → 返回 []（= 回到默认口径）；
 *   · 已有键保持相对优先级（只更新方向），新加入的键按白名单顺序追加到末尾（优先级最低）。
 */
export function nextOrderSort(prev: OrderSortKey[], active: Map<OrderSortField, OrderSortDir>): OrderSortKey[] {
  const next: OrderSortKey[] = []
  for (const k of prev) {
    const dir = active.get(k.field)
    if (dir) next.push({ field: k.field, dir })
  }
  for (const field of ORDER_SORT_FIELDS) {
    const dir = active.get(field)
    if (dir && !next.some((k) => k.field === field)) next.push({ field, dir })
  }
  return next
}
