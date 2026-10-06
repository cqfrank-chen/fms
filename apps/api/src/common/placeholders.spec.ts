import { PENDING_CUSTOMER_NAME, PENDING_PRODUCT_NAME, PRODUCT_TYPE_LABELS, PRODUCT_TYPES, isPendingEntityName } from '../db/schema';
import { hiddenCustomerIdForOrders, hidePlaceholders, includePlaceholders } from './placeholders';

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

/**
 * 订单列表隐藏口径（甲方裁定 2026-10-05 · 收窄为「只看客户」）
 * ------------------------------------------------------------------
 * 现状（改前）：默认隐藏「客户是占位 或 任一产品行是占位」——云端 853 单只显示 561。
 * 改后：默认只隐藏「客户是占位档案」；产品行挂占位产品的订单照常显示（界面加醒目标记）。
 * 这里覆盖判定纯函数 hiddenCustomerIdForOrders —— 服务端 findAll 直接消费它的返回值。
 */
describe('订单列表隐藏口径「只看客户」（改后）', () => {
  const PH_CUSTOMER_ID = 9001;

  it('默认：只排除占位客户（返回其 id），产品行是否占位不参与判定', () => {
    expect(hiddenCustomerIdForOrders(undefined, false, PH_CUSTOMER_ID)).toBe(PH_CUSTOMER_ID);
    for (const v of ['', '0', 'false', 'no', null]) {
      expect(hiddenCustomerIdForOrders(v, false, PH_CUSTOMER_ID)).toBe(PH_CUSTOMER_ID);
    }
  });

  it('includePlaceholders=1（显示占位客户档案开关）→ 不隐藏任何单据', () => {
    expect(hiddenCustomerIdForOrders('1', false, PH_CUSTOMER_ID)).toBeNull();
    expect(hiddenCustomerIdForOrders('true', false, PH_CUSTOMER_ID)).toBeNull();
    expect(hiddenCustomerIdForOrders(true, false, PH_CUSTOMER_ID)).toBeNull();
  });

  it('hasPending=1（仅看有未补全项的草稿单）→ 不隐藏任何单据（补全工作流不受开关限制）', () => {
    expect(hiddenCustomerIdForOrders(undefined, true, PH_CUSTOMER_ID)).toBeNull();
    expect(hiddenCustomerIdForOrders('0', true, PH_CUSTOMER_ID)).toBeNull();
  });

  it('占位客户档案不存在（库里还没惰性创建）→ 无单可藏', () => {
    expect(hiddenCustomerIdForOrders(undefined, false, null)).toBeNull();
    expect(hiddenCustomerIdForOrders(undefined, false, undefined)).toBeNull();
  });

  it('口径不含产品：删除「产品行占位」条件后，判定结果与产品无关（同入参恒等）', () => {
    // 旧口径会因「任一产品行是占位产品」而隐藏；新口径下该因素**完全不进判定**，
    // 因此对同一个 pendingCustomerId，无论订单里有几行占位产品，结果都一致。
    const ids = [hiddenCustomerIdForOrders('0', false, PH_CUSTOMER_ID)];
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(PH_CUSTOMER_ID);
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
