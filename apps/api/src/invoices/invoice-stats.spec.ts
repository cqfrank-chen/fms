import {
  buildOrderInvoiceView, isCountedInvoice, orderInvoiceState, overInvoiceBlocked,
  partialInvoiceNote, redFlushedCents, redRemainCents, summarizeInvoices,
} from './invoice-stats';

const inv = (status: string, excl: number, tax: number) => ({
  status, amountExclCents: excl, taxCents: tax, amountInclCents: excl + tax,
});

describe('开票统计（I16）：作废不计入、部分开票累计', () => {
  it('只计未作废：张数/不含税/税额/含税合计', () => {
    const t = summarizeInvoices([inv('normal', 10000, 1300), inv('voided', 5000, 650), inv('normal', 20000, 2600)]);
    expect(t).toEqual({ count: 2, amountExclCents: 30000, taxCents: 3900, amountInclCents: 33900 });
  });

  it('全部作废 → 张数与金额归零（记录仍在，只是不计入）', () => {
    const t = summarizeInvoices([inv('voided', 10000, 1300)]);
    expect(t).toEqual({ count: 0, amountExclCents: 0, taxCents: 0, amountInclCents: 0 });
  });

  it('部分开票累计：订单 1000.00 元，两张发票分别 300.00 / 200.00（含税）', () => {
    const v = buildOrderInvoiceView(100000, [inv('normal', 26548, 3452), inv('normal', 17699, 2301)]);
    // 300.00 元 = 30000 分；200.00 元 = 20000 分
    expect(v.invoicedCents).toBe(50000);
    expect(v.uninvoicedCents).toBe(50000);
    expect(v.overInvoiced).toBe(false);
    expect(v.invoiceCount).toBe(2);
    expect(partialInvoiceNote(v)).toContain('部分开票');
    expect(partialInvoiceNote(v)).toContain('未开票余额 500.00');
  });

  it('作废一张后：已开票金额回落、未开票余额回升、张数-1', () => {
    const rows = [inv('normal', 26548, 3452), inv('voided', 17699, 2301)];
    const v = buildOrderInvoiceView(100000, rows);
    expect(v.invoicedCents).toBe(30000);
    expect(v.uninvoicedCents).toBe(70000);
    expect(v.invoiceCount).toBe(1);
    expect(v.voidedCount).toBe(1);
  });

  it('开满：未开票为 0、无部分开票提示', () => {
    const v = buildOrderInvoiceView(50000, [inv('normal', 44248, 5752)]);
    expect(v.invoicedCents).toBe(50000);
    expect(v.uninvoicedCents).toBe(0);
    expect(partialInvoiceNote(v)).toBeUndefined();
    expect(v.overInvoiced).toBe(false);
  });

  it('超额开票：不阻断但给出 warning（含超出金额）', () => {
    const v = buildOrderInvoiceView(100000, [inv('normal', 100000, 13000), inv('normal', 8849, 1151)]);
    expect(v.invoicedCents).toBe(123000);
    expect(v.uninvoicedCents).toBe(0);
    expect(v.overInvoiced).toBe(true);
    expect(v.warning).toContain('超出订单金额');
    expect(v.warning).toContain('230.00');
  });

  it('未关联订单的开票不影响任何订单口径（空清单）', () => {
    const v = buildOrderInvoiceView(0, []);
    expect(v.invoicedCents).toBe(0);
    expect(v.uninvoicedCents).toBe(0);
    expect(v.invoiceCount).toBe(0);
    expect(partialInvoiceNote(v)).toBeUndefined();
  });
});

describe('订单开票状态三态（I16 交互简化）：未开票 / 部分开票 / 已开完', () => {
  it('已开票 = 0 → 未开票', () => {
    expect(orderInvoiceState(100000, 0)).toBe('none');
    expect(orderInvoiceState(0, 0)).toBe('none');
  });

  it('0 < 已开票 < 价格 → 部分开票（差 1 分也算部分）', () => {
    expect(orderInvoiceState(100000, 1)).toBe('partial');
    expect(orderInvoiceState(100000, 99999)).toBe('partial');
  });

  it('已开票 = 价格 → 已开完', () => {
    expect(orderInvoiceState(100000, 100000)).toBe('done');
  });

  it('已开票 > 价格（超额）→ 仍为已开完且不报错', () => {
    expect(orderInvoiceState(100000, 123000)).toBe('done');
    expect(() => orderInvoiceState(100000, 123000)).not.toThrow();
  });

  it('视图内联状态与函数口径一致（含作废票不计入）', () => {
    expect(buildOrderInvoiceView(100000, []).invoiceState).toBe('none');
    expect(buildOrderInvoiceView(100000, [inv('normal', 88495, 11505)]).invoiceState).toBe('done');
    expect(buildOrderInvoiceView(100000, [inv('normal', 44248, 5752)]).invoiceState).toBe('partial');
    expect(buildOrderInvoiceView(100000, [inv('voided', 88495, 11505)]).invoiceState).toBe('none');
  });
});

describe('红字发票净额口径（I16 红冲）：正常票 + 红字票（负）', () => {
  /** 红字票：三金额均为负 */
  const red = (exclMag: number, taxMag: number) => ({
    status: 'normal', amountExclCents: -exclMag, taxCents: -taxMag, amountInclCents: -(exclMag + taxMag),
  });

  it('计入规则：未作废即计入（已红冲原票计正数、红字票计负数），仅作废票剔除', () => {
    expect(isCountedInvoice('normal')).toBe(true);
    expect(isCountedInvoice('red_flushed')).toBe(true);
    expect(isCountedInvoice('voided')).toBe(false);
  });

  it('净额合计 = 正常票 − 红字票（原票 113.00 全额红冲 113.00 → 净额 0）', () => {
    const t = summarizeInvoices([inv('red_flushed', 10000, 1300), red(10000, 1300)]);
    expect(t).toEqual({ count: 2, amountExclCents: 0, taxCents: 0, amountInclCents: 0 });
  });

  it('部分红冲：原票 1000.00、红冲 300.00 → 净额 700.00', () => {
    const t = summarizeInvoices([inv('red_flushed', 100000, 0), red(30000, 0)]);
    expect(t.amountInclCents).toBe(70000);
  });

  it('作废的红字票不计入（红冲被撤销 → 净额回到原票金额）', () => {
    const t = summarizeInvoices([inv('red_flushed', 100000, 0), { ...red(30000, 0), status: 'voided' }]);
    expect(t.amountInclCents).toBe(100000);
    expect(t.count).toBe(1);
  });

  it('已红冲金额与可红冲余额：累计红冲不得超过原票金额', () => {
    const rows = [red(30000, 0), red(20000, 0)];
    expect(redFlushedCents(rows)).toBe(50000);
    expect(redRemainCents(100000, rows)).toBe(50000);
    expect(redRemainCents(50000, rows)).toBe(0);
    // 作废的红字票不占用可红冲额度
    expect(redRemainCents(100000, [{ ...red(30000, 0), status: 'voided' }])).toBe(100000);
  });

  it('订单净额与三态随红冲回退：全额红冲 → 未开票 / 部分红冲 → 部分开票', () => {
    const full = buildOrderInvoiceView(100000, [inv('red_flushed', 100000, 0), red(100000, 0)]);
    expect(full.invoicedCents).toBe(0);
    expect(full.invoiceState).toBe('none');
    expect(full.uninvoicedCents).toBe(100000);
    const partial = buildOrderInvoiceView(100000, [inv('red_flushed', 100000, 0), red(30000, 0)]);
    expect(partial.invoicedCents).toBe(70000);
    expect(partial.invoiceState).toBe('partial');
    expect(partial.uninvoicedCents).toBe(30000);
  });
});

describe('超开闸门（I16 收敛⑤）：默认阻止、高级显式放行', () => {
  it('未超开 → 不阻止', () => {
    expect(overInvoiceBlocked(100000, 0, 100000, false)).toBe(false);
    expect(overInvoiceBlocked(100000, 40000, 60000, false)).toBe(false);
  });

  it('投影净额超出 → 默认阻止（差 1 分也阻止）', () => {
    expect(overInvoiceBlocked(100000, 40000, 60001, false)).toBe(true);
    expect(overInvoiceBlocked(100000, 100000, 1, false)).toBe(true);
  });

  it('显式 allow=true（高级勾选）→ 放行', () => {
    expect(overInvoiceBlocked(100000, 100000, 50000, true)).toBe(false);
    expect(overInvoiceBlocked(0, 0, 1, true)).toBe(false);
  });

  it('红冲后净额下降，可再次正常开票（闸门按净额判断）', () => {
    // 原票 1000.00 已开满、红冲 300.00 → 净额 700.00，再开 300.00 不算超开
    expect(overInvoiceBlocked(100000, 70000, 30000, false)).toBe(false);
    expect(overInvoiceBlocked(100000, 70000, 30001, false)).toBe(true);
  });
});
