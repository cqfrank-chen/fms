import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { AiOrdersController, decodeUpload } from './ai-orders.controller';
import { TableParserService } from './table-parser.service';

/**
 * 上传分支测试（不连数据库/网络）：图片 → 既有 vision 通道；xlsx/csv → 表格管线；.xls/.pdf → 明确中文提示。
 * db 用空实现占位（本用例只覆盖 parse 分支，不触库）。
 */
jest.mock('../db', () => ({ db: {} }));

const PARSED = { lines: [], parseSource: 'text', totalCents: 0 };

function makeController() {
  const parser = { parseAndResolve: jest.fn().mockResolvedValue(PARSED) };
  const ctl = new AiOrdersController(parser as never, new TableParserService());
  return { ctl, parser };
}

const dataUrl = (mime: string, body: Buffer) => 'data:' + mime + ';base64,' + body.toString('base64');

describe('AiOrdersController.parse · 上传类型分支', () => {
  it('图片文件 → 走既有 vision 通道（image dataURL），parseSource=image', async () => {
    const { ctl, parser } = makeController();
    await ctl.parse({ file: dataUrl('image/png', Buffer.from('fake-png')), fileName: '订单照片.png' });
    const arg = parser.parseAndResolve.mock.calls[0][0];
    expect(arg.image).toBe('data:image/png;base64,' + Buffer.from('fake-png').toString('base64'));
    expect(arg.table).toBeUndefined();
  });

  it('xlsx → 表格管线（table.rows，source=excel）', async () => {
    const { ctl, parser } = makeController();
    // 用一个最小的合法 xlsx（exceljs 生成）
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['客户', '产品', '数量', '单价']);
    ws.addRow(['杭州测试客户', 'ANM 3', 10, 2.5]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    await ctl.parse({ file: dataUrl('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf), fileName: '订单.xlsx' });
    const arg = parser.parseAndResolve.mock.calls[0][0];
    expect(arg.image).toBeUndefined();
    expect(arg.table.source).toBe('excel');
    expect(arg.table.rows[0]).toEqual(['客户', '产品', '数量', '单价']);
    expect(arg.table.rows[1][0]).toBe('杭州测试客户');
  });

  it('csv → 表格管线（source=csv）', async () => {
    const { ctl, parser } = makeController();
    const csv = Buffer.from('客户,产品,数量,单价\n杭州测试客户,ANM 3,10,2.5', 'utf8');
    await ctl.parse({ file: dataUrl('text/csv', csv), fileName: '订单.csv' });
    const arg = parser.parseAndResolve.mock.calls[0][0];
    expect(arg.table.source).toBe('csv');
    expect(arg.table.rows.length).toBe(2);
  });

  it('.xls → 400 中文提示「请另存为 .xlsx 或 .csv 后重试」', async () => {
    const { ctl, parser } = makeController();
    await expect(ctl.parse({ file: dataUrl('application/vnd.ms-excel', Buffer.from('d0cf11e0', 'hex')), fileName: '老订单.xls' }))
      .rejects.toThrow('请用 Excel 另存为 .xlsx 或 .csv 后重试');
    expect(parser.parseAndResolve).not.toHaveBeenCalled(); // 未进识别管线，不浪费 AI 调用
  });

  it('.pdf → 400 中文提示', async () => {
    const { ctl } = makeController();
    await expect(ctl.parse({ file: dataUrl('application/pdf', Buffer.from('%PDF-1.4')), fileName: '订单.pdf' }))
      .rejects.toThrow('PDF 暂不支持直接解析');
  });

  it('纯文本 → 走文本通道', async () => {
    const { ctl, parser } = makeController();
    await ctl.parse({ text: '客户：杭州测试客户' });
    expect(parser.parseAndResolve).toHaveBeenCalledWith({ text: '客户：杭州测试客户', image: undefined, stub: undefined });
  });

  it('坏 base64/空内容 → 中文提示', async () => {
    const { ctl } = makeController();
    await expect(ctl.parse({ file: 'data:text/csv;base64,', fileName: 'a.csv' })).rejects.toThrow('上传内容为空');
  });
});

describe('decodeUpload · 体积与格式护栏', () => {
  it('解析 dataURL 的 MIME 与内容', () => {
    const r = decodeUpload(dataUrl('text/csv', Buffer.from('a,b')), 'x.csv');
    expect(r.mime).toBe('text/csv');
    expect(r.buffer.toString()).toBe('a,b');
    expect(r.name).toBe('x.csv');
  });

  it('纯 base64（无 data: 前缀）也接受', () => {
    const r = decodeUpload(Buffer.from('hello').toString('base64'));
    expect(r.buffer.toString()).toBe('hello');
  });

  it('超过 8MB → 中文提示', () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 0x41).toString('base64');
    expect(() => decodeUpload(big)).toThrow('文件超过 8MB');
  });
});

describe('AiOrdersController · 错误映射保持既有语义', () => {
  it('HTTP 异常（如 .xls 提示）原样透传，不被包成 502', async () => {
    const parser = { parseAndResolve: jest.fn().mockRejectedValue(new BadRequestException('测试用中文错误')) };
    const ctl = new AiOrdersController(parser as never, new TableParserService());
    await expect(ctl.parse({ text: 'x' })).rejects.toThrow('测试用中文错误');
  });

  it('识图 Key 缺失 → 400 且带 VISION_KEY_MISSING 标记', async () => {
    const parser = { parseAndResolve: jest.fn().mockRejectedValue(new Error('识图 API Key 未配置：AI_VISION_KEY')) };
    const ctl = new AiOrdersController(parser as never, new TableParserService());
    await expect(ctl.parse({ image: 'data:image/png;base64,AA==' })).rejects.toMatchObject({
      response: { code: 'VISION_KEY_MISSING' },
      status: 400,
    });
  });
});
