import { PENDING_CUSTOMER_NAME, PENDING_PRODUCT_NAME, PRODUCT_TYPE_LABELS, PRODUCT_TYPES, isPendingEntityName } from '../db/schema';
import { hidePlaceholders, includePlaceholders } from './placeholders';

/**
 * 占位档案「默认隐藏 + 开关显示」与「占位产品类型为待定」单测
 * ------------------------------------------------------------------
 * 甲方裁定（2026-10-05）：
 *   ② 占位档案（未建档客户·待补 / 未建档产品·待补）在前端列表默认隐藏，提供「显示占位档案」开关；
 *   ③ 占位产品的类型字段改为中立「待定」（枚举新增 tbd），不再借用 uk_acetylene。
 */
describe('占位档案默认隐藏（裁定②）', () => {
  const rows = [
    { id: 1, name: '安宝公司' },
    { id: 2, name: PENDING_CUSTOMER_NAME },
    { id: 3, name: '嵊州海田' },
    { id: 4, name: PENDING_PRODUCT_NAME },
  ];

  it('默认（不传参数）隐藏两个占位档案', () => {
    const out = hidePlaceholders(rows);
    expect(out.map((r) => r.id)).toEqual([1, 3]);
    expect(out.some((r) => isPendingEntityName(r.name))).toBe(false);
  });

  it('includePlaceholders=1 / true 时显示（排查用）', () => {
    expect(hidePlaceholders(rows, '1').map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(hidePlaceholders(rows, 'true')).toHaveLength(4);
    expect(hidePlaceholders(rows, true)).toHaveLength(4);
    expect(includePlaceholders('on')).toBe(true);
    expect(includePlaceholders('yes')).toBe(true);
  });

  it('其它取值（0/false/空/乱填）仍按隐藏处理', () => {
    for (const v of ['0', 'false', '', 'no', 'whatever', null, undefined] as const) {
      expect(hidePlaceholders(rows, v as string).map((r) => r.id)).toEqual([1, 3]);
    }
  });

  it('占位档案名判定：只有两个精确名字算占位档案（避免误伤真实客户）', () => {
    expect(isPendingEntityName(PENDING_CUSTOMER_NAME)).toBe(true);
    expect(isPendingEntityName(' ' + PENDING_CUSTOMER_NAME + ' ')).toBe(true);
    expect(isPendingEntityName(PENDING_PRODUCT_NAME)).toBe(true);
    expect(isPendingEntityName('安宝公司')).toBe(false);
    expect(isPendingEntityName('未建档客户')).toBe(false);
    expect(isPendingEntityName(null)).toBe(false);
    expect(isPendingEntityName(undefined)).toBe(false);
  });
});

describe('占位产品类型为中立「待定」（裁定③）', () => {
  it('枚举新增 tbd，且不与四种业务类型混淆', () => {
    expect(PRODUCT_TYPES).toContain('tbd');
    expect(PRODUCT_TYPES).toHaveLength(5); // 迁移只新增：原 4 种 + tbd
    expect(PRODUCT_TYPES.filter((t) => t === 'tbd')).toHaveLength(1);
  });

  it('tbd 的中文标签是「待定」', () => {
    expect(PRODUCT_TYPE_LABELS.tbd).toBe('待定');
    expect(PRODUCT_TYPE_LABELS.uk_acetylene).toBe('英式乙炔');
  });
});
