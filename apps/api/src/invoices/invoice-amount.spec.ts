import { BadRequestException } from '@nestjs/common';
import { RATE_SCALE, bpToRate, rateToBp, taxCentsOf } from '../common/money';
import { normalizeInvoiceAmounts, solveExclFromIncl } from './invoice-amount';
import { ALLOWED_DEFAULT_TAX_RATES, normalizeDefaultTaxRate } from './invoice-settings';
import {
  alreadyVoidedMessage, amountImmutableMessage, invoiceNoConflictMessage, invoiceNoImmutableMessage,
  orderCustomerMismatchMessage, ordersMissingMessage, voidedImmutableMessage,
} from './invoice-messages';

/** 断言抛出 BadRequestException 且中文提示包含关键字 */
const expectReject = (fn: () => unknown, includes: string[] = []) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    const msg = String((e as BadRequestException).message);
    for (const kw of includes) expect(msg).toContain(kw);
    return msg;
  }
  throw new Error('预期抛出 BadRequestException，但实际未抛出');
};

describe('开票金额三兄弟校验（I16）', () => {
  it('不含税 100.00 元 × 13% → 税额 13.00、含税 113.00（三元恒等）', () => {
    const r = normalizeInvoiceAmounts({ amountExclCents: 10000, taxRate: 0.13, taxCents: 1300, amountInclCents: 11300 });
    expect(r).toEqual({ amountExclCents: 10000, taxRate: 0.13, taxCents: 1300, amountInclCents: 11300 });
  });

  it('税额/含税缺省时按恒等式自动计算', () => {
    const r = normalizeInvoiceAmounts({ amountExclCents: 10000, taxRate: 0.13 });
    expect(r.taxCents).toBe(1300);
    expect(r.amountInclCents).toBe(11300);
  });

  it('税额按税率四舍五入到整分：123.45 × 13% = 16.05（1604.85 分进位）', () => {
    // 12345 × 0.13 = 1604.85 分 → 半进位 1605
    expect(taxCentsOf(12345, 0.13)).toBe(1605);
    const r = normalizeInvoiceAmounts({ amountExclCents: 12345, taxRate: 0.13 });
    expect(r.taxCents).toBe(1605);
    expect(r.amountInclCents).toBe(12345 + 1605);
  });

  it('税率 0.01 / 0.06 / 0.09 / 0 与边界半进位（0.5 元 × 13% = 6.5 分 → 7 分）', () => {
    expect(taxCentsOf(10000, 0.01)).toBe(100);
    expect(taxCentsOf(10000, 0.06)).toBe(600);
    expect(taxCentsOf(10000, 0.09)).toBe(900);
    expect(taxCentsOf(10000, 0)).toBe(0);
    expect(taxCentsOf(50, 0.13)).toBe(7); // 6.5 分，半进位
    expect(taxCentsOf(1, 0.13)).toBe(0); // 0.13 分，舍去
  });

  it('税率定点换算：0.13 → 1300 万分点，且往返无漂移', () => {
    expect(rateToBp(0.13)).toBe(1300);
    expect(rateToBp(0.09)).toBe(900);
    expect(bpToRate(1300)).toBe(0.13);
    expect(RATE_SCALE).toBe(10000);
  });

  it('负数金额一律拒绝（不含税 / 税额 / 含税），中文提示含字段名与实际值', () => {
    expectReject(() => normalizeInvoiceAmounts({ amountExclCents: -1, taxRate: 0.13 }), ['不含税金额', 'amountExclCents', '不能为负', '-1']);
    expectReject(() => normalizeInvoiceAmounts({ amountExclCents: 10000, taxRate: 0.13, taxCents: -5 }), ['税额', 'taxCents', '不能为负', '-5']);
    expectReject(() => normalizeInvoiceAmounts({ amountExclCents: 10000, taxRate: 0.13, amountInclCents: -1 }), ['含税金额', 'amountInclCents', '不能为负']);
  });

  it('含税金额必须大于 0（不含税与税额同时为 0 时拒绝）', () => {
    const msg = expectReject(() => normalizeInvoiceAmounts({ amountExclCents: 0, taxRate: 0 }), ['含税金额', '必须大于 0']);
    expect(msg).toContain('0.00 元（0 分）');
  });

  it('三兄弟不一致时给出期望值与实际值：税额错 / 含税错', () => {
    const m1 = expectReject(
      () => normalizeInvoiceAmounts({ amountExclCents: 10000, taxRate: 0.13, taxCents: 1200, amountInclCents: 11200 }),
      ['税额', 'taxCents', '不一致', '期望 13.00 元（1300 分）', '实际 12.00 元（1200 分）'],
    );
    expect(m1).toContain('13%');
    expectReject(
      () => normalizeInvoiceAmounts({ amountExclCents: 10000, taxRate: 0.13, taxCents: 1300, amountInclCents: 11200 }),
      ['含税金额', 'amountInclCents', '期望 113.00 元（11300 分）', '实际 112.00 元（11200 分）'],
    );
  });

  it('非整数分 / 非法税率 / 缺金额均拒绝', () => {
    expectReject(() => normalizeInvoiceAmounts({ amountExclCents: 100.5, taxRate: 0.13 }), ['不含税金额', '整数']);
    expectReject(() => normalizeInvoiceAmounts({ amountExclCents: 10000, taxRate: 'abc' }), ['税率', '必须是数字']);
    expectReject(() => normalizeInvoiceAmounts({ amountExclCents: 10000, taxRate: 13 }), ['税率', '须在 0 ~ 1 之间']);
    expectReject(() => normalizeInvoiceAmounts({ taxRate: 0.13 }), ['不含税金额', '必填']);
  });
});

describe('开票金额简化入参（I16 交互简化）：只给含税金额', () => {
  it('只给含税金额、不给税率 → 税率默认 0、不含税 = 含税、税额 = 0', () => {
    const r = normalizeInvoiceAmounts({ amountInclCents: 100000 });
    expect(r).toEqual({ amountExclCents: 100000, taxRate: 0, taxCents: 0, amountInclCents: 100000 });
  });

  it('只给含税金额 + 13% → 反解不含税 100.00 元、税额 13.00 元（恒等式成立）', () => {
    const r = normalizeInvoiceAmounts({ amountInclCents: 11300, taxRate: 0.13 });
    expect(r).toEqual({ amountExclCents: 10000, taxRate: 0.13, taxCents: 1300, amountInclCents: 11300 });
    expect(r.amountExclCents + r.taxCents).toBe(r.amountInclCents);
  });

  it('反解在 ±2 分内收敛：含税 9% 与 6% 抽样自洽', () => {
    for (const [incl, rate] of [[10900, 0.09], [10600, 0.06], [10100, 0.01], [12345, 0.13]] as Array<[number, number]>) {
      const excl = solveExclFromIncl(incl, rate);
      expect(excl).not.toBeNull();
      expect(taxCentsOf(excl as number, rate) + (excl as number)).toBe(incl);
    }
  });

  it('只给含税 + 税额 → 反解不含税（含税 − 税额）并复核恒等式', () => {
    const r = normalizeInvoiceAmounts({ amountInclCents: 11300, taxCents: 1300, taxRate: 0.13 });
    expect(r.amountExclCents).toBe(10000);
    expect(r.amountInclCents).toBe(11300);
  });

  it('无整数分解时明确拒绝：含税 1 分 + 100% 税率', () => {
    expectReject(() => normalizeInvoiceAmounts({ amountInclCents: 1, taxRate: 1 }), ['无法反解', '含税金额', 'amountExclCents']);
  });

  it('含税金额为 0 或负数仍拒绝', () => {
    expectReject(() => normalizeInvoiceAmounts({ amountInclCents: 0 }), ['含税金额', '必须大于 0']);
    expectReject(() => normalizeInvoiceAmounts({ amountInclCents: -100 }), ['含税金额', '不能为负']);
  });
});

describe('红字发票金额（I16 红冲）：负数三金额 + 与正数镜像', () => {
  it('全额红冲镜像：+3539.82/13% → −3539.82，税额与含税同时取负，净额可精确归零', () => {
    const r = normalizeInvoiceAmounts(
      { amountExclCents: -353982, taxRate: 0.13, taxCents: -46018, amountInclCents: -400000 },
      { allowNegative: true },
    );
    expect(r).toEqual({ amountExclCents: -353982, taxRate: 0.13, taxCents: -46018, amountInclCents: -400000 });
    expect(r.amountExclCents + r.taxCents).toBe(r.amountInclCents);
  });

  it('负数税额按绝对值对称（12345 × 13% → 正 1605 / 负 −1605，不是 −1604）', () => {
    const r = normalizeInvoiceAmounts({ amountExclCents: -12345, taxRate: 0.13 }, { allowNegative: true });
    expect(r.taxCents).toBe(-1605);
    expect(r.amountInclCents).toBe(-12345 - 1605);
  });

  it('只给负含税金额也能反解（红字票按正数反解后取负）', () => {
    const r = normalizeInvoiceAmounts({ amountInclCents: -11300, taxRate: 0.13 }, { allowNegative: true });
    expect(r).toEqual({ amountExclCents: -10000, taxRate: 0.13, taxCents: -1300, amountInclCents: -11300 });
  });

  it('红字票三金额必须为负：给 0 或正数一律拒绝', () => {
    expectReject(() => normalizeInvoiceAmounts({ amountExclCents: 10000, taxRate: 0.13 }, { allowNegative: true }), ['红字发票', '必须为负数']);
    expectReject(() => normalizeInvoiceAmounts({ amountInclCents: 0 }, { allowNegative: true }), ['红字发票', '必须为负数']);
    expectReject(() => normalizeInvoiceAmounts({ amountExclCents: -10000, taxRate: 0.13, taxCents: 1300 }, { allowNegative: true }), ['红字发票', '税额', '负数']);
  });
});

describe('开票默认税率设置（I16 收敛②）', () => {
  it('仅允许 0 / 1% / 6% / 9% / 13%（按万分点整数比较）', () => {
    expect(ALLOWED_DEFAULT_TAX_RATES).toEqual([0, 0.01, 0.06, 0.09, 0.13]);
    expect(normalizeDefaultTaxRate(0)).toBe(0);
    expect(normalizeDefaultTaxRate('0.13')).toBe(0.13);
    expect(normalizeDefaultTaxRate(0.09)).toBe(0.09);
  });

  it('非法值给中文提示（含允许值）', () => {
    expectReject(() => normalizeDefaultTaxRate(0.03), ['开票默认税率', '0 / 1% / 6% / 9% / 13%']);
    expectReject(() => normalizeDefaultTaxRate('abc'), ['开票默认税率', '必须是数字']);
    expectReject(() => normalizeDefaultTaxRate(13), ['开票默认税率']);
  });
});

describe('开票中文提示文案（I16）', () => {
  it('发票号冲突提示含票号与处置建议', () => {
    const msg = invoiceNoConflictMessage('INV-001');
    expect(msg).toContain('发票号码「INV-001」已存在（未作废）');
    expect(msg).toContain('先作废原发票');
  });

  it('金额不可改 / 已作废不可改 / 重复作废提示', () => {
    expect(amountImmutableMessage('不含税金额（amountExclCents）')).toContain('请先作废');
    expect(invoiceNoImmutableMessage('INV-004')).toContain('不可修改');
    expect(voidedImmutableMessage('INV-002')).toContain('已作废，不可修改');
    expect(alreadyVoidedMessage('INV-003', '2026-03-01 10:20', '开错客户')).toContain('已作废（2026-03-01 10:20，原因：开错客户）');
  });

  it('关联订单校验提示（不存在 / 客户不一致）', () => {
    expect(ordersMissingMessage([7, 9])).toContain('关联订单不存在（id=7、9）');
    expect(orderCustomerMismatchMessage(['SO-1', 'SO-2'], 3)).toContain('SO-1、SO-2 属于其他客户（发票客户 id=3）');
  });
});
