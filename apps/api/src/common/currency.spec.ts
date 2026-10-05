import { currencyLabel, isCanonicalCurrency, normalizeCurrency } from './currency';

/**
 * 币种归一单测（I17 甲方裁定 2026-10-05）
 * ------------------------------------------------------------------
 * 裁定：「币种统一归一为 CNY：识别到的 RMB / RMB¥ / ￥ / ¥ / 人民币 等一律归一到 CNY
 * 存储与展示（写入前归一，加单测）。」
 * 本文件覆盖：人民币家族全写法、美元家族全写法、空值/未识别、大小写与全角符号、展示标签。
 */
describe('normalizeCurrency（币种归一为 CNY）', () => {
  it('人民币家族的全部写法 → CNY', () => {
    const cases = [
      'CNY', 'cny', 'Cny', 'RMB', 'rmb', 'Rmb', 'RMB¥', 'rmb¥', 'RMB￥',
      '￥', '¥', '￥ ', ' ¥', '人民币', '人民幣', '元', '圆', '塊', '块',
      '人民币（CNY）', '单价/¥',
    ];
    for (const c of cases) expect([c, normalizeCurrency(c)]).toEqual([c, 'CNY']);
  });

  it('美元家族的写法 → USD', () => {
    for (const c of ['USD', 'usd', 'Usd', '美元', '美金', 'US$', 'usd$', '$', '$5.00']) {
      expect([c, normalizeCurrency(c)]).toEqual([c, 'USD']);
    }
  });

  it('空值 / 未识别 → CNY（不编造外币）', () => {
    expect(normalizeCurrency(undefined)).toBe('CNY');
    expect(normalizeCurrency(null)).toBe('CNY');
    expect(normalizeCurrency('')).toBe('CNY');
    expect(normalizeCurrency('   ')).toBe('CNY');
    expect(normalizeCurrency('不知道是什么币')).toBe('CNY');
  });

  it('美元优先于人民币符号判定：含 $ 的串按 USD', () => {
    expect(normalizeCurrency('US$')).toBe('USD');
    expect(normalizeCurrency('us dollar')).toBe('USD');
    expect(normalizeCurrency('usdollar')).toBe('USD');
  });

  it('isCanonicalCurrency / currencyLabel', () => {
    expect(isCanonicalCurrency('CNY')).toBe(true);
    expect(isCanonicalCurrency('cny')).toBe(true);
    expect(isCanonicalCurrency('USD')).toBe(true);
    expect(isCanonicalCurrency('RMB')).toBe(false);
    expect(currencyLabel('RMB')).toBe('CNY');
    expect(currencyLabel('美元')).toBe('USD');
  });
});
