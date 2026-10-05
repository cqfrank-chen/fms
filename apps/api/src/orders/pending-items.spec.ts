import {
  computeLinePending, computeOrderPending, hasPending, PENDING_CODES, pendingCount, pendingText,
} from './pending-items';

/**
 * 「待补」判定单元测试（纯函数，不连数据库）
 * ------------------------------------------------------------------
 * 甲方要求：识单结果先落草稿订单，缺价/缺交期/缺客户/产品未建档等**逐行标记待补**，
 * 且诊断必须是**中文**（界面上直接可见）。本用例锁定判定口径与中文措辞的关键字。
 */

const codes = (items: Array<{ code: string }>) => items.map((x) => x.code);

describe('① 行级待补：缺数量 / 缺单价 / 产品未建档', () => {
  it('数量、单价、产品都齐 → 无待补', () => {
    const items = computeLinePending({ productId: 22, productName: '1-101 割嘴 00#', quantity: 200, unitPrice: 13.2 });
    expect(items).toEqual([]);
    expect(hasPending(items)).toBe(false);
  });

  it('缺单价 → price_missing（中文诊断可读）', () => {
    const items = computeLinePending({ productId: 22, quantity: 200, unitPrice: null });
    expect(codes(items)).toEqual([PENDING_CODES.PRICE_MISSING]);
    expect(items[0].message).toContain('缺单价');
    expect(items[0].message).toContain('报价');
  });

  it('缺数量 → quantity_missing', () => {
    const items = computeLinePending({ productId: 22, quantity: 0, unitPrice: 9.7 });
    expect(codes(items)).toEqual([PENDING_CODES.QUANTITY_MISSING]);
    expect(items[0].message).toContain('缺数量');
  });

  it('产品未建档 → product_not_filed，且带出识别到的产品原文', () => {
    const items = computeLinePending({ productId: null, productName: 'PNME18 割嘴 1/16', quantity: 100, unitPrice: 7.07 });
    expect(codes(items)).toEqual([PENDING_CODES.PRODUCT_NOT_FILED]);
    expect(items[0].message).toContain('PNME18 割嘴 1/16');
  });

  it('多项同时缺 → 固定顺序：产品 → 数量 → 单价（界面展示稳定）', () => {
    const items = computeLinePending({ productId: null, productName: '未知产品', quantity: null, unitPrice: null });
    expect(codes(items)).toEqual([
      PENDING_CODES.PRODUCT_NOT_FILED, PENDING_CODES.QUANTITY_MISSING, PENDING_CODES.PRICE_MISSING,
    ]);
  });

  it('报价补价成功的行（priceFrom=quote）不再算缺价', () => {
    const filled = computeLinePending({ productId: 22, quantity: 200, unitPrice: 6.05, priceFrom: 'quote' });
    expect(filled).toEqual([]);
    // 但没给价的「报价行」仍算缺价（防脏数据）
    const bad = computeLinePending({ productId: 22, quantity: 200, unitPrice: null, priceFrom: 'quote' });
    expect(codes(bad)).toEqual([PENDING_CODES.PRICE_MISSING]);
  });
});

describe('② 单头待补：客户未建档 / 缺交期 / 无产品行 / 行级汇总', () => {
  const noLinePending: never[][] = [];

  it('客户与交期都齐、有产品行 → 单头无待补', () => {
    const items = computeOrderPending({ customerId: 3, customerName: '安宝公司', dueDate: '2026-09-10' }, [[], []]);
    expect(items).toEqual([]);
  });

  it('客户未建档（customerId 为空）→ customer_not_filed', () => {
    const items = computeOrderPending({ customerId: null, customerName: '嵊州海田', dueDate: '2026-09-10' }, [[]]);
    expect(codes(items)).toEqual([PENDING_CODES.CUSTOMER_NOT_FILED]);
    expect(items[0].message).toContain('嵊州海田');
    expect(items[0].message).toContain('未建档客户');
  });

  it('缺交期 / 交期非法 → due_date_missing（界面显示「待定」）', () => {
    const a = computeOrderPending({ customerId: 3, dueDate: null }, [[]]);
    expect(codes(a)).toEqual([PENDING_CODES.DUE_DATE_MISSING]);
    const b = computeOrderPending({ customerId: 3, dueDate: '待定' }, [[]]);
    expect(codes(b)).toEqual([PENDING_CODES.DUE_DATE_MISSING]);
    expect(b[0].message).toContain('待定');
  });

  it('没有任何产品行 → no_product_lines', () => {
    const items = computeOrderPending({ customerId: 3, dueDate: '2026-09-10' }, noLinePending);
    expect(codes(items)).toEqual([PENDING_CODES.NO_PRODUCT_LINES]);
  });

  it('行级待补 → 单头给一条中文汇总（含分类计数，便于列表一眼看出）', () => {
    const linePendings = [
      computeLinePending({ productId: 22, quantity: 100, unitPrice: null }), // 缺价
      computeLinePending({ productId: 22, quantity: 100, unitPrice: null }), // 缺价
      computeLinePending({ productId: null, productName: 'X', quantity: 100, unitPrice: 1 }), // 未建档
      [], // 正常行
    ];
    const items = computeOrderPending({ customerId: 3, dueDate: '2026-09-10' }, linePendings);
    expect(codes(items)).toEqual([PENDING_CODES.LINE_PENDING]);
    expect(items[0].message).toContain('缺单价 2 行');
    expect(items[0].message).toContain('产品未建档 1 行');
    expect(items[0].message).toContain('有未补全项的草稿单');
  });

  it('缺客户 + 缺交期 + 行级缺价 → 三条并列（订单级 + 汇总）', () => {
    const linePendings = [computeLinePending({ productId: null, productName: 'Y', quantity: null, unitPrice: null })];
    const items = computeOrderPending({ customerId: null, customerName: null, dueDate: null }, linePendings);
    expect(codes(items)).toEqual([
      PENDING_CODES.CUSTOMER_NOT_FILED, PENDING_CODES.DUE_DATE_MISSING, PENDING_CODES.LINE_PENDING,
    ]);
  });
});

describe('③ 辅助函数（界面/拦截提示共用）', () => {
  it('hasPending：null / 空数组都不算待补（普通订单向后兼容）', () => {
    expect(hasPending(null)).toBe(false);
    expect(hasPending(undefined)).toBe(false);
    expect(hasPending([])).toBe(false);
    expect(hasPending([{ code: 'x', message: 'y' }])).toBe(true);
  });

  it('pendingText / pendingCount', () => {
    const items = computeOrderPending({ customerId: null, dueDate: null }, [[]]);
    expect(pendingCount(items)).toBe(2);
    expect(pendingText(items)).toContain('客户未建档');
    expect(pendingText(null)).toBe('');
  });
});
