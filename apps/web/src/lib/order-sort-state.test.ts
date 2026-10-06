/**
 * 订单列表组合排序 · 前端状态机单元测试（纯函数，不碰 DOM / 不发请求）
 * =============================================================================
 * 运行：node --test apps/web/src/lib/order-sort-state.test.ts   （Node 24 原生 TS 剥离）
 *
 * 覆盖甲方 2026-10-06 的自测要求：
 *   ① 单键反复切换升/降序；② 第三次点击取消该排序项；③ 取消后回到默认口径（交期降序）；
 *   ④ 界面状态与接口参数一致（默认 ↔ sort 参数缺省 = dueDate:desc）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_ORDER_SORT, effectiveOrderSort, isDefaultOrderSort, nextOrderSort, orderSortParam,
  ORDER_SORT_FIELDS, sortDirOf, sortIndexOf, sortMultiple,
} from './order-sort-state.ts'
import type { OrderSortDir, OrderSortField, OrderSortKey } from './order-sort-state.ts'

/**
 * 模拟 AntD 受控表头的一次点击：`dir` = 点击后该列的方向，`null` = 第三次点击（取消该列）。
 * AntD 的 onChange 会把**当前仍生效的全部排序列**放进 sorter 数组，所以这里其余列保持原方向，
 * 只把被点击的列改成新方向 / 移除。
 */
const click = (prev: OrderSortKey[], field: OrderSortField, dir: OrderSortDir | null): OrderSortKey[] => {
  const active = new Map<OrderSortField, OrderSortDir>()
  for (const k of prev) active.set(k.field, k.dir)
  if (dir) active.set(field, dir)
  else active.delete(field)
  return nextOrderSort(prev, active)
}

test('默认口径：用户未选任何排序键 = 交期 DESC，且 sort 参数缺省（不传）', () => {
  const keys: OrderSortKey[] = []
  assert.equal(isDefaultOrderSort(keys), true)
  assert.deepEqual(effectiveOrderSort(keys), [{ field: 'dueDate', dir: 'desc' }])
  assert.equal(orderSortParam(keys), '', '空状态不传 sort → 后端缺省 dueDate:desc')
  assert.deepEqual([...DEFAULT_ORDER_SORT], [{ field: 'dueDate', dir: 'desc' }])
  // 显式写上 dueDate:desc 与「不传」是同一口径（接口层等价）
  assert.equal(orderSortParam([{ field: 'dueDate', dir: 'desc' }]), 'dueDate:desc')
  assert.deepEqual(effectiveOrderSort([{ field: 'dueDate', dir: 'desc' }]), effectiveOrderSort(keys))
})

test('单键（交期）反复切换升/降序：空 → 升 → 降 → 空（第三次点击取消）', () => {
  let keys: OrderSortKey[] = []
  keys = click(keys, 'dueDate', 'asc')
  assert.deepEqual(keys, [{ field: 'dueDate', dir: 'asc' }])
  assert.equal(orderSortParam(keys), 'dueDate:asc')
  assert.equal(sortDirOf(keys, 'dueDate'), 'ascend')
  assert.equal(sortIndexOf(keys, 'dueDate'), 1, '表头显示优先级 1')

  keys = click(keys, 'dueDate', 'desc')
  assert.deepEqual(keys, [{ field: 'dueDate', dir: 'desc' }])
  assert.equal(orderSortParam(keys), 'dueDate:desc')
  assert.equal(sortDirOf(keys, 'dueDate'), 'descend')

  keys = click(keys, 'dueDate', null)   // 第三次点击 = 取消
  assert.deepEqual(keys, [], '取消后回到空状态')
  assert.equal(isDefaultOrderSort(keys), true)
  assert.equal(orderSortParam(keys), '', '取消后不传 sort → 后端回到默认（交期降序）')
  assert.deepEqual(effectiveOrderSort(keys), [{ field: 'dueDate', dir: 'desc' }])
  assert.equal(sortDirOf(keys, 'dueDate'), null, '表头箭头熄灭（默认口径不在表头上伪装成用户选择）')
  assert.equal(sortIndexOf(keys, 'dueDate'), undefined, '优先级数字消失')
})

test('取消一个键后，其余键保持相对优先级、方向不变', () => {
  let keys: OrderSortKey[] = [{ field: 'customer', dir: 'asc' }, { field: 'dueDate', dir: 'desc' }]
  keys = click(keys, 'dueDate', null)
  assert.deepEqual(keys, [{ field: 'customer', dir: 'asc' }])
  assert.equal(orderSortParam(keys), 'customer:asc')
  keys = click(keys, 'customer', null)
  assert.deepEqual(keys, [], '全部取消 → 回到默认口径')
})

test('新加入的键追加到末尾（优先级最低），已有键顺序不变', () => {
  let keys: OrderSortKey[] = [{ field: 'dueDate', dir: 'asc' }]
  keys = nextOrderSort(keys, new Map([['dueDate', 'asc'], ['customer', 'asc']] as [OrderSortField, OrderSortDir][]))
  assert.deepEqual(keys, [{ field: 'dueDate', dir: 'asc' }, { field: 'customer', dir: 'asc' }])
  assert.equal(sortIndexOf(keys, 'customer'), 2)
  assert.equal(orderSortParam(keys), 'dueDate:asc,customer:asc', '参数顺序 = 优先级顺序')
})

test('sorter.multiple 恒为数字（否则 AntD 会退回单列排序、点第二列清掉第一列）', () => {
  const keys: OrderSortKey[] = [{ field: 'poNo', dir: 'desc' }]
  for (const f of ORDER_SORT_FIELDS) {
    const m = sortMultiple(keys, f)
    assert.equal(typeof m, 'number')
    assert.ok(Number.isFinite(m))
  }
  assert.equal(sortMultiple(keys, 'poNo'), 1)
  assert.equal(sortMultiple(keys, 'customer'), 2)
})

test('字段白名单与后端一致（11 个，顺序即追加顺序）', () => {
  assert.deepEqual([...ORDER_SORT_FIELDS], [
    'dueDate', 'orderNo', 'poNo', 'customer', 'status', 'invoiceState',
    'amount', 'invoiced', 'pendingCount', 'createdAt', 'lineCount',
  ])
})
