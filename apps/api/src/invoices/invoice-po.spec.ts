import { aggregatePoNos, duplicatePoWarning, normalizePoNo, poFilterPattern } from './invoice-po';

/**
 * 发票 PO 号派生逻辑单测（I18）
 * ------------------------------------------------------------------
 * 覆盖：① PO 聚合去重；② 多单多 PO（保序）；③ 无 PO 空值处理；④ 按 PO 筛选模式串；
 *       ⑤ 重复开票 warning 文案（含同一 PO 多票合并、多 PO 分隔）。
 */
describe('invoice-po：单值归一化', () => {
  it('去首尾空白；空白/缺省 → null', () => {
    expect(normalizePoNo('  AB25 758 ')).toBe('AB25 758');
    expect(normalizePoNo('PO-1')).toBe('PO-1');
    expect(normalizePoNo('   ')).toBeNull();
    expect(normalizePoNo('')).toBeNull();
    expect(normalizePoNo(undefined)).toBeNull();
    expect(normalizePoNo(null)).toBeNull();
  });
});

describe('invoice-po：从关联订单聚合 PO 号', () => {
  it('单订单单 PO → 单元素数组', () => {
    expect(aggregatePoNos([{ poNo: 'AB25 758' }])).toEqual(['AB25 758']);
  });

  it('多单多 PO：保序（按关联订单顺序）', () => {
    expect(aggregatePoNos([{ poNo: 'PO-A' }, { poNo: 'PO-B' }, { poNo: 'PO-C' }]))
      .toEqual(['PO-A', 'PO-B', 'PO-C']);
  });

  it('去重：同一 PO 出现在多张订单只算一次（并保留首次出现的位置）', () => {
    expect(aggregatePoNos([{ poNo: 'PO-A' }, { poNo: 'PO-B' }, { poNo: 'PO-A' }]))
      .toEqual(['PO-A', 'PO-B']);
  });

  it('归一化后相等即去重（仅首尾空白差异），但内容不同绝不合并', () => {
    expect(aggregatePoNos([{ poNo: ' PO-A ' }, { poNo: 'PO-A' }, { poNo: 'PO-A ' }])).toEqual(['PO-A']);
    // 空格是 PO 内容的一部分：「AB25 758」与「AB25758」是两个不同的 PO，不得归一为同一个
    expect(aggregatePoNos([{ poNo: 'AB25 758' }, { poNo: 'AB25758' }])).toEqual(['AB25 758', 'AB25758']);
  });

  it('无 PO / 空值处理：null、undefined、空串、纯空白一律丢弃，不产生占位', () => {
    expect(aggregatePoNos([{ poNo: null }, { poNo: undefined }, { poNo: '' }, { poNo: '   ' }])).toEqual([]);
    expect(aggregatePoNos([])).toEqual([]);
    expect(aggregatePoNos(null)).toEqual([]);
    expect(aggregatePoNos(undefined)).toEqual([]);
  });

  it('混合：有 PO 与无 PO 订单同票 → 只保留有 PO 的，且顺序不变', () => {
    expect(aggregatePoNos([{ poNo: 'PO-A' }, { poNo: null }, { poNo: 'PO-B' }]))
      .toEqual(['PO-A', 'PO-B']);
  });
});

describe('invoice-po：按 PO 号筛选（ilike 模式串）', () => {
  it('模糊匹配：查询串包进 %…%', () => {
    expect(poFilterPattern('AB25')).toBe('%AB25%');
    expect(poFilterPattern('  AB25 758  ')).toBe('%AB25 758%');
  });

  it('空查询 = 不筛选（null），与既有 keyword 行为一致', () => {
    expect(poFilterPattern('')).toBeNull();
    expect(poFilterPattern('   ')).toBeNull();
    expect(poFilterPattern(undefined)).toBeNull();
    expect(poFilterPattern(null)).toBeNull();
  });
});

describe('invoice-po：重复开票提示（不阻断）', () => {
  it('命中一个 PO：列出 PO 与已存在的发票号', () => {
    expect(duplicatePoWarning([{ poNo: 'AB25 758', invoiceNo: 'INV-2026-001' }]))
      .toBe('PO AB25 758 已开过票（发票号 INV-2026-001），请确认是否重复开票');
  });

  it('同一 PO 命中多张发票 → 发票号合并列出（不重复列同一张）', () => {
    expect(duplicatePoWarning([
      { poNo: 'PO-A', invoiceNo: 'INV-1' },
      { poNo: 'PO-A', invoiceNo: 'INV-2' },
      { poNo: 'PO-A', invoiceNo: 'INV-1' },
    ])).toBe('PO PO-A 已开过票（发票号 INV-1、INV-2），请确认是否重复开票');
  });

  it('多个 PO 命中 → 用「；」分隔，顺序按首次出现', () => {
    expect(duplicatePoWarning([
      { poNo: 'PO-A', invoiceNo: 'INV-1' },
      { poNo: 'PO-B', invoiceNo: 'INV-2' },
    ])).toBe('PO PO-A 已开过票（发票号 INV-1），请确认是否重复开票；PO PO-B 已开过票（发票号 INV-2），请确认是否重复开票');
  });

  it('无命中 / 空 PO / 空发票号 → undefined（不产生提示）', () => {
    expect(duplicatePoWarning([])).toBeUndefined();
    expect(duplicatePoWarning(null)).toBeUndefined();
    expect(duplicatePoWarning(undefined)).toBeUndefined();
    expect(duplicatePoWarning([{ poNo: null, invoiceNo: 'INV-1' }])).toBeUndefined();
    expect(duplicatePoWarning([{ poNo: 'PO-A', invoiceNo: null }])).toBeUndefined();
    expect(duplicatePoWarning([{ poNo: 'PO-A', invoiceNo: '  ' }])).toBeUndefined();
  });
});
