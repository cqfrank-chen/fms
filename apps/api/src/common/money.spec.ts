import { toCents, fromCents, lineCents, sumLineCents, round2, centsEq, remainOf, MONEY_EPS } from './money';

/**
 * 金额分定点纯函数单测（对应 v1 Review 高危项「金额浮点」的回归网）
 * 运行：npm test -- money.spec.ts
 */
describe('money：分定点工具', () => {
  it('toCents / fromCents 往返不丢分', () => {
    expect(toCents(0)).toBe(0);
    expect(toCents(0.1)).toBe(10);
    expect(toCents(12.34)).toBe(1234);
    expect(toCents('12.34')).toBe(1234);
    expect(toCents(null)).toBe(0);
    expect(fromCents(1234)).toBe(12.34);
    expect(toCents(fromCents(toCents(999.99)))).toBe(99999);
  });

  it('经典浮点陷阱：0.1+0.2 按分相加精确', () => {
    expect(fromCents(toCents(0.1) + toCents(0.2))).toBe(0.3);
    expect(0.1 + 0.2).not.toBe(0.3); // 反证：binary64 本身不精确，故金额一律走分
  });

  it('lineCents：数量 × 单价（按分）精确，无 binary64 尾差', () => {
    expect(lineCents(3, 0.1)).toBe(30);
    expect(lineCents(500, 25)).toBe(1250000);
    expect(lineCents(7, 0.2)).toBe(140);
    expect(fromCents(lineCents(3, 0.1))).toBe(0.3); // 直接 3*0.1 = 0.30000000000000004
  });

  it('sumLineCents：多行合计再转元，无分位尾差', () => {
    const lines = [{ quantity: 3, unitPrice: 0.1 }, { quantity: 7, unitPrice: 0.2 }, { quantity: 1, unitPrice: 10 }];
    expect(sumLineCents(lines)).toBe(30 + 140 + 1000);
    expect(fromCents(sumLineCents(lines))).toBe(11.7);
  });

  it('round2：按分四舍五入；binary64 表示略低于半分时向下（如实反映输入）', () => {
    expect(round2(12.344)).toBe(12.34);
    expect(round2(12.345)).toBe(12.35); // 12.345*100 = 1234.5000000000002 → 进位
    expect(round2(1.005)).toBe(1); // 1.005*100 = 100.49999999999999 → 100（binary64 表示所致）
    expect(round2('0.1')).toBe(0.1);
  });

  it('centsEq：按分严格比较（同分即等，差 1 分即不等）', () => {
    expect(centsEq(0.1 + 0.2, 0.3)).toBe(true);
    expect(centsEq(12.34, 12.34)).toBe(true);
    expect(centsEq(12.345, 12.34)).toBe(false); // 1235 分 ≠ 1234 分
    expect(centsEq(1000, 1000.004)).toBe(true); // 同为 100000 分
    expect(MONEY_EPS).toBe(0.005);
  });

  it('remainOf：剩余金额按分计算且不为负', () => {
    expect(remainOf(1000, 300)).toBe(700);
    expect(remainOf(100, 150)).toBe(0);
    expect(remainOf(0.3, 0.1)).toBe(0.2);
  });
});
