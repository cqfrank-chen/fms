import { BadRequestException } from '@nestjs/common';
import * as XLSX from '@e965/xlsx';
import * as ExcelJS from 'exceljs';
import { TableParserService } from '../ai/table-parser.service';
import { MasterImportService } from './master-import.service';

/**
 * 主数据批量导入单元测试（不连数据库/网络）：
 * 表头别名映射、必填列校验、脏数据逐行分类、按名称/型号去重（仅新增 vs 新增或更新）、
 * commit 写入统计与单行失败隔离、模板内容、.xls/.csv 解析复用。
 * db 用内存假实现（只覆盖本服务用到的最小接口）。
 */
jest.mock('../db', () => {
  const schema = jest.requireActual('../db/schema');
  type Row = Record<string, unknown> & { id: number };
  const state = { customers: [] as Row[], products: [] as Row[], seq: 1, failOnInsertName: '' };
  const rowsOf = (t: unknown): Row[] => (t === schema.customers ? state.customers : t === schema.products ? state.products : []);
  /** 从 drizzle 的 where 条件里取出 id（eq(col, id) 的 Param.value） */
  const whereId = (cond: unknown): number | undefined => {
    const chunks = (cond as { queryChunks?: unknown[] })?.queryChunks ?? [];
    for (const c of chunks) {
      if (c && typeof c === 'object' && typeof (c as { value?: unknown }).value === 'number') return (c as { value: number }).value;
    }
    return undefined;
  };
  const select = () => ({ from: (t: unknown) => Promise.resolve(rowsOf(t).map((r) => ({ ...r }))) });
  const makeTx = () => ({
    select,
    insert: (t: unknown) => ({
      values: (v: Record<string, unknown>) => ({
        returning: (): Promise<Array<{ id: number }>> => {
          if (state.failOnInsertName && String(v.name).includes(state.failOnInsertName)) throw new Error('模拟写库失败');
          const row = { id: state.seq++, ...v } as Row;
          rowsOf(t).push(row);
          return Promise.resolve([{ id: row.id }]);
        },
      }),
    }),
    update: (t: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (cond: unknown): Promise<void> => {
          const row = rowsOf(t).find((r) => r.id === whereId(cond));
          if (row) Object.assign(row, patch);
          return Promise.resolve();
        },
      }),
    }),
  });
  return {
    __db: {
      state,
      reset: () => { state.customers = []; state.products = []; state.seq = 1; state.failOnInsertName = ''; },
      seed: (table: 'customers' | 'products', row: Record<string, unknown>) => {
        state[table].push({ id: state.seq++, ...row } as Row);
      },
    },
    db: {
      select,
      transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(makeTx()),
      insert: (t: unknown) => makeTx().insert(t),
    },
  };
});

const { __db } = jest.requireMock('../db') as {
  __db: { state: { customers: Array<Record<string, unknown>>; products: Array<Record<string, unknown>>; failOnInsertName: string }; reset: () => void; seed: (t: 'customers' | 'products', row: Record<string, unknown>) => void };
};

const svc = () => new MasterImportService(new TableParserService());

/** 造 .xlsx */
async function xlsxBuffer(aoa: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('导入');
  for (const r of aoa) ws.addRow(r as never);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 造 .xls（BIFF8） */
function xlsBuffer(aoa: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa as never), '导入');
  return Buffer.from(XLSX.write(wb, { bookType: 'biff8', type: 'buffer', cellDates: true }) as ArrayBuffer);
}

/** 造 CSV（UTF-8） */
function csvBuffer(rows: Array<Array<string | number>>): Buffer {
  return Buffer.from(rows.map((r) => r.join(',')).join('\r\n'), 'utf8');
}

beforeEach(() => __db.reset());

describe('MasterImportService · 表头别名映射与必填校验', () => {
  it('客户表头别名（客户简称/联系人/结算方式/账期）→ 列位与取值正确', async () => {
    const rows = await svc().preview({
      target: 'customers',
      buffer: await xlsxBuffer([
        ['客户简称', '联系人', '结算方式', '账期'],
        ['Weldclass', 'John', '30%定金+70%发货前', 30],
        ['桐乡五金城', '王经理', '月结30天', '60'],
      ]),
      fileName: '客户.xlsx',
    });
    expect(rows.columns).toEqual({ name: 0, contact: 1, settlement: 2, creditDays: 3 });
    expect(rows.summary).toEqual({ total: 2, new: 2, update: 0, skip: 0, error: 0 });
    expect(rows.rows[0].data).toEqual({ name: 'Weldclass', contact: 'John', settlement: 'deposit_30_balance_before_ship', creditDays: 30 });
    expect(rows.rows[1].data.settlement).toBe('monthly_30');
  });

  it('产品表头别名（品名/类型/默认包装/安全库存）→ 词表值归一', async () => {
    const rows = await svc().preview({
      target: 'products',
      buffer: await xlsxBuffer([
        ['品名', '产品类型', '默认包装', '安全库存'],
        ['ANM 1/32 乙炔', '英式乙炔', '包装盒×50', 100],
        ['6290 美式乙炔', '美式乙炔', '', ''],
      ]),
      fileName: '产品.xlsx',
    });
    expect(rows.columns).toEqual({ name: 0, type: 1, defaultPackaging: 2, safetyStock: 3 });
    expect(rows.rows[0].data).toEqual({ name: 'ANM 1/32 乙炔', type: 'uk_acetylene', defaultPackaging: '包装盒×50', defaultRouting: null, safetyStock: 100 });
    expect(rows.rows[1].data.safetyStock).toBeNull(); // 留空 → null（更新时不覆盖）
  });

  it('缺必填列 → 中文 400（客户缺名称列 / 产品缺类型列）', async () => {
    await expect(svc().preview({ target: 'customers', buffer: await xlsxBuffer([['联系人'], ['John']]), fileName: 'a.xlsx' }))
      .rejects.toThrow('表格缺少必填列：「客户名称」');
    await expect(svc().preview({ target: 'products', buffer: await xlsxBuffer([['型号', '安全库存'], ['ANM 3', 10]]), fileName: 'b.xlsx' }))
      .rejects.toThrow('表格缺少必填列：「类型」');
  });

  it('表头之下没有数据行 → 中文 400', async () => {
    await expect(svc().preview({ target: 'customers', buffer: await xlsxBuffer([['客户名称']]), fileName: 'a.xlsx' }))
      .rejects.toThrow('没有数据行');
  });

  it('target / mode 非法 → 中文 400', async () => {
    const buf = await xlsxBuffer([['客户名称'], ['A']]);
    await expect(svc().preview({ target: 'suppliers', buffer: buf, fileName: 'a.xlsx' })).rejects.toThrow('target 须为 customers');
    await expect(svc().preview({ target: 'customers', mode: 'replace', buffer: buf, fileName: 'a.xlsx' })).rejects.toThrow('mode 须为 insert-only');
  });
});

describe('MasterImportService · 逐行校验分类', () => {
  it('脏数据：空名称 / 非数字账期 / 无法识别的结算方式 / 表内重复 → error + 中文原因', async () => {
    const rows = await svc().preview({
      target: 'customers',
      buffer: await xlsxBuffer([
        ['客户名称', '结算方式', '账期天数'],
        ['杭州测试客户', '月结30天', 30],
        ['', '现结', 10],
        ['桐乡五金城', '货到付款', 10],
        ['苏州配件厂', '现结', '账期看情况'],
        ['杭州测试客户', '现结', 10],
      ]),
      fileName: '客户.xlsx',
    });
    expect(rows.summary).toEqual({ total: 5, new: 1, update: 0, skip: 0, error: 4 });
    expect(rows.rows[1].reasons[0]).toBe('客户名称不能为空');
    expect(rows.rows[2].reasons[0]).toContain('结算方式「货到付款」无法识别');
    expect(rows.rows[3].reasons[0]).toBe('账期天数「账期看情况」不是非负整数');
    expect(rows.rows[4].reasons[0]).toBe('与表内第 2 行重复（客户名称相同），已跳过');
  });

  it('未映射列进 unmappedHeaders，不参与导入', async () => {
    const rows = await svc().preview({
      target: 'customers',
      buffer: await xlsxBuffer([['客户名称', '税号', '备注'], ['A', '9133...', '老客户']]),
      fileName: '客户.xlsx',
    });
    expect(rows.unmappedHeaders).toEqual(['税号', '备注']);
    expect(rows.summary.new).toBe(1);
  });
});

describe('MasterImportService · 幂等（仅新增 vs 新增或更新）', () => {
  beforeEach(() => {
    __db.seed('customers', { name: '杭州测试客户', contact: '老王', settlement: 'cash', creditDays: 30 });
  });

  it('仅新增模式：已存在 → skip（不覆盖）；不存在 → new', async () => {
    const rows = await svc().preview({
      target: 'customers',
      mode: 'insert-only',
      buffer: await xlsxBuffer([['客户名称', '联系人'], ['杭州测试客户', '新联系人'], ['桐乡五金城', '王经理']]),
      fileName: '客户.xlsx',
    });
    expect(rows.summary).toEqual({ total: 2, new: 1, update: 0, skip: 1, error: 0 });
    expect(rows.rows[0].status).toBe('skip');
    expect(rows.rows[0].reasons[0]).toContain('仅新增模式不覆盖');
    expect(rows.rows[0].existingId).toBe(__db.state.customers[0].id);
    expect(rows.rows[1].status).toBe('new');
  });

  it('新增或更新模式：有变化 → update（列出变化字段）；无变化 → skip', async () => {
    const rows = await svc().preview({
      target: 'customers',
      mode: 'upsert',
      buffer: await xlsxBuffer([
        ['客户名称', '联系人', '结算方式', '账期天数'],
        ['杭州测试客户', '新联系人', 'cash', 30], // 联系人有变化（结算/账期同值）
        [' 杭州测试客户 ', '老王', 'cash', 30], // 归一后同名且无变化（前后空格不应算作新档案）
      ]),
      fileName: '客户.xlsx',
    });
    expect(rows.rows[0].status).toBe('update');
    expect(rows.rows[0].changedFields).toEqual(['contact']);
    // 第二行与第一行「表内重复」→ error（同名同表，先出现者生效）
    expect(rows.rows[1].status).toBe('error');
  });

  it('更新模式不覆盖留空字段（只更新非空列）', async () => {
    const s = svc();
    const buf = await xlsxBuffer([['客户名称', '联系人', '账期天数'], ['杭州测试客户', '', '']]);
    const p = await s.preview({ target: 'customers', mode: 'upsert', buffer: buf, fileName: '客户.xlsx' });
    expect(p.rows[0].status).toBe('skip'); // 全空 → 无变化
    expect(p.rows[0].reasons[0]).toContain('无变化');
  });
});

describe('MasterImportService · 型号口径（甲方更正：前导零 = 不同尺寸）', () => {
  it('产品去重**不合并尺寸差异**：0-GPN / 00-GPN / 000-GPN 三条都判 new（不是「已存在」）', async () => {
    const rows = await svc().preview({
      target: 'products',
      buffer: await xlsxBuffer([
        ['型号', '类型', '默认包装', '安全库存'],
        ['0-GPN', '美式丙烷', '', ''],
        ['00-GPN', '美式丙烷', '', ''],
        ['000-GPN', '美式丙烷', '', ''],
        ['0-1-101', '美式乙炔', '', ''],
        ['00-1-101', '美式乙炔', '', ''],
      ]),
      fileName: '产品.xlsx',
    });
    expect(rows.summary).toEqual({ total: 5, new: 5, update: 0, skip: 0, error: 0 });
  });

  it('表内查重也不合并尺寸：0-GPN 与 00-GPN 同表出现不算重复行', async () => {
    const rows = await svc().preview({
      target: 'products',
      buffer: await xlsxBuffer([
        ['型号', '类型'],
        ['0-GPN', '美式丙烷'],
        ['0-GPN', '美式丙烷'], // 真正重复（完全同名）→ 表内重复 error
        ['00-GPN', '美式丙烷'], // 不同尺寸 → 不重复
      ]),
      fileName: '产品.xlsx',
    });
    expect(rows.summary).toEqual({ total: 3, new: 2, update: 0, skip: 0, error: 1 });
    expect(rows.rows[1].reasons[0]).toContain('与表内第 2 行重复');
    expect(rows.rows[2].status).toBe('new');
  });

  it('档案已存在 0-GPN 时，导入 00-GPN 仍是 new（不会误判成已存在而漏建档）', async () => {
    __db.seed('products', { name: '0-GPN', type: 'us_propane', defaultPackaging: '', defaultRouting: '', safetyStock: 0 });
    const rows = await svc().preview({
      target: 'products',
      buffer: await xlsxBuffer([['型号', '类型'], ['00-GPN', '美式丙烷'], ['0-GPN', '美式丙烷']]),
      fileName: '产品.xlsx',
    });
    expect(rows.rows[0].status).toBe('new');       // 00-GPN 是新尺寸
    expect(rows.rows[1].status).toBe('skip');      // 0-GPN 已存在
    expect(rows.rows[1].existingId).toBe(__db.state.products[0].id);
  });

  it('纯文本差异（全角/空格/大小写/标点）仍然判为同一档案 → skip / 表内重复', async () => {
    __db.seed('products', { name: '1-101 割嘴 00#', type: 'us_acetylene', defaultPackaging: '', defaultRouting: '', safetyStock: 0 });
    const rows = await svc().preview({
      target: 'products',
      buffer: await xlsxBuffer([['型号', '类型'], ['１－１０１　割嘴　００＃', '美式乙炔']]),
      fileName: '产品.xlsx',
    });
    expect(rows.rows[0].status).toBe('skip');
    expect(rows.rows[0].reasons[0]).toContain('档案已存在');
  });

  it('客户档案不受数字指纹影响（仍按名称归一：无型号语义）', async () => {
    __db.seed('customers', { name: '客户A', contact: '', settlement: 'cash', creditDays: 0 });
    const rows = await svc().preview({
      target: 'customers',
      buffer: await xlsxBuffer([['客户名称', '联系人'], [' 客户A ', '老王']]),
      fileName: '客户.xlsx',
    });
    expect(rows.rows[0].status).toBe('skip');
  });
});

describe('MasterImportService · commit 写库', () => {
  it('preview 不写库；commit 才写，并返回统计', async () => {
    const s = svc();
    const buf = await xlsxBuffer([
      ['客户名称', '联系人', '结算方式', '账期天数'],
      ['杭州测试客户', 'John', '月结30天', 30],
      ['', '', '', ''],
      ['桐乡五金城', '王经理', '现结', 0],
      ['坏行', '张三', '货到付款', 1],
    ]);
    const p = await s.preview({ target: 'customers', buffer: buf, fileName: '客户.xlsx' });
    expect(p.summary.total).toBe(3);
    expect(__db.state.customers.length).toBe(0); // 预览不落库

    const c = await s.commit({ target: 'customers', buffer: buf, fileName: '客户.xlsx' });
    expect(c.summary).toEqual({ total: 3, new: 2, update: 0, skip: 0, error: 1 });
    expect(c.created.map((x) => x.name)).toEqual(['杭州测试客户', '桐乡五金城']);
    expect(c.failures.length).toBe(1);
    expect(c.failures[0].rowNo).toBe(4); // 表头下第 3 个数据行
    expect(c.failures[0].name).toBe('坏行');
    expect(c.failures[0].reason).toContain('结算方式「货到付款」无法识别');
    expect(__db.state.customers.length).toBe(2);
  });

  it('单行写库失败不影响其它行（逐行事务 + 汇总失败清单）', async () => {
    __db.state.failOnInsertName = '炸';
    const buf = await xlsxBuffer([['客户名称'], ['正常客户A'], ['炸客户B'], ['正常客户C']]);
    const c = await svc().commit({ target: 'customers', buffer: buf, fileName: '客户.xlsx' });
    expect(c.summary).toEqual({ total: 3, new: 2, update: 0, skip: 0, error: 1 });
    expect(c.failures[0].name).toBe('炸客户B');
    expect(c.failures[0].reason).toBe('模拟写库失败');
    expect(__db.state.customers.map((r) => r.name)).toEqual(['正常客户A', '正常客户C']);
  });

  it('upsert 模式更新既有档案的非空字段', async () => {
    __db.seed('products', { name: 'ANM 3', type: 'uk_acetylene', defaultPackaging: '旧包装', defaultRouting: '旧路线', safetyStock: 10 });
    const buf = await xlsxBuffer([['型号', '类型', '默认包装', '安全库存'], ['ANM 3', '英式乙炔', '新包装', '']]);
    const p = await svc().preview({ target: 'products', mode: 'upsert', buffer: buf, fileName: '产品.xlsx' });
    expect(p.rows[0].status).toBe('update');
    expect(p.rows[0].changedFields).toEqual(['defaultPackaging']);

    const c = await svc().commit({ target: 'products', mode: 'upsert', buffer: buf, fileName: '产品.xlsx' });
    expect(c.summary).toEqual({ total: 1, new: 0, update: 1, skip: 0, error: 0 });
    const row = __db.state.products[0];
    expect(row.defaultPackaging).toBe('新包装');
    expect(row.defaultRouting).toBe('旧路线'); // 留空列不覆盖
    expect(row.safetyStock).toBe(10);
  });

  it('解析失败（文件损坏）→ 直接 400，不产生任何写操作', async () => {
    await expect(svc().commit({ target: 'customers', buffer: Buffer.from('d0cf11e0a1b11ae1', 'hex'), fileName: '坏.xls' }))
      .rejects.toThrow(BadRequestException);
    expect(__db.state.customers.length).toBe(0);
  });
});

describe('MasterImportService · .xls / .csv 复用与模板', () => {
  it('.xls（BIFF8）与 .csv 各跑一遍客户导入', async () => {
    const s = svc();
    const xls = await s.preview({ target: 'customers', buffer: xlsBuffer([['客户名称', '联系人'], ['Weldclass', 'John']]), fileName: '客户.xls' });
    expect(xls.fileKind).toBe('xls');
    expect(xls.summary.new).toBe(1);

    const csv = await s.preview({ target: 'customers', buffer: csvBuffer([['客户,联系人'.replace(',', '名称,'), '联系人'], ['桐乡五金城', '王经理']]), fileName: '客户.csv' });
    expect(csv.fileKind).toBe('csv');
    expect(csv.summary.new).toBe(1);
  });

  it('模板：中文表头 + 示例行（CSV 转义）', () => {
    const t = svc().template('products');
    expect(t.name).toBe('产品导入模板.csv');
    const lines = t.csv.trim().split('\r\n');
    expect(lines[0]).toBe('型号,类型,默认包装,默认工序路线,安全库存');
    expect(lines.length).toBe(3);
    const c = svc().template('customers');
    expect(c.csv).toContain('客户名称,联系人,结算方式,账期天数');
    expect(c.csv).toContain('30%定金+70%发货前');
  });
});
