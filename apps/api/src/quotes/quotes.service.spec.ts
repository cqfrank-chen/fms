import { BadRequestException, NotFoundException } from '@nestjs/common';
import { runWithOperator } from '../common/operator-context';
import { TableParserService } from '../ai/table-parser.service';
import { QuotesService } from './quotes.service';

/**
 * 报价记录服务单元测试（不连数据库）：**改价留痕** / 停用启用 / 入参校验。
 * db 用内存假实现（只覆盖本服务用到的最小接口：select / update）。
 */

jest.mock('../db', () => {
  const schema = jest.requireActual('../db/schema');
  type Row = Record<string, any>;
  const state = { rows: [] as Row[], updates: [] as Array<Record<string, any>> };

  /** 取 where(eq(col, id)) 里的 id（drizzle 的 Param.value） */
  const whereId = (cond: unknown): number | undefined => {
    const chunks = (cond as { queryChunks?: unknown[] })?.queryChunks ?? [];
    for (const c of chunks) {
      if (c && typeof c === 'object' && typeof (c as { value?: unknown }).value === 'number') return (c as { value: number }).value;
    }
    return undefined;
  };

  const q = (rows: Row[], filterable = false) => {
    let cur = rows;
    const o: any = {
      leftJoin: () => o,
      where: (cond: unknown) => {
        const id = whereId(cond);
        if (filterable && id !== undefined) cur = cur.filter((r) => r.id === id);
        return o;
      },
      orderBy: () => o,
      limit: () => o,
      offset: () => o,
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(cur).then(res, rej),
    };
    return o;
  };

  return {
    db: {
      // 有投影 = findOne 形态（{q, customerName, ...}）；无投影 = requireRow 形态（整行，按 id 过滤）
      select: (proj?: unknown) => ({
        from: (table: unknown) => {
          if (table !== schema.productQuotes) return q([]);
          return proj
            ? q(state.rows.map((r) => ({ q: { ...r }, customerName: null, productCatalogName: null, operatorName: null })))
            : q(state.rows.map((r) => ({ ...r })), true);
        },
      }),
      update: (table: unknown) => ({
        set: (patch: Record<string, any>) => ({
          where: (cond: unknown) => {
            if (table !== schema.productQuotes) return Promise.resolve();
            state.updates.push({ ...patch });
            const row = state.rows.find((r) => r.id === whereId(cond));
            if (row) Object.assign(row, patch);
            return Promise.resolve();
          },
        }),
      }),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) }),
      transaction: (fn: (tx: unknown) => unknown) => fn({ select: () => ({ from: () => q([]) }), update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) }),
    },
    __state: state,
  };
});

const dbMock = jest.requireMock('../db') as { __state: { rows: Array<Record<string, any>>; updates: Array<Record<string, any>> } };

const seed = () => {
  dbMock.__state.rows.length = 0;
  dbMock.__state.updates.length = 0;
  dbMock.__state.rows.push({
    id: 66,
    customerId: 7,
    productId: 22,
    productName: '1-101 割嘴 00#',
    unitPriceCents: 968,
    currency: 'CNY',
    validFrom: '2026-01-01',
    validTo: null,
    source: 'manual',
    sourceFile: null,
    remark: null,
    enabled: true,
    operatorId: 3,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
};

const svc = () => new QuotesService(new TableParserService());

describe('① 改价（PUT /api/quotes/:id/price）：只改价 + 写 updated_at/operator 留痕', () => {
  it('改价写入新单价（分）、刷新 updated_at、记下当前操作人', async () => {
    seed();
    const before = new Date('2026-01-01T00:00:00Z');
    const t0 = Date.now();
    const row = await runWithOperator(9, () => svc().changePrice(66, { unitPrice: 13.2 }));

    expect(dbMock.__state.updates).toHaveLength(1);
    const patch = dbMock.__state.updates[0];
    expect(patch.unitPriceCents).toBe(1320); // 13.20 元 → 1320 分（金额一律走「分」）
    expect(patch.updatedAt).toBeInstanceOf(Date);
    expect((patch.updatedAt as Date).getTime()).toBeGreaterThanOrEqual(t0);
    expect(patch.operatorId).toBe(9);
    // 改价后的读回结果：价格已变、updated_at 已刷新、原 createdAt 不变（历史行保留）
    expect(row.unitPriceCents).toBe(1320);
    expect(row.unitPrice).toBe(13.2);
    expect(row.updatedAt.getTime()).toBeGreaterThan(before.getTime());
    expect(row.createdAt.getTime()).toBe(before.getTime());
  });

  it('未绑定操作人时沿用原 operator_id（不写 null 覆盖留痕）', async () => {
    seed();
    await svc().changePrice(66, { unitPriceCents: 500 });
    expect(dbMock.__state.updates[0].operatorId).toBe(3);
  });

  it('改价可同时改有效期与备注；失效日早于生效日 → 400 中文提示', async () => {
    seed();
    await svc().changePrice(66, { unitPrice: 5, validFrom: '2026-03-01', validTo: '2026-03-31', remark: '旺季调价' });
    const patch = dbMock.__state.updates[0];
    expect(patch.validFrom).toBe('2026-03-01');
    expect(patch.validTo).toBe('2026-03-31');
    expect(patch.remark).toBe('旺季调价');

    seed();
    await expect(svc().changePrice(66, { unitPrice: 5, validFrom: '2026-03-31', validTo: '2026-03-01' }))
      .rejects.toThrow(new BadRequestException('失效日期（2026-03-01）不能早于生效日期（2026-03-31）'));
  });

  it('不给新单价 → 400；不存在的报价 → 404', async () => {
    seed();
    await expect(svc().changePrice(66, { remark: '只改备注' })).rejects.toThrow(BadRequestException);
    await expect(svc().changePrice(999, { unitPrice: 1 })).rejects.toThrow(NotFoundException);
  });
});

describe('② 停用 / 启用：不物理删除，只翻 enabled + 留痕', () => {
  it('停用写 enabled=false 并刷新 updated_at', async () => {
    seed();
    const row = await runWithOperator(4, () => svc().setEnabled(66, false));
    const patch = dbMock.__state.updates[0];
    expect(patch.enabled).toBe(false);
    expect(patch.operatorId).toBe(4);
    expect(row.enabled).toBe(false);
    expect(row.effective).toBe(false);
  });
});
