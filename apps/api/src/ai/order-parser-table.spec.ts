import { OrderParserService } from './order-parser.service';

/**
 * 两级字段映射的分支测试（单元级，不连数据库、不连网络）：
 *   · 表头规则映射命中齐全 → 直接出结果，**绝不调用 LLM**（确定性优先）
 *   · 命中率不足（缺客户列等）→ 把表格紧凑文本 + 上下文线索交给 LLM 做语义映射（严格 JSON）
 *   · LLM 输出不可用 → 回退规则映射并给出中文提示
 *   · 图片分支回归：仍然调用既有 vision 通道，不受表格改动影响
 *
 * db 用假实现：resolve() 的主数据匹配只读 customers / products 两张表。
 */
jest.mock('../db', () => {
  const schema = jest.requireActual('../db/schema');
  const customers = [{ id: 11, name: '杭州测试客户' }];
  const products = [{ id: 22, name: 'ANM 3' }, { id: 23, name: 'PNM 1/32' }];
  return {
    db: {
      select: () => ({
        from: (table: unknown) => Promise.resolve(table === schema.customers ? customers : products),
      }),
    },
  };
});

/** 交期必须晚于今天，否则 resolve() 会按「交期早于今天」记 error（测试与运行日期解耦） */
const FUTURE = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

/** 造一个「规则映射齐全」的表格矩阵 */
function fullTable(): string[][] {
  return [
    ['客户名称', '产品', '数量', '单价', '交期'],
    ['杭州测试客户', 'ANM 3', '2000', '4.20', FUTURE],
    ['杭州测试客户', 'PNM 1/32', '500', '3.80', FUTURE],
  ];
}

function makeService() {
  const llm = {
    chat: jest.fn(),
    vision: jest.fn(),
    hasChatKey: jest.fn().mockResolvedValue(true),
  };
  const svc = new OrderParserService(llm as never);
  return { svc, llm };
}

describe('OrderParserService · 表格两级字段映射', () => {
  it('表头规则映射命中 4/4 → 不调用 LLM，直接出「一张订单 + 多行明细」', async () => {
    const { svc, llm } = makeService();
    const r = await svc.parseAndResolve({ table: { rows: fullTable(), source: 'excel' } });

    expect(llm.chat).not.toHaveBeenCalled();
    expect(r.parseSource).toBe('table-rule');
    expect(r.table?.usedLlm).toBe(false);
    expect(r.table?.requiredHits).toBe(4);
    expect(r.customerId).toBe(11);
    expect(r.customerName).toBe('杭州测试客户');
    expect(r.dueDate).toBe(FUTURE);
    expect(r.lines.length).toBe(2);
    // 数量和单价
    expect(r.lines[0].quantity).toBe(2000);
    expect(r.lines[0].unitPrice).toBe(4.2);
    expect(r.lines[0].productId).toBe(22);
    expect(r.lines[1].quantity).toBe(500);
    expect(r.lines[1].unitPrice).toBe(3.8);
    expect(r.lines[1].productId).toBe(23);
    // 金额一律「分」：2000×4.20 = 840000 分；500×3.80 = 190000 分；合计 1030000 分
    expect(r.lines[0].amountCents).toBe(840000);
    expect(r.lines[1].amountCents).toBe(190000);
    expect(r.totalCents).toBe(1030000);
    expect(r.directPass).toBe(true);
  });

  it('缺客户列（命中 3/4）→ 走 LLM 语义映射，严格 JSON，与图片识别同结构', async () => {
    const { svc, llm } = makeService();
    llm.chat.mockResolvedValue({
      provider: 'deepseek',
      text: JSON.stringify({
        customerName: '杭州测试客户',
        poNo: 'PO-2026-0001',
        dueDate: FUTURE,
        confidence: 'high',
        notes: [],
        lines: [
          { productName: 'ANM 3', quantity: 1200, unitPrice: 4.25, currency: 'RMB' },
          { productName: 'PNM 1/32', quantity: 300, unitPrice: 3.9, currency: 'RMB' },
        ],
      }),
    });

    const rows = [
      ['产品', '数量', '单价'],
      ['ANM 3', '1,200', '4.25'],
      ['PNM 1/32', '300', '3.9'],
    ];
    const r = await svc.parseAndResolve({ table: { rows, source: 'csv' }, hint: '客户：杭州测试客户' });

    expect(llm.chat).toHaveBeenCalledTimes(1);
    const [messages, opts] = llm.chat.mock.calls[0];
    expect(opts).toEqual({ json: true }); // 强制 JSON 输出，源头消灭格式幻觉
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('"lines"');
    expect(messages[0].content).toContain('"customerName"');
    expect(messages[1].content).toContain('R1| 产品 | 数量 | 单价'); // 表格紧凑文本
    expect(messages[1].content).toContain('客户：杭州测试客户'); // 上下文线索

    expect(r.parseSource).toBe('table-llm');
    expect(r.table?.usedLlm).toBe(true);
    expect(r.table?.missingRequired).toContain('customer');
    expect(r.customerId).toBe(11); // LLM 抽出的客户名仍要过确定性主数据匹配
    expect(r.poNo).toBe('PO-2026-0001');
    expect(r.lines.length).toBe(2);
    expect(r.lines[0].quantity).toBe(1200);
    expect(r.lines[0].unitPrice).toBe(4.25);
    expect(r.totalCents).toBe(1200 * 425 + 300 * 390);
  });

  it('LLM 输出不可解析 → 回退规则映射并给出中文提示（不丢识别结果）', async () => {
    const { svc, llm } = makeService();
    llm.chat.mockResolvedValue({ provider: 'deepseek', text: '抱歉，我看不清这张表' });
    const r = await svc.parseAndResolve({ table: { rows: [['产品', '数量', '单价'], ['ANM 3', '10', '2.5']] } });
    expect(r.parseSource).toBe('table-llm');
    expect(r.lines.length).toBe(1);
    expect(r.lines[0].productName).toBe('ANM 3');
    expect(r.notes.join('；')).toContain('回退表头规则映射');
  });

  it('图片分支回归：仍走既有 vision 通道（parseSource=image，不碰 chat）', async () => {
    const { svc, llm } = makeService();
    llm.vision.mockResolvedValue({
      provider: 'deepseek',
      text: JSON.stringify({
        customerName: '杭州测试客户',
        dueDate: '2026-10-15',
        confidence: 'high',
        notes: [],
        lines: [{ productName: 'ANM 3', quantity: 800, unitPrice: 4.1, currency: 'RMB' }],
      }),
    });
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const r = await svc.parseAndResolve({ image: dataUrl });

    expect(llm.vision).toHaveBeenCalledTimes(1);
    expect(llm.vision.mock.calls[0][0]).toEqual([dataUrl]);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(r.parseSource).toBe('image');
    expect(r.lines[0].quantity).toBe(800);
    expect(r.lines[0].amountCents).toBe(800 * 410);
  });

  it('文本分支回归：parseSource=text，金额同样按分累计', async () => {
    const { svc, llm } = makeService();
    llm.chat.mockResolvedValue({
      provider: 'deepseek',
      text: JSON.stringify({
        customerName: '杭州测试客户',
        dueDate: '2026-10-01',
        confidence: 'high',
        notes: [],
        lines: [{ productName: 'ANM 3', quantity: 3, unitPrice: 0.1, currency: 'RMB' }],
      }),
    });
    const r = await svc.parseAndResolve({ text: '客户：杭州测试客户 ANM 3 x3 @0.1' });
    expect(r.parseSource).toBe('text');
    expect(r.totalCents).toBe(30); // 3 × 10 分 = 30 分（定点，无 0.30000000000000004）
  });
});
