import * as XLSX from '@e965/xlsx';
import * as ExcelJS from 'exceljs';
import * as iconv from 'iconv-lite';
import {
  cellToString,
  countDataRows,
  decodeTextBuffer,
  detectDelimiter,
  detectTableFileKind,
  detectUploadKind,
  excelSerialToDate,
  looksLikeText,
  mapHeader,
  matrixToCompactText,
  normalizeMatrix,
  parseCsvText,
  parseDateCell,
  parseNumberCell,
  readXlsMatrix,
  readXlsxMatrix,
  ruleMapMatrix,
  sheetCellToString,
  sheetToMatrix,
  sniffMagicKind,
  TableParserService,
} from './table-parser.service';

/**
 * 表格解析单元测试：xls(BIFF8) / xlsx / csv 读取 + 表头规则映射 + 数值日期归一。
 * 全部为纯函数或内存文件，不依赖数据库与网络。
 * .xls 样例用所选解析库（@e965/xlsx）以 bookType:'biff8' 现场写出，保证可复现。
 */

// ============ .xls（BIFF8）样例构造：与运行环境时区无关 ============

/** 用 @e965/xlsx 写一份真实的 .xls（BIFF8 / OLE2），字节头应为 d0cf11e0a1b11ae1 */
function writeXls(aoa: unknown[][], sheetName = '订单明细', opts: { dateCells?: string[]; merges?: string[] } = {}): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa as never);
  // 日期单元格：用 Excel 序列号 + 日期数字格式（避免依赖本机时区）
  for (const addr of opts.dateCells ?? []) (ws as Record<string, { z?: string }>)[addr].z = 'yyyy-mm-dd';
  if (opts.merges?.length) {
    (ws as { '!merges'?: XLSX.Range[] })['!merges'] = opts.merges.map((r) => XLSX.utils.decode_range(r));
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return Buffer.from(XLSX.write(wb, { bookType: 'biff8', type: 'buffer', cellDates: true }) as ArrayBuffer);
}

/** 多工作表 .xls（第一张为封面空表，第二张才是订单） */
function writeXlsMultiSheet(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['']]), '封面');
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['客户简称', '品名', '数量', '单价'], ['杭州测试客户', 'ANM 3', 2000, 4.2]] as never),
    '订单明细',
  );
  return Buffer.from(XLSX.write(wb, { bookType: 'biff8', type: 'buffer', cellDates: true }) as ArrayBuffer);
}

/** Excel 序列号：46295 → 2026-09-30 */
const XLS_DATE_SERIAL = 46295;

const CSV_UTF8 = [
  '客户名称,产品,数量,单价,交期,备注',
  '杭州测试客户,ANM 3,"2,000",4.20,2026-09-30,纸箱包装',
  '杭州测试客户,PNM 1/32,500,3.80,2026-09-30,',
].join('\n');

describe('表格文件类型判定（detectTableFileKind）', () => {
  it('扩展名优先：xlsx/csv/xls/pdf/图片', () => {
    expect(detectTableFileKind('订单.xlsx')).toBe('xlsx');
    expect(detectTableFileKind('订单.CSV')).toBe('csv');
    expect(detectTableFileKind('order.tsv')).toBe('csv');
    expect(detectTableFileKind('旧订单.xls')).toBe('xls');
    expect(detectTableFileKind('订单.pdf')).toBe('pdf');
    expect(detectTableFileKind('订单.png')).toBe('image');
    expect(detectTableFileKind('订单.jpeg')).toBe('image');
  });

  it('无扩展名时按 MIME 判定（图片仍走既有 vision 通道）', () => {
    expect(detectTableFileKind('', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('xlsx');
    expect(detectTableFileKind('', 'text/csv')).toBe('csv');
    expect(detectTableFileKind('', 'application/vnd.ms-excel')).toBe('xls');
    expect(detectTableFileKind('', 'application/pdf')).toBe('pdf');
    expect(detectTableFileKind('', 'image/png')).toBe('image');
    expect(detectTableFileKind('', 'application/octet-stream')).toBe('unsupported');
  });
});

describe('CSV 编码识别（decodeTextBuffer）', () => {
  it('UTF-8（含 BOM）与 GBK 都能正确还原中文', () => {
    const utf8 = Buffer.from(CSV_UTF8, 'utf8');
    expect(decodeTextBuffer(utf8).encoding).toBe('utf-8');
    expect(decodeTextBuffer(utf8).text).toContain('杭州测试客户');

    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]);
    const bomDecoded = decodeTextBuffer(withBom);
    expect(bomDecoded.encoding).toBe('utf-8(bom)');
    expect(bomDecoded.text.startsWith('客户名称')).toBe(true);

    const gbk = iconv.encode(CSV_UTF8, 'gbk');
    const gbkDecoded = decodeTextBuffer(gbk);
    expect(gbkDecoded.encoding).toBe('gbk');
    expect(gbkDecoded.text).toContain('杭州测试客户');
    expect(gbkDecoded.text).toContain('PNM 1/32');
  });
});

describe('CSV 解析（parseCsvText / detectDelimiter）', () => {
  it('逗号分隔 + 千分位引号字段', () => {
    const rows = normalizeMatrix(parseCsvText(CSV_UTF8));
    expect(rows.length).toBe(3);
    expect(rows[0]).toEqual(['客户名称', '产品', '数量', '单价', '交期', '备注']);
    expect(rows[1][2]).toBe('2,000');
  });

  it('制表符分隔自动探测', () => {
    const tsv = '客户\t产品\t数量\t单价\n测试客户\tANM 3\t100\t2.5';
    expect(detectDelimiter(tsv)).toBe('\t');
    const rows = normalizeMatrix(parseCsvText(tsv));
    expect(rows[1]).toEqual(['测试客户', 'ANM 3', '100', '2.5']);
  });

  it('引号转义：字段内逗号、双引号与换行', () => {
    const csv = 'a,b\n"含,逗号","说 ""引号"" 与\n换行"';
    const rows = parseCsvText(csv);
    expect(rows[1][0]).toBe('含,逗号');
    expect(rows[1][1]).toBe('说 "引号" 与\n换行');
  });

  it('CRLF 与尾部空行不产生多余行', () => {
    const rows = parseCsvText('a,b\r\n1,2\r\n\r\n');
    expect(rows).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('数值与日期归一', () => {
  it('parseNumberCell：千分位/货币符号/中文单位/全角数字', () => {
    expect(parseNumberCell('2,000')).toBe(2000);
    expect(parseNumberCell('￥12.50')).toBe(12.5);
    expect(parseNumberCell('1000 pcs')).toBe(1000);
    expect(parseNumberCell('2000只')).toBe(2000);
    expect(parseNumberCell('３．５')).toBe(3.5);
    expect(parseNumberCell('无')).toBeUndefined();
    expect(parseNumberCell('')).toBeUndefined();
  });

  it('parseDateCell：常见中文/英文/数字写法', () => {
    expect(parseDateCell('2026-09-30')).toBe('2026-09-30');
    expect(parseDateCell('2026/9/30')).toBe('2026-09-30');
    expect(parseDateCell('2026年9月30日')).toBe('2026-09-30');
    expect(parseDateCell('20260930')).toBe('2026-09-30');
    expect(parseDateCell('9/30/2026')).toBe('2026-09-30');
    expect(parseDateCell('30/9/2026')).toBe('2026-09-30');
    expect(parseDateCell('不是日期')).toBeUndefined();
    expect(parseDateCell('2026-02-30')).toBeUndefined(); // 非法日期
  });

  it('excelSerialToDate：Excel 日期序列号', () => {
    // 1900 日期系统：46282 → 2026-09-17，46295 → 2026-09-30
    expect(excelSerialToDate(46282)).toBe('2026-09-17');
    expect(excelSerialToDate(46295)).toBe('2026-09-30');
  });
});

describe('表头识别与规则映射', () => {
  it('表头不在第一行（前面有抬头）也能命中', () => {
    const rows = normalizeMatrix([
      ['订单确认单', '', '', ''],
      ['客户：杭州测试客户', '', '', ''],
      ['客户名称', '产品', '数量', '单价'],
      ['杭州测试客户', 'ANM 3', '2000', '4.2'],
    ]);
    const mapping = mapHeader(rows);
    expect(mapping.headerRowIndex).toBe(2);
    expect(mapping.requiredHits).toBe(4);
    expect(mapping.sufficient).toBe(true);
    expect(countDataRows(rows)).toBe(1);
  });

  it('关键列齐全 → sufficient=true，规则映射出多行明细（一张订单多行）', () => {
    const rows = normalizeMatrix(parseCsvText(CSV_UTF8));
    const r = ruleMapMatrix(rows);
    expect(r.mapping.sufficient).toBe(true);
    expect(r.dataRowCount).toBe(2);
    expect(r.parsed.customerName).toBe('杭州测试客户');
    expect(r.parsed.dueDate).toBe('2026-09-30');
    expect(r.parsed.lines.length).toBe(2);
    expect(r.parsed.lines[0].productName).toBe('ANM 3');
    expect(r.parsed.lines[0].quantity).toBe(2000);
    expect(r.parsed.lines[0].unitPrice).toBe(4.2);
    expect(r.parsed.lines[1].productName).toBe('PNM 1/32');
    expect(r.parsed.lines[1].quantity).toBe(500);
    expect(r.parsed.lines[1].unitPrice).toBe(3.8);
    expect(r.parsed.confidence).toBe('high');
  });

  it('缺关键列（无客户列）→ sufficient=false，交给 LLM 兜底映射', () => {
    const rows = normalizeMatrix([
      ['产品', '数量', '单价'],
      ['ANM 3', '2000', '4.2'],
    ]);
    const r = ruleMapMatrix(rows);
    expect(r.mapping.sufficient).toBe(false);
    expect(r.mapping.missingRequired).toContain('customer');
    expect(r.parsed.customerName).toBe('');
    expect(r.parsed.lines[0].productName).toBe('ANM 3');
  });

  it('表头关键词按「最长命中」归列：「客户PO号」归 poNo 而不是 customer', () => {
    const rows = normalizeMatrix([
      ['客户', '客户PO号', '产品名称', '数量', '单价(元)'],
      ['杭州测试客户', 'PO-2026-0901', 'ANM 3', '2000', '4.20'],
    ]);
    const mapping = mapHeader(rows);
    expect(mapping.columns.customer).toBe(0);
    expect(mapping.columns.poNo).toBe(1);
    expect(mapping.columns.productName).toBe(2);
    expect(mapping.columns.quantity).toBe(3);
    expect(mapping.columns.unitPrice).toBe(4);
    const r = ruleMapMatrix(rows);
    expect(r.parsed.poNo).toBe('PO-2026-0901');
    expect(r.parsed.customerName).toBe('杭州测试客户');
  });

  it('matrixToCompactText：带行号与列分隔符，行数受限制', () => {
    const rows = normalizeMatrix(parseCsvText(CSV_UTF8));
    const text = matrixToCompactText(rows, 2);
    expect(text.split('\n').length).toBe(2);
    expect(text.startsWith('R1| 客户名称 | 产品')).toBe(true);
  });

  it('cellToString：Date / 富文本 / 公式结果', () => {
    expect(cellToString(new Date(2026, 8, 30))).toBe('2026-09-30');
    expect(cellToString({ richText: [{ text: 'ANM' }, { text: ' 3' }] })).toBe('ANM 3');
    expect(cellToString({ formula: 'A1', result: 42 })).toBe('42');
    expect(cellToString(null)).toBe('');
  });
});

describe('xlsx 读取（exceljs）', () => {
  it('读第一个工作表 → 规则映射出多行订单（含 Date 单元格）', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('订单明细');
    ws.addRow(['客户名称', '产品', '数量', '单价', '交期', '备注']);
    ws.addRow(['杭州测试客户', 'ANM 3', 2000, 4.2, new Date(2026, 8, 30), '加急']);
    ws.addRow(['', 'PNM 1/32', 500, 3.8, '', '']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const rows = normalizeMatrix(await readXlsxMatrix(buf));
    const r = ruleMapMatrix(rows);
    expect(r.mapping.sufficient).toBe(true);
    expect(r.dataRowCount).toBe(2);
    expect(r.parsed.customerName).toBe('杭州测试客户');
    expect(r.parsed.dueDate).toBe('2026-09-30');
    expect(r.parsed.lines.map((l) => l.productName)).toEqual(['ANM 3', 'PNM 1/32']);
    expect(r.parsed.lines[0].quantity).toBe(2000);
    expect(r.parsed.lines[0].unitPrice).toBe(4.2);
  });

  it('空工作表 → 中文报错', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('空表');
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(readXlsxMatrix(buf)).rejects.toThrow('空的');
  });
});

describe('TableParserService.parseUpload（上传入口分支）', () => {
  const svc = new TableParserService();

  it('.xlsx → 返回矩阵（含表头）', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S1');
    ws.addRow(['客户', '产品', '数量', '单价']);
    ws.addRow(['测试客户', 'ANM 3', 10, 1.5]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await svc.parseUpload({ buffer: buf, fileName: '订单.xlsx' });
    expect(r.kind).toBe('xlsx');
    expect(r.rows.length).toBe(2);
  });

  it('.csv（GBK）→ 返回矩阵并标注编码', async () => {
    const buf = iconv.encode(CSV_UTF8, 'gbk');
    const r = await svc.parseUpload({ buffer: buf, fileName: '订单.csv' });
    expect(r.kind).toBe('csv');
    expect(r.encoding).toBe('gbk');
    expect(r.rows[0][0]).toBe('客户名称');
    expect(r.rows[1][0]).toBe('杭州测试客户');
  });

  it('.xls（BIFF8）→ 走同一管线返回矩阵（不再拒绝）', async () => {
    const buf = writeXls([['客户简称', '品名', '数量', '单价'], ['杭州测试客户', 'ANM 3', 2000, 4.2]]);
    const r = await svc.parseUpload({ buffer: buf, fileName: '旧订单.xls' });
    expect(r.kind).toBe('xls');
    expect(r.rows.length).toBe(2);
    expect(r.rows[0][0]).toBe('客户简称');
    expect(r.rows[1]).toEqual(['杭州测试客户', 'ANM 3', '2000', '4.2']);
  });

  it('扩展名写错也能救：.xls 内容命名为 .xlsx → 仍按 BIFF8 解析', async () => {
    const buf = writeXls([['客户', '产品', '数量', '单价'], ['杭州测试客户', 'ANM 3', 10, 1.5]]);
    const r = await svc.parseUpload({ buffer: buf, fileName: '误命名.xlsx' });
    expect(r.kind).toBe('xls');
    expect(r.rows[1][0]).toBe('杭州测试客户');
  });

  it('损坏的 .xls（只有 OLE2 头）→ 中文提示，不抛库原始英文错误', async () => {
    await expect(svc.parseUpload({ buffer: Buffer.from('d0cf11e0a1b11ae1', 'hex'), fileName: '旧订单.xls' }))
      .rejects.toThrow('无法读取该 .xls 文件');
  });

  it('.pdf → 明确中文提示（不静默失败）', async () => {
    await expect(svc.parseUpload({ buffer: Buffer.from('%PDF-1.4'), fileName: '订单.pdf' }))
      .rejects.toThrow('PDF 暂不支持直接解析');
  });

  it('不支持的扩展名 → 中文提示支持范围（含 .xls）', async () => {
    await expect(svc.parseUpload({ buffer: Buffer.from('x'), fileName: '订单.txt' }))
      .rejects.toThrow('仅支持 .xls / .xlsx / .csv');
  });
});

describe('文件格式判定（magic bytes 优先，扩展名写错也能救）', () => {
  it('OLE2 头 → xls，PK 头 → xlsx（即使扩展名互相写错）', async () => {
    const xlsBuf = writeXls([['客户', '产品', '数量', '单价'], ['杭州测试客户', 'ANM 3', 10, 1.5]]);
    expect(xlsBuf.subarray(0, 8).toString('hex')).toBe('d0cf11e0a1b11ae1'); // 真实 OLE2 复合文档头
    expect(sniffMagicKind(xlsBuf)).toBe('xls');
    expect(detectUploadKind(xlsBuf, '订单.xlsx')).toBe('xls'); // 扩展名谎报 .xlsx → 仍按 xls 解析

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['客户', '产品', '数量', '单价']);
    ws.addRow(['杭州测试客户', 'ANM 3', 10, 1.5]);
    const xlsxBuf = Buffer.from(await wb.xlsx.writeBuffer());
    expect(sniffMagicKind(xlsxBuf)).toBe('xlsx');
    expect(detectUploadKind(xlsxBuf, '订单.xls')).toBe('xlsx'); // 扩展名谎报 .xls → 仍按 xlsx 解析
  });

  it('PDF / 图片 / 文本 / 未知二进制各有判定', () => {
    expect(sniffMagicKind(Buffer.from('%PDF-1.4'))).toBe('pdf');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    expect(sniffMagicKind(png)).toBe('image');
    expect(sniffMagicKind(Buffer.from('客户,产品\nA,B', 'utf8'))).toBe('text');
    expect(sniffMagicKind(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x01]))).toBe('binary');
    // 以 BM 开头的文本表格不能被误判成 BMP 图片
    expect(sniffMagicKind(Buffer.from('BM号,客户名称\nBM-01,杭州测试客户', 'utf8'))).toBe('text');
    // 文本内容 + .xls 扩展名（Excel 另存的 CSV 被改名）→ 按 CSV 管线兜底
    expect(detectUploadKind(Buffer.from('客户,产品\n杭州测试客户,ANM 3', 'utf8'), '订单.xls')).toBe('csv');
    // 扩展名与 MIME 都不认识 → 仍给中文可识别范围之外
    expect(detectUploadKind(Buffer.from('随手记的笔记'), '订单.txt')).toBe('unsupported');
    expect(looksLikeText(Buffer.from('a,b\r\n1,2'))).toBe(true);
    expect(looksLikeText(Buffer.from([0x00, 0x01, 0x02]))).toBe(false);
  });

  it('无扩展名的 .xls 内容也能判定为 xls（magic bytes 兜底扩展名）', () => {
    const buf = writeXls([['客户', '产品'], ['杭州测试客户', 'ANM 3']]);
    expect(detectUploadKind(buf, '')).toBe('xls');
  });
});

describe('.xls（BIFF8）读取细节', () => {
  it('中文表头别名（客户简称/品名/交货日期）+ 多行明细 → 与 xlsx 同构的 ParsedOrder', () => {
    const buf = writeXls(
      [
        ['客户简称', '客户PO号', '品名', '数量', '单价', '交货日期', '包装要求'],
        ['杭州测试客户', 'PO-XLS-01', 'ANM 3', 2000, 4.2, XLS_DATE_SERIAL, '纸箱'],
        ['', '', 'PNM 1/32', 500, 3.8, '', ''],
      ],
      '订单明细',
      { dateCells: ['F2'] },
    );
    const rows = normalizeMatrix(readXlsMatrix(buf));
    const r = ruleMapMatrix(rows);
    expect(r.mapping.sufficient).toBe(true);
    expect(r.dataRowCount).toBe(2);
    expect(r.parsed.customerName).toBe('杭州测试客户');
    expect(r.parsed.poNo).toBe('PO-XLS-01');
    expect(r.parsed.dueDate).toBe('2026-09-30'); // 日期单元格（序列号 46295 + 日期格式）
    expect(r.parsed.lines.map((l) => l.productName)).toEqual(['ANM 3', 'PNM 1/32']);
    expect(r.parsed.lines[0].quantity).toBe(2000);
    expect(r.parsed.lines[0].unitPrice).toBe(4.2);
    expect(r.parsed.lines[1].quantity).toBe(500);
    expect(r.parsed.lines[1].unitPrice).toBe(3.8);
    expect(r.parsed.confidence).toBe('high');
  });

  it('日期单元格（cellDates）归一为 YYYY-MM-DD', () => {
    const buf = writeXls([['交期'], [XLS_DATE_SERIAL], ['2026/10/1'], ['2026年10月2日']], 'S', { dateCells: ['A2'] });
    const rows = readXlsMatrix(buf);
    expect(rows[1][0]).toBe('2026-09-30'); // Date 单元格 → UTC 口径归一
    expect(parseDateCell(rows[2][0])).toBe('2026-10-01');
    expect(parseDateCell(rows[3][0])).toBe('2026-10-02');
  });

  it('数值精度：整数不带小数点、小数不产生浮点尾差、千分位不被格式化污染', () => {
    const buf = writeXls([['数量', '单价'], [2000, 4.2], [3, 0.1], [1234567, 1234567.89]]);
    const rows = readXlsMatrix(buf);
    expect(rows[1]).toEqual(['2000', '4.2']);
    expect(rows[2]).toEqual(['3', '0.1']);
    expect(rows[3]).toEqual(['1234567', '1234567.89']);
    const r = ruleMapMatrix(normalizeMatrix(rows));
    expect(r.parsed.lines[1].quantity).toBe(3);
    expect(r.parsed.lines[1].unitPrice).toBe(0.1); // 3 × 0.1 元 = 30 分（定点，无 0.30000000000000004）
    expect(r.parsed.lines[2].quantity).toBe(1234567);
    expect(r.parsed.lines[2].unitPrice).toBe(1234567.89);
  });

  it('全空行被跳过（表头前/数据中/尾部）', () => {
    const buf = writeXls([
      ['', '', ''],
      ['客户', '产品', '数量', '单价'],
      ['杭州测试客户', 'ANM 3', 10, 1.5],
      ['', '', '', ''],
      ['', 'PNM 1/32', 5, 2],
      ['', '', '', ''],
    ]);
    const rows = readXlsMatrix(buf);
    expect(rows.length).toBe(3); // 表头 1 行 + 数据 2 行：抬头空行与两处空行都不进矩阵
    const r = ruleMapMatrix(normalizeMatrix(rows));
    expect(r.dataRowCount).toBe(2);
    expect(r.parsed.lines.map((l) => l.productName)).toEqual(['ANM 3', 'PNM 1/32']);
  });

  it('合并单元格取左上值（SheetJS 只在左上角存值，需补齐到整个合并区）', () => {
    const buf = writeXls(
      [
        ['客户名称', '产品', '数量', '单价'],
        ['杭州测试客户', 'ANM 3', 2000, 4.2],
        ['', 'PNM 1/32', 500, 3.8],
      ],
      'M',
      { merges: ['A2:A3'] },
    );
    const rows = readXlsMatrix(buf);
    expect(rows[2][0]).toBe('杭州测试客户'); // 合并区非锚点行也拿到左上值
    const r = ruleMapMatrix(normalizeMatrix(rows));
    expect(r.dataRowCount).toBe(2);
    expect(r.parsed.customerName).toBe('杭州测试客户');
    expect(r.parsed.lines[1].productName).toBe('PNM 1/32');
  });

  it('多工作表取第一个非空表（封面空表不影响识别）', () => {
    const rows = readXlsMatrix(writeXlsMultiSheet());
    expect(rows[0].slice(0, 2)).toEqual(['客户简称', '品名']);
    expect(rows[1][0]).toBe('杭州测试客户');
  });

  it('全空工作簿 → 中文报错；损坏文件 → 中文报错', () => {
    expect(() => readXlsMatrix(writeXls([['']]))).toThrow('所有工作表都是空的');
    expect(() => readXlsMatrix(Buffer.from('d0cf11e0a1b11ae1', 'hex'))).toThrow('无法读取该 .xls 文件');
  });

  it('sheetCellToString：日期/数字/布尔/错误值/空单元格', () => {
    expect(sheetCellToString({ t: 'd', v: new Date(Date.UTC(2026, 8, 30)) } as never)).toBe('2026-09-30');
    expect(sheetCellToString({ t: 'n', v: 4.2 } as never)).toBe('4.2');
    expect(sheetCellToString({ t: 'b', v: true } as never)).toBe('TRUE');
    expect(sheetCellToString({ t: 'e', v: 15, w: '#REF!' } as never)).toBe('');
    expect(sheetCellToString(undefined)).toBe('');
  });

  it('sheetToMatrix：跳过全空行、保留列结构', () => {
    const ws = XLSX.utils.aoa_to_sheet([['a', 'b'], ['', ''], ['c', '']] as never);
    expect(sheetToMatrix(ws)).toEqual([['a', 'b'], ['c', '']]);
  });
});
