import { OrderParserService } from './order-parser.service';
import type { QuotesService } from '../quotes/quotes.service';
import type { PriceHit } from '../quotes/quote-pricing';

/**
 * 识单 × 报价记录联动单元测试（I17，不连数据库）
 * ------------------------------------------------------------------
 * 口径：识单解析时，若某行**缺 unitPrice** → 用取价规则按「文件夹客户 + 该行产品」查报价 →
 * 命中则补价并标注 priceFrom='quote'（来源可追溯）；未命中则保持缺价并标待补。
 * 向后兼容：不传报价信息（无命中 / quotePricing:false）时行为与改造前完全一致。
 */

/** 假产品档案：测试可临时增删（jest.mock 工厂里引用的变量必须以 mock 开头） */
const mockProducts: Array<{ id: number; name: string }> = [
  { id: 22, name: '1-101 割嘴 00#' },
  { id: 44, name: '0-GPN' },
  { id: 55, name: '00-GPN' },
];
const mockProductsDefault = mockProducts.slice();

jest.mock('../db', () => {
  const schema = jest.requireActual('../db/schema');
  const customers = [{ id: 11, name: '安宝公司' }];
  return {
    db: {
      select: () => ({
        from: (table: unknown) => Promise.resolve(table === schema.customers ? customers : mockProducts),
      }),
    },
  };
});

afterEach(() => {
  mockProducts.length = 0;
  mockProducts.push(...mockProductsDefault);
});

const llm = { hasChatKey: async () => false, chat: async () => ({ text: '{}' }) } as never;

/** 假报价服务：按「产品名」命中一条报价（模拟 quotes.service.lookupMany 的返回形状） */
function fakeQuotes(hit: PriceHit | null): QuotesService {
  return { lookupMany: async (qs: unknown[]) => qs.map(() => hit) } as unknown as QuotesService;
}

const hitOf = (cents: number, rule: PriceHit['rule'] = 'customer_product'): PriceHit => ({
  quoteId: 66,
  rule,
  ruleText: rule === 'customer_product' ? '客户+产品' : '客户+产品名文本',
  unitPriceCents: cents,
  currency: 'CNY',
  validFrom: '2026-01-01',
  validTo: null,
  source: 'manual',
  productName: '1-101 割嘴 00#',
  remark: null,
});

/** 一份最简表格：表头 + 一行（数量有值、单价列为空 —— 正是「缺价待补」的形态） */
const tableRows = [
  ['产品名称', '数量', '单价'],
  ['1-101 割嘴 00#', '200', ''],
];

describe('① 缺价行按报价记录补价', () => {
  it('命中报价 → 补价 + priceFrom=quote + 来源可追溯（notes 记报价单号）', async () => {
    const svc = new OrderParserService(llm, fakeQuotes(hitOf(605)));
    const r = await svc.parseAndResolve({
      table: { rows: tableRows, source: 'csv' },
      folderCustomer: '安宝公司',
    });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].unitPrice).toBe(6.05);
    expect(r.lines[0].priceFrom).toBe('quote');
    expect(r.lines[0].quoteId).toBe(66);
    expect(r.lines[0].quoteRule).toBe('customer_product');
    expect(r.quoteFilledCount).toBe(1);
    // 行金额按「分」定点：200 × 6.05 元 = 1210 元 = 121000 分
    expect(r.lines[0].amountCents).toBe(121000);
    expect(r.totalCents).toBe(121000);
    // 缺价 error 已被补价消除，且 notes 里能回溯到具体报价
    expect(r.lines[0].issues.some((i) => i.path.endsWith('.unitPrice'))).toBe(false);
    expect(r.notes.some((n) => n.includes('报价记录 #66'))).toBe(true);
  });

  it('未命中报价 → 保持缺价（仍标 unitPrice error，不编造价格）+ quoteFilledCount=0', async () => {
    const svc = new OrderParserService(llm, fakeQuotes(null));
    const r = await svc.parseAndResolve({ table: { rows: tableRows, source: 'csv' }, folderCustomer: '安宝公司' });
    expect(r.lines[0].unitPrice).toBeUndefined();
    expect(r.lines[0].priceFrom).toBeUndefined();
    expect(r.quoteFilledCount).toBe(0);
    expect(r.lines[0].amountCents).toBe(0);
    const issue = r.lines[0].issues.find((i) => i.path.endsWith('.unitPrice'));
    expect(issue?.level).toBe('error');
    expect(issue?.message).toContain('未识别到单价');
  });

  it('不传报价信息（无 QuotesService）→ 行为与改造前完全一致（向后兼容）', async () => {
    const svc = new OrderParserService(llm);
    const r = await svc.parseAndResolve({ table: { rows: tableRows, source: 'csv' }, folderCustomer: '安宝公司' });
    expect(r.lines[0].unitPrice).toBeUndefined();
    expect(r.quoteFilledCount).toBe(0);
    expect(r.lines[0].issues.some((i) => i.message.includes('未识别到单价'))).toBe(true);
  });

  it('quotePricing:false → 显式关闭补价（离线复现旧口径）', async () => {
    const svc = new OrderParserService(llm, fakeQuotes(hitOf(605)));
    const r = await svc.parseAndResolve({
      table: { rows: tableRows, source: 'csv' }, folderCustomer: '安宝公司', quotePricing: false,
    });
    expect(r.lines[0].unitPrice).toBeUndefined();
    expect(r.quoteFilledCount).toBe(0);
  });

  it('单据自带单价的行**不会**被报价覆盖（报价只用于补缺，不改原始价）', async () => {
    const svc = new OrderParserService(llm, fakeQuotes(hitOf(605)));
    const r = await svc.parseAndResolve({
      table: { rows: [['产品名称', '数量', '单价'], ['1-101 割嘴 00#', '100', '9.90']], source: 'csv' },
      folderCustomer: '安宝公司',
    });
    expect(r.lines[0].unitPrice).toBe(9.9);
    expect(r.lines[0].priceFrom).toBeUndefined();
    expect(r.quoteFilledCount).toBe(0);
  });

  it('报价服务抛错时不阻断识单：如实告警 + 保持缺价待补', async () => {
    const bad = { lookupMany: async () => { throw new Error('模拟取价故障'); } } as unknown as QuotesService;
    const svc = new OrderParserService(llm, bad);
    const r = await svc.parseAndResolve({ table: { rows: tableRows, source: 'csv' }, folderCustomer: '安宝公司' });
    expect(r.lines[0].unitPrice).toBeUndefined();
    expect(r.notes.some((n) => n.includes('报价取价失败'))).toBe(true);
    expect(r.lines[0].issues.some((i) => i.message.includes('未识别到单价'))).toBe(true);
  });
});

describe('② 产品名与档案的子串容错**必须带数字守卫**（甲方更正：不同尺寸 = 不同产品）', () => {
  // 旧行为：normName 子串匹配（'1-101割嘴00#'.includes('1-101')）会把计划单的「1-101」
  // 错配到档案「1-101 割嘴 00#」——那是**另一个尺寸**，价格/工艺都会跟错。
  // 新口径：子串容错保留（描述/品牌前缀差异仍可命中），但要求数字指纹逐字符一致。
  const oneRow = (name: string) => [['产品名称', '数量', '单价'], [name, '100', '']];

  it('计划单写「1-101」、档案只有「1-101 割嘴 00#」→ **不再错配**（productId 为空 + 明确提示）', async () => {
    mockProducts.length = 0;
    mockProducts.push({ id: 22, name: '1-101 割嘴 00#' });
    const svc = new OrderParserService(llm);
    const r = await svc.parseAndResolve({ table: { rows: oneRow('1-101'), source: 'csv' }, folderCustomer: '安宝公司' });
    expect(r.lines[0].productId ?? null).toBeNull();
    expect(r.lines[0].issues.some((i) => i.message.includes('不在目录中'))).toBe(true);
  });

  it('描述后缀差异（数字一致）仍然命中：档案「1-101 割嘴 00#」↔ 单据「1-101 割嘴 00# 特价」', async () => {
    mockProducts.length = 0;
    mockProducts.push({ id: 22, name: '1-101 割嘴 00#' });
    const svc = new OrderParserService(llm);
    const r = await svc.parseAndResolve({ table: { rows: oneRow('1-101 割嘴 00# 特价'), source: 'csv' }, folderCustomer: '安宝公司' });
    expect(r.lines[0].productId).toBe(22);
  });

  it('品牌前缀差异（数字一致）仍然命中：档案「Victor 乙炔割嘴 1-1-101」↔ 单据「Victor 乙炔割嘴 1-1-101 中性包装」', async () => {
    mockProducts.length = 0;
    mockProducts.push({ id: 77, name: 'Victor 乙炔割嘴 1-1-101' });
    const svc = new OrderParserService(llm);
    const r = await svc.parseAndResolve({ table: { rows: oneRow('Victor 乙炔割嘴 1-1-101 中性包装'), source: 'csv' }, folderCustomer: '安宝公司' });
    expect(r.lines[0].productId).toBe(77);
  });

  it('0-GPN 与 00-GPN 各自命中自己的档案（不互相错配）', async () => {
    const svc = new OrderParserService(llm);
    const g0 = await svc.parseAndResolve({ table: { rows: oneRow('0-GPN'), source: 'csv' }, folderCustomer: '安宝公司' });
    expect(g0.lines[0].productId).toBe(44);
    const g00 = await svc.parseAndResolve({ table: { rows: oneRow('00-GPN'), source: 'csv' }, folderCustomer: '安宝公司' });
    expect(g00.lines[0].productId).toBe(55);
  });
});

describe('③ 客户由文件夹决定（与报价补价协同）', () => {
  it('folderCustomer 决定客户名，补价用的客户即该文件夹客户', async () => {
    const captured: Array<{ customerId: number | null; productName: string | null }> = [];
    const spy = {
      lookupMany: async (qs: Array<{ customerId: number | null; productName: string | null }>) => {
        captured.push(...qs);
        return qs.map(() => hitOf(605, 'customer_name'));
      },
    } as unknown as QuotesService;
    const svc = new OrderParserService(llm, spy);
    const r = await svc.parseAndResolve({ table: { rows: tableRows, source: 'csv' }, folderCustomer: '安宝公司' });
    expect(r.customerName).toBe('安宝公司');
    expect(captured).toHaveLength(1);
    expect(captured[0].customerId).toBe(11); // 文件夹客户命中档案后的 id
    expect(captured[0].productName).toBe('1-101 割嘴 00#');
  });
});
