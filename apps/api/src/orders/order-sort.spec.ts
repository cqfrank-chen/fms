import { BadRequestException } from '@nestjs/common';
import {
  compareOrderSortValues, DEFAULT_ORDER_SORT, formatOrderSort, orderToSortValues,
  parseOrderSort, sortOrdersByKeys, ORDER_SORT_FIELD_KEYS,
} from './order-sort';
import type { OrderSortKey, OrderSortValues } from './order-sort';

/**
 * 订单列表排序单元测试（纯函数，不连数据库）
 * ------------------------------------------------------------------
 * 锁定两件事：
 *   ① sort 参数解析与**字段白名单**校验（非法字段/方向必须 400 且是中文提示）；
 *   ② 多键比较函数的口径 —— 交期待定（哨兵日 2099-12-31）与 NULL/空值**恒定沉底**，
 *      不随升降序翻面；状态/开票状态按业务序而不是字母序。
 */

/** 造一条排序取值（只给需要的字段，其余留空） */
const row = (patch: Partial<OrderSortValues>): OrderSortValues => ({ ...patch });

describe('① sort 参数解析与字段白名单', () => {
  it('缺省 / 空串 → 默认排序 = 交期 DESC', () => {
    expect(parseOrderSort(undefined)).toEqual([{ field: 'dueDate', dir: 'desc' }]);
    expect(parseOrderSort(null)).toEqual([{ field: 'dueDate', dir: 'desc' }]);
    expect(parseOrderSort('')).toEqual([{ field: 'dueDate', dir: 'desc' }]);
    expect(parseOrderSort('   ')).toEqual(DEFAULT_ORDER_SORT);
  });

  it('单键：dueDate:desc', () => {
    expect(parseOrderSort('dueDate:desc')).toEqual([{ field: 'dueDate', dir: 'desc' }]);
  });

  it('多键：顺序即优先级（从左到右从高到低）', () => {
    const keys = parseOrderSort('dueDate:desc,customer:asc,status:asc,invoiceState:asc,amount:desc,createdAt:desc');
    expect(keys.map((k) => k.field + ':' + k.dir)).toEqual([
      'dueDate:desc', 'customer:asc', 'status:asc', 'invoiceState:asc', 'amount:desc', 'createdAt:desc',
    ]);
  });

  it('全部 11 个可排序列都在白名单内', () => {
    const all = ORDER_SORT_FIELD_KEYS.map((f) => f + ':asc').join(',');
    expect(parseOrderSort(all).map((k) => k.field)).toEqual([...ORDER_SORT_FIELD_KEYS]);
    expect(ORDER_SORT_FIELD_KEYS.length).toBe(11);
    // 交期、订单号、客户 PO 号、客户、状态、开票状态、订单金额、已开票金额、待补项数量、创建时间、产品行数
    expect([...ORDER_SORT_FIELD_KEYS]).toEqual([
      'dueDate', 'orderNo', 'poNo', 'customer', 'status', 'invoiceState',
      'amount', 'invoiced', 'pendingCount', 'createdAt', 'lineCount',
    ]);
  });

  it('只写字段名 → 默认升序', () => {
    expect(parseOrderSort('customer')).toEqual([{ field: 'customer', dir: 'asc' }]);
  });

  it('方向大小写不敏感', () => {
    expect(parseOrderSort('dueDate:DESC,amount:Asc')).toEqual([
      { field: 'dueDate', dir: 'desc' }, { field: 'amount', dir: 'asc' },
    ]);
  });

  it('容忍多余逗号与空格', () => {
    expect(parseOrderSort(' dueDate:desc ,, customer:asc , ')).toEqual([
      { field: 'dueDate', dir: 'desc' }, { field: 'customer', dir: 'asc' },
    ]);
  });

  it('同一字段重复出现 → 保留第一次的键与方向', () => {
    expect(parseOrderSort('customer:desc,dueDate:asc,customer:asc')).toEqual([
      { field: 'customer', dir: 'desc' }, { field: 'dueDate', dir: 'asc' },
    ]);
  });

  it('非法字段 → BadRequestException（400）且中文提示列出可用字段', () => {
    let err: unknown;
    try { parseOrderSort('dueDate:desc,foo:asc'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BadRequestException);
    const msg = (err as BadRequestException).message;
    expect(msg).toContain('不支持的排序字段「foo」');
    // 提示必须把白名单字段与中文列名都列出来，便于前端/调用方自查
    expect(msg).toContain('dueDate（交期）');
    expect(msg).toContain('pendingCount（待补项数量）');
    expect(msg).toContain('lineCount（产品行数）');
  });

  it('非法方向 → BadRequestException（400）中文提示', () => {
    let err: unknown;
    try { parseOrderSort('amount:up'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain('排序方向「up」无效');
    expect((err as BadRequestException).message).toContain('asc（升序）');
  });

  it('格式错误（多冒号）→ 400 中文提示', () => {
    let err: unknown;
    try { parseOrderSort('dueDate:desc:extra'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain('格式不正确');
  });

  it('formatOrderSort 与 parseOrderSort 互逆', () => {
    const keys = parseOrderSort('customer:asc,dueDate:desc');
    expect(formatOrderSort(keys)).toBe('customer:asc,dueDate:desc');
    expect(parseOrderSort(formatOrderSort(keys))).toEqual(keys);
  });
});

describe('② 单键比较：交期（含哨兵日 / 空值）', () => {
  const desc: OrderSortKey[] = [{ field: 'dueDate', dir: 'desc' }];
  const asc: OrderSortKey[] = [{ field: 'dueDate', dir: 'asc' }];

  it('都是真实交期 → DESC 大在前、ASC 小在前', () => {
    const a = row({ dueDate: '2026-03-01T00:00:00.000Z' });
    const b = row({ dueDate: '2026-06-01T00:00:00.000Z' });
    expect(compareOrderSortValues(a, b, desc)).toBeGreaterThan(0);
    expect(compareOrderSortValues(b, a, desc)).toBeLessThan(0);
    expect(compareOrderSortValues(a, b, asc)).toBeLessThan(0);
  });

  it('交期待定（due_date_tbd=true）在 DESC 下也沉底', () => {
    const tbd = row({ dueDate: '2099-12-31T00:00:00.000Z', dueDateTbd: true });
    const real = row({ dueDate: '2026-01-01T00:00:00.000Z' });
    expect(compareOrderSortValues(tbd, real, desc)).toBeGreaterThan(0); // 待定排在真实交期之后
    expect(compareOrderSortValues(real, tbd, desc)).toBeLessThan(0);
  });

  it('哨兵日即使漏标 due_date_tbd 也按待定处理（DESC 沉底）', () => {
    const sentinel = row({ dueDate: '2099-12-31T00:00:00.000Z' });
    const real = row({ dueDate: '2026-01-01T00:00:00.000Z' });
    expect(compareOrderSortValues(sentinel, real, desc)).toBeGreaterThan(0);
    expect(compareOrderSortValues(sentinel, real, asc)).toBeGreaterThan(0); // ASC 同样沉底
  });

  it('交期为 null / 空串 / 无法解析 → 视为缺失，ASC 也沉底', () => {
    for (const missing of [null, '', 'not-a-date']) {
      const m = row({ dueDate: missing as string | null });
      const real = row({ dueDate: '2026-01-01T00:00:00.000Z' });
      expect(compareOrderSortValues(m, real, asc)).toBeGreaterThan(0);
      expect(compareOrderSortValues(m, real, desc)).toBeGreaterThan(0);
    }
  });

  it('两条都待定 → 该键视为相等（交给下一个键/创建时间兜底）', () => {
    const t1 = row({ dueDate: '2099-12-31T00:00:00.000Z', dueDateTbd: true });
    const t2 = row({ dueDate: '2099-12-31T00:00:00.000Z', dueDateTbd: true });
    expect(compareOrderSortValues(t1, t2, desc)).toBe(0);
  });

  it('支持 Date 对象与 ISO 串混用', () => {
    const d = row({ dueDate: new Date('2026-05-05T00:00:00.000Z') });
    const s = row({ dueDate: '2026-05-05T00:00:00.000Z' });
    expect(compareOrderSortValues(d, s, desc)).toBe(0);
  });
});

describe('③ NULL / 空值排序规则（文本列）', () => {
  it('PO 号为空 → 无论 asc/desc 都排在最后', () => {
    const empty = row({ poNo: null, dueDate: '2026-01-01T00:00:00.000Z' });
    const blank = row({ poNo: '   ', dueDate: '2026-01-01T00:00:00.000Z' });
    const has = row({ poNo: 'PO-001', dueDate: '2026-01-01T00:00:00.000Z' });
    const asc: OrderSortKey[] = [{ field: 'poNo', dir: 'asc' }];
    const desc: OrderSortKey[] = [{ field: 'poNo', dir: 'desc' }];
    expect(compareOrderSortValues(empty, has, asc)).toBeGreaterThan(0);
    expect(compareOrderSortValues(empty, has, desc)).toBeGreaterThan(0);
    expect(compareOrderSortValues(blank, has, asc)).toBeGreaterThan(0);
    expect(compareOrderSortValues(empty, blank, asc)).toBe(0);
  });

  it('客户名为空 → 沉底；有条目时按码点升序', () => {
    const a = row({ customerName: 'A 客户' });
    const b = row({ customerName: 'B 客户' });
    const none = row({ customerName: null });
    const asc: OrderSortKey[] = [{ field: 'customer', dir: 'asc' }];
    expect(compareOrderSortValues(a, b, asc)).toBeLessThan(0);
    expect(compareOrderSortValues(none, a, asc)).toBeGreaterThan(0);
  });

  it('数值列缺省（null/NaN/空串）沉底；0 是有效值，不沉底', () => {
    const zero = row({ invoicedCents: 0 });
    const some = row({ invoicedCents: 12300 });
    const none = row({ invoicedCents: null });
    const nan = row({ invoicedCents: Number.NaN });
    const asc: OrderSortKey[] = [{ field: 'invoiced', dir: 'asc' }];
    const desc: OrderSortKey[] = [{ field: 'invoiced', dir: 'desc' }];
    expect(compareOrderSortValues(zero, some, asc)).toBeLessThan(0);
    expect(compareOrderSortValues(none, zero, asc)).toBeGreaterThan(0);
    expect(compareOrderSortValues(nan, zero, desc)).toBeGreaterThan(0);
    expect(compareOrderSortValues(none, nan, asc)).toBe(0);
  });
});

describe('④ 状态 / 开票状态按业务序（不是字母序）', () => {
  const asc = (field: OrderSortKey['field']): OrderSortKey[] => [{ field, dir: 'asc' }];
  it('订单状态：草稿 < 已确认 < 生产中 < 已完成 < 已取消（五态按生命周期）', () => {
    const order = ['draft', 'confirmed', 'production', 'completed', 'cancelled'];
    for (let i = 0; i + 1 < order.length; i++) {
      expect(compareOrderSortValues(row({ status: order[i] }), row({ status: order[i + 1] }), asc('status'))).toBeLessThan(0);
    }
    // 字母序会得到 cancelled < completed < ...，必须与业务序不同 —— 这里断言确实不是字母序
    expect(compareOrderSortValues(row({ status: 'draft' }), row({ status: 'cancelled' }), asc('status'))).toBeLessThan(0);
  });

  it('未知状态（含非订单枚举的 voided）给 99，排在已知状态之后，不算缺失', () => {
    expect(compareOrderSortValues(row({ status: 'cancelled' }), row({ status: 'voided' }), asc('status'))).toBeLessThan(0);
    expect(compareOrderSortValues(row({ status: 'completed' }), row({ status: 'weird' }), asc('status'))).toBeLessThan(0);
    expect(compareOrderSortValues(row({ status: 'weird' }), row({ status: null }), asc('status'))).toBeLessThan(0);
  });

  it('开票状态：未开票 < 部分开票 < 已开完', () => {
    expect(compareOrderSortValues(row({ invoiceState: 'none' }), row({ invoiceState: 'partial' }), asc('invoiceState'))).toBeLessThan(0);
    expect(compareOrderSortValues(row({ invoiceState: 'partial' }), row({ invoiceState: 'done' }), asc('invoiceState'))).toBeLessThan(0);
  });
});

describe('⑤ 多键比较：依次比较，前键相等才看后键', () => {
  it('客户 ASC + 交期 DESC', () => {
    const keys: OrderSortKey[] = [{ field: 'customer', dir: 'asc' }, { field: 'dueDate', dir: 'desc' }];
    const a1 = row({ customerName: 'A 客户', dueDate: '2026-01-01T00:00:00.000Z' });
    const a2 = row({ customerName: 'A 客户', dueDate: '2026-08-01T00:00:00.000Z' });
    const b1 = row({ customerName: 'B 客户', dueDate: '2026-12-01T00:00:00.000Z' });
    expect(compareOrderSortValues(a1, a2, keys)).toBeGreaterThan(0); // 同客户：交期大在前
    expect(compareOrderSortValues(a2, b1, keys)).toBeLessThan(0); // 客户优先于交期
  });

  it('前键相等 → 看后键；全部相等 → 0', () => {
    const keys: OrderSortKey[] = [
      { field: 'customer', dir: 'asc' }, { field: 'status', dir: 'asc' }, { field: 'amount', dir: 'desc' },
    ];
    const x = row({ customerName: 'A', status: 'draft', totalAmountCents: 100 });
    const y = row({ customerName: 'A', status: 'draft', totalAmountCents: 200 });
    expect(compareOrderSortValues(x, y, keys)).toBeGreaterThan(0);
    expect(compareOrderSortValues(x, { ...x }, keys)).toBe(0);
  });

  it('缺失键优先级：第一键缺失沉底，即使第二键更优', () => {
    const keys: OrderSortKey[] = [{ field: 'poNo', dir: 'asc' }, { field: 'amount', dir: 'desc' }];
    const noPo = row({ poNo: null, totalAmountCents: 999999 });
    const hasPo = row({ poNo: 'PO-1', totalAmountCents: 1 });
    expect(compareOrderSortValues(noPo, hasPo, keys)).toBeGreaterThan(0);
  });
});

describe('⑥ sortOrdersByKeys：列表级排序（含哨兵日沉底 + 创建时间兜底）', () => {
  /** 造订单行（结构同 attachLines 的返回：金额/开票状态/待补项/产品行数都是派生值） */
  const order = (id: number, patch: Record<string, unknown>) => ({
    id,
    orderNo: 'SO-2026-' + String(id).padStart(3, '0'),
    customerName: 'A 客户',
    status: 'draft',
    invoiceState: 'none',
    totalAmountCents: 0,
    invoicedCents: 0,
    pendingItems: [],
    lines: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  });

  it('默认排序（dueDate DESC）：真实交期从大到小，待定草稿排在最后', () => {
    const rows = [
      order(1, { dueDate: '2099-12-31T00:00:00.000Z', dueDateTbd: true }), // 缺交期的识单草稿
      order(2, { dueDate: '2026-03-01T00:00:00.000Z' }),
      order(3, { dueDate: '2026-09-01T00:00:00.000Z' }),
    ];
    const sorted = sortOrdersByKeys(rows, parseOrderSort(undefined), (r) => orderToSortValues(r));
    expect(sorted.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it('同级（都待定）→ 按创建时间 DESC（新单在前），再按取数顺序（id DESC）稳定兜底', () => {
    const rows = [
      order(1, { dueDate: '2099-12-31T00:00:00.000Z', dueDateTbd: true, createdAt: '2026-05-01T00:00:00.000Z' }),
      order(2, { dueDate: '2099-12-31T00:00:00.000Z', dueDateTbd: true, createdAt: '2026-06-01T00:00:00.000Z' }),
      order(3, { dueDate: '2099-12-31T00:00:00.000Z', dueDateTbd: true, createdAt: '2026-05-01T00:00:00.000Z' }),
    ];
    const sorted = sortOrdersByKeys(rows, parseOrderSort('dueDate:desc'), (r) => orderToSortValues(r));
    expect(sorted.map((r) => r.id)).toEqual([2, 1, 3]); // id 1 在入参中先于 id 3 且创建时间相同 → 保持相对顺序
  });

  it('组合排序：客户 ASC + 交期 DESC（缺交期沉底）', () => {
    const rows = [
      order(1, { customerName: 'B 客户', dueDate: '2026-01-01T00:00:00.000Z' }),
      order(2, { customerName: 'A 客户', dueDate: '2026-02-01T00:00:00.000Z' }),
      order(3, { customerName: 'A 客户', dueDate: '2026-08-01T00:00:00.000Z' }),
      order(4, { customerName: 'A 客户', dueDate: '2099-12-31T00:00:00.000Z', dueDateTbd: true }),
      order(5, { customerName: 'A 客户', dueDate: '2099-12-31T00:00:00.000Z', dueDateTbd: true, createdAt: '2026-09-09T00:00:00.000Z' }),
    ];
    const sorted = sortOrdersByKeys(rows, parseOrderSort('customer:asc,dueDate:desc'), (r) => orderToSortValues(r));
    // A 客户组：交期 8 月 → 2 月 → 待定（按创建时间 DESC：id5 比 id4 新）
    expect(sorted.map((r) => r.id)).toEqual([3, 2, 5, 4, 1]);
  });

  it('金额 DESC / 已开票 DESC / 产品行数 ASC 都能排（数值列）', () => {
    const rows = [
      order(1, { totalAmountCents: 500, invoicedCents: 0, lines: [{}] }),
      order(2, { totalAmountCents: 900, invoicedCents: 300, lines: [{}, {}] }),
      order(3, { totalAmountCents: 100, invoicedCents: 900, lines: [{}, {}, {}] }),
    ];
    const byAmount = sortOrdersByKeys(rows, parseOrderSort('amount:desc'), (r) => orderToSortValues(r));
    expect(byAmount.map((r) => r.id)).toEqual([2, 1, 3]);
    const byInvoiced = sortOrdersByKeys(rows, parseOrderSort('invoiced:desc'), (r) => orderToSortValues(r));
    expect(byInvoiced.map((r) => r.id)).toEqual([3, 2, 1]);
    const byLines = sortOrdersByKeys(rows, parseOrderSort('lineCount:asc'), (r) => orderToSortValues(r));
    expect(byLines.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('待补项数量 ASC：已补全（0）在前，待补多的在后', () => {
    const rows = [
      order(1, { pendingItems: [{ code: 'price_missing' }, { code: 'quantity_missing' }] }),
      order(2, { pendingItems: [] }),
      order(3, { pendingItems: [{ code: 'due_date_missing' }] }),
    ];
    const sorted = sortOrdersByKeys(rows, parseOrderSort('pendingCount:asc'), (r) => orderToSortValues(r));
    expect(sorted.map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it('不改动入参数组（纯函数）', () => {
    const rows = [order(1, { dueDate: '2026-01-01T00:00:00.000Z' }), order(2, { dueDate: '2026-06-01T00:00:00.000Z' })];
    const before = rows.map((r) => r.id);
    sortOrdersByKeys(rows, parseOrderSort('dueDate:desc'), (r) => orderToSortValues(r));
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});
