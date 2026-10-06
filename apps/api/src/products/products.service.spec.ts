import { seriesLikePattern } from './products.service';

/**
 * 产品列表筛选口径的单测（不连库）：
 * 甲方 2026 规则 —— **系列筛选改为包含匹配**（?series=AMERICAN 必须命中 'AMERICAN STYLE CUTTING TIP'）。
 */
describe('seriesLikePattern（系列筛选 = 包含匹配）', () => {
  it('简称 AMERICAN 命中目录全称', () => {
    expect(seriesLikePattern('AMERICAN')).toBe('%AMERICAN%');
    expect('AMERICAN STYLE CUTTING TIP'.includes('AMERICAN')).toBe(true);
  });

  it('目录全称、部分词、大小写混合都放行（匹配交给 SQL 的 ilike）', () => {
    expect(seriesLikePattern('STYLE CUTTING')).toBe('%STYLE CUTTING%');
    expect(seriesLikePattern('  japanese  ')).toBe('%japanese%');
  });

  it('空 / 空白 → null（= 不筛，保持既有行为）', () => {
    expect(seriesLikePattern(undefined)).toBeNull();
    expect(seriesLikePattern('')).toBeNull();
    expect(seriesLikePattern('   ')).toBeNull();
  });

  it('转义 SQL 通配符，避免把用户输入当成模式（% 与 _ 不当通配符用）', () => {
    expect(seriesLikePattern('A%B')).toBe('%A\\%B%');
    expect(seriesLikePattern('A_B')).toBe('%A\\_B%');
  });
});
