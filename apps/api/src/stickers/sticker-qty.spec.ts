import { STICKER_MAX_QTY, checkQtyDelta, kindToDelta, resolveDelta } from './sticker-qty';

/**
 * 不干胶数量调整规则单测（I18）
 * 覆盖：入库/领用、正负增量、边界（0 库存领用、领多、0 增量、超上限、非法值）。
 */
describe('不干胶 · 数量调整规则', () => {
  it('入库：增量取正', () => {
    expect(kindToDelta('in', 100)).toEqual({ ok: true, delta: 100 });
  });

  it('领用：增量取负', () => {
    expect(kindToDelta('out', 30)).toEqual({ ok: true, delta: -30 });
  });

  it('数量必须为正整数，方向必须合法', () => {
    expect(kindToDelta('out', 0)).toEqual({ ok: false, message: '本次数量须为正整数' });
    expect(kindToDelta('out', -5)).toEqual({ ok: false, message: '本次数量须为正整数' });
    expect(kindToDelta('out', 1.5)).toEqual({ ok: false, message: '本次数量须为正整数' });
    expect(kindToDelta('both' as never, 5)).toEqual({ ok: false, message: '调整方向须为 in（入库）或 out（领用）' });
  });

  it('正常加减', () => {
    expect(checkQtyDelta(100, 50)).toEqual({ ok: true, qtyAfter: 150 });
    expect(checkQtyDelta(100, -40)).toEqual({ ok: true, qtyAfter: 60 });
  });

  it('边界：领用恰好等于库存 → 归零（允许）', () => {
    expect(checkQtyDelta(10, -10)).toEqual({ ok: true, qtyAfter: 0 });
  });

  it('边界：领用超过库存 → 中文报错、不截断', () => {
    const r = checkQtyDelta(10, -11);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toBe('库存不足：当前 10，本次领用 11，最多可领用 10');
  });

  it('边界：0 库存领用 1 → 报错', () => {
    const r = checkQtyDelta(0, -1);
    expect(r.ok).toBe(false);
  });

  it('边界：增量为 0 → 报错（避免空流水）', () => {
    expect(checkQtyDelta(5, 0)).toEqual({ ok: false, message: '调整数量不能为 0' });
  });

  it('边界：超过上限 → 报错', () => {
    const r = checkQtyDelta(STICKER_MAX_QTY, 1);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain('超过上限');
  });

  it('非法入参：小数 / NaN / 负库存 → 中文报错', () => {
    expect(checkQtyDelta(1.5, 1).ok).toBe(false);
    expect(checkQtyDelta(Number.NaN, 1).ok).toBe(false);
    expect(checkQtyDelta(-1, 1).ok).toBe(false);
    expect(checkQtyDelta(10, 1.5).ok).toBe(false);
  });

  it('resolveDelta：kind+qty 与带符号 delta 两种入参等价', () => {
    expect(resolveDelta({ kind: 'in', qty: 20 })).toEqual({ ok: true, delta: 20, kind: 'in' });
    expect(resolveDelta({ kind: 'out', qty: 20 })).toEqual({ ok: true, delta: -20, kind: 'out' });
    expect(resolveDelta({ delta: 20 })).toEqual({ ok: true, delta: 20, kind: 'in' });
    expect(resolveDelta({ delta: -20 })).toEqual({ ok: true, delta: -20, kind: 'out' });
    expect(resolveDelta({ delta: 0 }).ok).toBe(false);
    expect(resolveDelta({}).ok).toBe(false);
  });
});
