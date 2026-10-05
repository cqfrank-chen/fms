import {
  classifyDataRow,
  extractDateFromText,
  folderCustomerWarning,
  mapHeader,
  normalizeMatrix,
  normPartyName,
  requiredTableFields,
  ruleMapMatrix,
  scanContractHeader,
} from './table-parser.service';
import { OrderParserService } from './order-parser.service';

/**
 * 「文件夹=客户」口径 · 识单管线改造测试（甲方裁定：以文件夹为识别主体，同一文件夹内的都是同一家）
 * ---------------------------------------------------------------------------------------
 * 覆盖本轮 4 处改造（见 D:\futures\ziliao-analysis.md §3.3 的 4 个问题）：
 *   a) folderCustomer：客户由文件夹决定 → customer 不再计入必填列，规则映射不再必然降级到 LLM
 *   b) 抬头区扫描器：合同编号 / 交货期限 / 供方需方（表头行以上 + 表体之后的条款区）
 *   c) 数据行终止条件：条款/大写金额/正唛/合计/备注等噪声行被跳过，停止原因写入诊断
 *   d) 产品列优先级：产品名称优先于产品编号（编号另存 productCode），同字段多列按关键词长度取列
 *
 * 样例矩阵照抄真实合同形态（尤耐克族「供需合同」与安宝族「出口产品供需合同」），
 * 但公司名做了脱敏替换，断言只看结构不看具体客户。
 */

jest.mock('../db', () => {
  const schema = jest.requireActual('../db/schema');
  const customers = [{ id: 11, name: '杭州测试客户' }];
  const products = [{ id: 22, name: '1-101 割嘴 00#' }, { id: 23, name: '1-101 割嘴 2#' }];
  return {
    db: {
      select: () => ({
        from: (table: unknown) => Promise.resolve(table === schema.customers ? customers : products),
      }),
    },
  };
});

/** 尤耐克族：抬头块（合同编号/供方/需方）+ 表头（No/产品编号/产品名称/数量/单 价）+ 表体 + 条款区 */
function younaikeContract(): string[][] {
  return normalizeMatrix([
    ['产  品  供  需  合  同', '', '', '', '', '', '', ''],
    ['合同编号：', 'UW250307093宁波一洲', '', '', '签订时间：', '3/5/25', '', ''],
    ['供      方：', '奉化一洲焊割工具有限公司', '', '', '需      方：', '宁波市尤耐克工具有限公司', '', ''],
    ['一、产品名称、商标、厂家、规格、数量、金额', '', '', '', '', '', '', ''],
    ['No', '产品编号', '产品名称', '数量', '单 位', '单 价', '总金额（元）', '侧唛'],
    ['', '', '', '', '', 'RMB', '', ''],
    ['1', '1C001-0001 00#', '1-101 割嘴  00#', '200', '个', '13.20 ', '2,640.00 ', 'Cutting Nozzle CW-00-1-101'],
    ['备   注：', '1.1-101，乙炔，00#，紫铜，克重：84g，型号CW-00-1-101', '', '', '', '', '', ''],
    ['2', '1C001-0001 2#', '1-101 割嘴  2#', '300', '个', '13.20 ', '3,960.00 ', 'Cutting Nozzle CW-2-1-101'],
    ['三、交货期限：2025年04月23日。', '', '', '', '', '', '', ''],
  ]);
}

describe('①a 客户由文件夹决定（folderCustomer）', () => {
  it('requiredTableFields：给了 folderCustomer 就不再要求 customer 列', () => {
    expect(requiredTableFields()).toEqual(['customer', 'productName', 'quantity', 'unitPrice']);
    expect(requiredTableFields('安宝公司')).toEqual(['productName', 'quantity', 'unitPrice']);
    expect(requiredTableFields('   ')).toEqual(['customer', 'productName', 'quantity', 'unitPrice']);
  });

  it('mapHeader：表内没有客户列时，给了 folderCustomer 即判 sufficient（旧口径必然降级 LLM）', () => {
    const rows = younaikeContract();
    const old = mapHeader(rows);
    expect(old.missingRequired).toContain('customer');
    expect(old.sufficient).toBe(false);

    const neu = mapHeader(rows, { folderCustomer: '尤耐克' });
    expect(neu.missingRequired).toEqual([]);
    expect(neu.requiredTotal).toBe(3);
    expect(neu.requiredHits).toBe(3);
    expect(neu.sufficient).toBe(true);
  });

  it('mapHeader：customer 列的缺席不再计入 requiredTotal，旧表（表内有客户列）口径不变', () => {
    const rows = normalizeMatrix([
      ['客户名称', '产品', '数量', '单价'],
      ['杭州测试客户', 'ANM 3', '2000', '4.20'],
    ]);
    const a = mapHeader(rows);
    expect(a.requiredTotal).toBe(4);
    expect(a.requiredHits).toBe(4);
    const b = mapHeader(rows, { folderCustomer: '安宝公司' });
    expect(b.requiredTotal).toBe(3);
    expect(b.requiredHits).toBe(3);
    expect(b.columns.customer).toBe(0); // 客户列仍在映射里（只是不再必填）
  });
});

describe('①d 产品列优先级（产品名称 > 产品编号）', () => {
  it('「产品编号」归 productCode，「产品名称」归 productName（不再被「产品」二字抢先）', () => {
    const m = mapHeader(younaikeContract(), { folderCustomer: '尤耐克' });
    expect(m.columns.productCode).toBe(1);
    expect(m.columns.productName).toBe(2);
    expect(m.columns.quantity).toBe(3);
    expect(m.columns.unitPrice).toBe(5);
    expect(m.productNameFromCode).toBeFalsy();
  });

  it('同字段多列：按关键词长度取列（「产品名称」压过左边的「产品」列）', () => {
    const m = mapHeader(normalizeMatrix([
      ['产品', '产品名称', '数量', '单价'],
      ['X', 'ANM 3', '10', '1.5'],
    ]));
    expect(m.columns.productName).toBe(1);
  });

  it('表里只有产品编号列时，productName 由编号列兜底（旧行为不回退）', () => {
    const m = mapHeader(normalizeMatrix([
      ['产品编号', '数量', '单价'],
      ['1C001-0001', '10', '1.5'],
    ]));
    expect(m.columns.productName).toBe(0);
    expect(m.productNameFromCode).toBe(true);
  });

  it('规则映射把产品名称与产品编号分别落到行上', () => {
    const r = ruleMapMatrix(younaikeContract(), { folderCustomer: '尤耐克' });
    expect(r.parsed.lines.map((l) => l.productName)).toEqual(['1-101 割嘴  00#', '1-101 割嘴  2#']);
    expect(r.parsed.lines.map((l) => l.productCode)).toEqual(['1C001-0001 00#', '1C001-0001 2#']);
  });
});

describe('①b 抬头区扫描器（合同编号 / 交货期限 / 供方需方）', () => {
  it('抬头区取到合同编号与供方需方；条款区补到交货期限', () => {
    const rows = younaikeContract();
    const r = ruleMapMatrix(rows, { folderCustomer: '尤耐克' });
    expect(r.headerArea.poNo).toBe('UW250307093宁波一洲');
    expect(r.headerArea.poNoSource).toBe('header');
    expect(r.headerArea.supplierName).toBe('奉化一洲焊割工具有限公司');
    expect(r.headerArea.customerName).toBe('宁波市尤耐克工具有限公司');
    expect(r.headerArea.dueDate).toBe('2025-04-23');
    expect(r.headerArea.dueDateSource).toBe('terms');
    expect(r.parsed.dueDate).toBe('2025-04-23');
  });

  it('条款正文明里的「供方/需方」二字不会被误取（标签必须在单元格开头）', () => {
    const rows = normalizeMatrix([
      ['需方：宁波市尤耐克工具有限公司', '', ''],
      ['产品名称', '数量', '单价'],
      ['PNME18 割嘴', '100', '7.9'],
      ['若供方延迟交货导致需方客户索赔、退货或要求空运，所发生的空运费用由供方承担。', '', ''],
    ]);
    const area = scanContractHeader(rows, 1, 2);
    expect(area.customerName).toBe('宁波市尤耐克工具有限公司');
    expect(area.supplierName).toBeUndefined();
  });

  it('extractDateFromText：中文年月日/斜杠/横线写法都能取到日期', () => {
    expect(extractDateFromText(' 2021年9月18日')).toBe('2021-09-18');
    expect(extractDateFromText('2025年04月23日。')).toBe('2025-04-23');
    expect(extractDateFromText('2025年09月10日之前交货。【越快越好】')).toBe('2025-09-10');
    expect(extractDateFromText('数字')).toBeUndefined();
  });

  it('一致性校验：文件夹客户与抬头需方不一致 → 给 warn 文案，不做别名归一', () => {
    expect(folderCustomerWarning('尤耐克', '宁波市尤耐克工具有限公司')).toBeUndefined();
    expect(folderCustomerWarning('安宝公司', '宁波安宝国际贸易有限公司')).toBeUndefined();
    const w = folderCustomerWarning('尤耐克', 'NINGBO UNITED TOOLS CO LTD');
    expect(w).toContain('字面不一致');
    expect(w).toContain('客户仍按文件夹口径取「尤耐克」');
    // 嵊州海田 ↔ 嵊州市威盾工具：字面无重合 → 必须提示（不擅自合并）
    expect(folderCustomerWarning('嵊州海田', '嵊州市威盾工具有限公司')).toContain('字面不一致');
    expect(normPartyName('正恒公司')).toBe('正恒');
    expect(normPartyName('宁波正恒国际贸易有限公司')).toContain('正恒');
  });
});

describe('①c 数据行终止条件（条款/大写金额/正唛/合计 等噪声行）', () => {
  it('classifyDataRow：噪声行给出原因，空行与不完整行分开判定', () => {
    const cols = { productName: 0, quantity: 1, unitPrice: 2 };
    expect(classifyDataRow(['大写金额', '1000', '', '1000'], cols).kind).toBe('noise');
    expect(classifyDataRow(['大写金额', '1000', '', '1000'], cols).reason).toBe('合计/大写金额');
    expect(classifyDataRow(['备   注：', '刻字要求'], cols).reason).toBe('备注');
    expect(classifyDataRow(['正 唛', 'MEXICO'], cols).reason).toBe('正唛/侧唛');
    expect(classifyDataRow(['四、交货时间及数量：2026年09月30日之前'], cols).reason).toBe('合同条款');
    expect(classifyDataRow(['单位盖章：', ''], cols).reason).toBe('签署/盖章栏');
    expect(classifyDataRow(['', '', ''], cols).kind).toBe('empty');
    expect(classifyDataRow(['ANM 3', '', '4.2'], cols).kind).toBe('incomplete');
    expect(classifyDataRow(['ANM 3', '10', '4.2'], cols).kind).toBe('valid');
  });

  it('安宝族：大写金额/正唛/条款行不再被当成产品行，终止原因写入诊断', () => {
    const rows = normalizeMatrix([
      ['出 口 产 品 供 需 合 同', '', '', '', '', '', '', ''],
      ['供方：奉化市一洲焊割工具有限公司', '', '', '', '', '合同编号：AB25 758', '', ''],
      ['需方：宁波安宝国际贸易有限公司', '', '', '', '', '签约时间：2025年07月30日', '', ''],
      ['产品名称、商标、厂家、规格', '', '数量', '单位', '单价/¥', '总金额/¥', '包装要求', '返单号'],
      ['割嘴3-101 00# 产品号码6017', '', '500', '只', '9.68', '4840', '', 'AB25 522'],
      ['割嘴3-101 2# 产品号码6020', '', '1000', '只', '9.68', '9680', '', 'AB25 640'],
      ['大写金额', '54252', '', '', '54252', '', '该价格为含税价', ''],
      ['正唛', 'PO64713', '', '', '', '侧唛', '', ''],
      ['二、质量要求、技术标准：', '', '', '', '', '', '', ''],
      ['四、交货时间及数量：2025年09月10日之前交货。【越快越好】', '', '', '', '', '', '', ''],
    ]);
    const r = ruleMapMatrix(rows, { folderCustomer: '安宝公司' });
    expect(r.dataRowCount).toBe(2);
    expect(r.parsed.lines.length).toBe(2);
    expect(r.parsed.lines.map((l) => l.quantity)).toEqual([500, 1000]);
    expect(r.parsed.lines.map((l) => l.unitPrice)).toEqual([9.68, 9.68]);
    expect(r.dataRows.stopReason).toBe('合计/大写金额');
    expect(r.dataRows.skipped.map((s) => s.reason)).toEqual(
      expect.arrayContaining(['合计/大写金额', '正唛/侧唛', '合同条款']),
    );
    expect(r.headerArea.customerName).toBe('宁波安宝国际贸易有限公司');
    expect(r.headerArea.poNo).toBe('AB25 758');
    expect(r.parsed.dueDate).toBe('2025-09-10');
    // 客户按文件夹口径取，抬头需方仅作一致性提示
    expect(r.parsed.customerName).toBe('安宝公司');
  });

  it('表体中间的「备注」行只跳过、不终止：后面的产品行仍然保留（UW 真实形态）', () => {
    const r = ruleMapMatrix(younaikeContract(), { folderCustomer: '尤耐克' });
    expect(r.dataRowCount).toBe(2);
    expect(r.parsed.lines.map((l) => l.quantity)).toEqual([200, 300]);
    expect(r.dataRows.skipped.some((s) => s.reason === '备注')).toBe(true);
  });

  it('无顿号条款行、合同备注行、条款正文句子都算噪声（真实合同里的另几种写法）', () => {
    const cols = { productName: 0, quantity: 1, unitPrice: 2 };
    expect(classifyDataRow(['六  包装要求：请外贸结实的纸箱包装。', '', ''], cols).reason).toBe('合同条款');
    expect(classifyDataRow(['合同备注:', '100个需要空运', '', ''], cols).reason).toBe('备注');
    expect(classifyDataRow(['若供方延迟交货导致需方客户索赔、退货或要求空运', '', ''], cols).reason).toBe('合同条款');
  });

  it('合并单元格回填出来的残缺行（产品列命中噪声行单元格）被剔除', () => {
    const rows = normalizeMatrix([
      ['产品编号', '产品名称', '数量', '单价'],
      ['1C001-0001', '1-101 割嘴 00#', '200', '13.2'],
      ['正唛：', 'ARMOUR-SHJ', '', ''],
      ['ARMOUR-SHJ', '', '', ''],
    ]);
    const r = ruleMapMatrix(rows, { folderCustomer: '尤耐克' });
    expect(r.parsed.lines.length).toBe(1);
    expect(r.dataRows.skipped.map((s) => s.reason)).toEqual(
      expect.arrayContaining(['正唛/侧唛', '合并单元格回填的噪声值']),
    );
  });

  it('表里没有单价列（.doc 计划单族）：保留残缺产品行，终止原因说明「缺数量或单价」', () => {
    const rows = normalizeMatrix([
      ['品名规格', '数量', '刻字', '包装'],
      ['6290-1AC', '200', '刻型号', '尼龙袋'],
      ['6290-2AC', '0', '', ''],
      ['6290-3AC', '300', '', ''],
    ]);
    const r = ruleMapMatrix(rows, { folderCustomer: '嵊州海田' });
    expect(r.dataRowCount).toBe(0); // 没有「数量+单价」齐全的行
    expect(r.dataRows.incomplete).toBe(3); // 3 行都有产品名，但都没有单价
    expect(r.dataRows.emittedRows).toBe(3);
    expect(r.parsed.lines.map((l) => l.quantity)).toEqual([200, 0, 300]);
    expect(r.dataRows.stopReason).toContain('缺数量或单价');
    expect(r.mapping.missingRequired).toEqual(['unitPrice']);
    expect(r.mapping.sufficient).toBe(false); // 仍会走 LLM 兜底通道（价格需人工补）
  });

  it('所有噪声行都在表体之后时，终止原因取第一个噪声行', () => {
    const r = ruleMapMatrix(younaikeContract(), { folderCustomer: '尤耐克' });
    expect(r.dataRows.afterEndRows).toBeGreaterThan(0);
    expect(r.dataRows.stopReason).toBe('合同条款');
  });
});

describe('① 端到端：parseAndResolve 走 folderCustomer（不调 LLM）', () => {
  function makeService() {
    const llm = { chat: jest.fn(), vision: jest.fn(), hasChatKey: jest.fn().mockResolvedValue(true) };
    return { svc: new OrderParserService(llm as never), llm };
  }

  it('合同表内无客户列 + folderCustomer → table-rule 直接出结果，客户名=文件夹名，0 次 LLM 调用', async () => {
    const { svc, llm } = makeService();
    const r = await svc.parseAndResolve({
      table: { rows: younaikeContract(), source: 'excel' },
      folderCustomer: '尤耐克',
    });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(r.parseSource).toBe('table-rule');
    expect(r.table?.usedLlm).toBe(false);
    expect(r.table?.requiredTotal).toBe(3);
    expect(r.table?.missingRequired).toEqual([]);
    expect(r.table?.folderCustomer).toBe('尤耐克');
    expect(r.customerName).toBe('尤耐克');
    expect(r.dueDate).toBe('2025-04-23');
    expect(r.poNo).toBe('UW250307093宁波一洲');
    expect(r.lines.length).toBe(2);
    expect(r.lines[0].quantity).toBe(200);
    expect(r.lines[0].productCode).toBe('1C001-0001 00#');
    expect(r.lines[0].amountCents).toBe(200 * 1320);
    expect(r.table?.stopReason).toBe('合同条款');
    expect(r.table?.skippedNoiseRows).toBeGreaterThan(0);
    expect(r.table?.headerArea.supplierName).toBe('奉化一洲焊割工具有限公司');
  });

  it('抬头需方与文件夹不一致 → 只给 warn 文案（不报错、不改客户名）', async () => {
    const { svc } = makeService();
    const rows = normalizeMatrix([
      ['合同编号：', 'LGC10801299', '', '需      方：', 'NINGBO UNITED TOOLS CO LTD'],
      ['产品名称', '数量', '单价'],
      ['PNME18 割嘴 1/16', '300', '7.90'],
      ['三、交货期限： 2021年9月18日'],
    ]);
    const r = await svc.parseAndResolve({ table: { rows, source: 'excel' }, folderCustomer: '尤耐克' });
    expect(r.table?.warnings.join('；')).toContain('字面不一致');
    expect(r.customerName).toBe('尤耐克');
    expect(r.notes.join('；')).toContain('字面不一致');
    // 只有「客户不在档案中」（测试库未建该客户）这类提示，不再有「未识别到客户名称」的 error
    expect(r.issues.some((i) => i.message.includes('未识别到客户名称'))).toBe(false);
  });

  it('命中率仍不足走 LLM 时，客户名同样以文件夹为准（LLM 抽的客户名被覆盖）', async () => {
    const { svc, llm } = makeService();
    llm.chat.mockResolvedValue({
      provider: 'deepseek',
      text: JSON.stringify({
        customerName: 'LLM 猜的客户',
        dueDate: '2099-01-01',
        confidence: 'high',
        notes: [],
        lines: [{ productName: 'ANM 3', quantity: 10, unitPrice: 4.2, currency: 'RMB' }],
      }),
    });
    // 缺「数量」列 → 即便给了 folderCustomer，规则映射仍不齐 → 仍走 LLM 语义映射
    const rows = [['产品', '单价'], ['ANM 3', '4.2']];
    const r = await svc.parseAndResolve({ table: { rows, source: 'csv' }, folderCustomer: '正恒公司' });
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(r.parseSource).toBe('table-llm');
    expect(r.table?.missingRequired).toEqual(['quantity']);
    expect(r.customerName).toBe('正恒公司');
  });

  it('不传 folderCustomer 时行为与改造前一致（客户列仍必填、仍走 LLM 兜底）', async () => {
    const { svc, llm } = makeService();
    llm.chat.mockResolvedValue({ provider: 'deepseek', text: 'x' });
    const rows = younaikeContract();
    const r = await svc.parseAndResolve({ table: { rows, source: 'excel' } });
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(r.table?.requiredTotal).toBe(4);
    expect(r.table?.missingRequired).toContain('customer');
  });
});

describe('①d 产品列优先级：安宝族「客户需求产品描述」表头（实测 29 份合同被 customer 抢列）', () => {
  /**
   * 安宝族「出口产品供需合同」的真实表头：产品描述列叫「客户需求产品描述」——
   * 同时含「客户」与「产品描述」二字。旧规则里 productName 的关键词只有 2 字的「产品」，
   * 与 customer 的「客户」同长且 customer 先判 → 该列被 customer 抢走，真正的产品列丢失。
   * 实测 596 份 Excel 里 29 份中招，修好后这些文件的有效产品行 +99 行、0 份变差（见交付报告）。
   */
  function anbaoContract(): string[][] {
    return normalizeMatrix([
      ['宁波安宝国际贸易有限公司购销合同', '', '', '', '', '', '', ''],
      ['供方：奉化市一洲焊割工具有限公司', '', '', '', '', '合同编号：AB21647返单AB21546', '', ''],
      ['需方：宁波安宝国际贸易有限公司', '', '', '', '', '签约时间：2021年7月26日', '', ''],
      ['一、产品名称、商标、厂家、规格、数量、金额', '', '', '', '', '', '', ''],
      ['编号', '客户需求产品描述', '数量/只', '单价/元', '金额/元', '产品图片', '图片', '侧唛品名要求'],
      ['SC-50-A-0', 'smith 丙烷割嘴 SC-50-A-0 4154 93G', '750', '12.50 ', '9375.00 ', '', '', "Smith's tipo"],
      ['SC-12-1', 'smith 乙炔割嘴 SC-12-1 4134 103G', '500', '13.50 ', '6750.00 ', '', '', "Smith's tipo"],
      ['合计大写(人民币)：壹万陆仟壹佰贰拾伍元整', '', '', '', '16125.00', '', '', '该价格为含税价'],
      ['四、交货时间及数量：2021年8月30日。', '', '', '', '', '', '', ''],
    ]);
  }

  it('mapHeader：「客户需求产品描述」列归 productName（不再被 customer 抢走），裸「编号」列归 productCode', () => {
    const m = mapHeader(anbaoContract(), { folderCustomer: '安宝公司' });
    expect(m.columns.productName).toBe(1);
    expect(m.columns.productCode).toBe(0);
    expect(m.columns.customer).toBeUndefined(); // 表内本就没有客户列（客户来自文件夹）
    expect(m.columns.quantity).toBe(2);
    expect(m.columns.unitPrice).toBe(3);
    expect(m.sufficient).toBe(true); // 3 个必填列（productName/quantity/unitPrice）齐全
  });

  it('ruleMapMatrix：产品行不再丢失，产品名与编号都取到，交期从条款区扫出', () => {
    const r = ruleMapMatrix(anbaoContract(), { folderCustomer: '安宝公司' });
    expect(r.dataRows.validRows).toBe(2);
    expect(r.dataRows.emittedRows).toBe(2);
    expect(r.parsed.lines[0].productName).toContain('smith 丙烷割嘴');
    expect(r.parsed.lines[0].productCode).toBe('SC-50-A-0');
    expect(r.parsed.lines[0].quantity).toBe(750);
    expect(r.parsed.lines[0].unitPrice).toBe(12.5);
    expect(r.parsed.lines[1].quantity).toBe(500);
    expect(r.headerArea.poNo).toBe('AB21647返单AB21546');
    expect(r.headerArea.dueDate).toBe('2021-08-30');
  });

  it('产品描述列整列留空时，行级用「编号」列兜底产品名（AB21323/AB21403 实测形态）', () => {
    const rows = normalizeMatrix([
      ['编号', '客户需求产品描述', '数量', '侧唛品名要求', '产品图片', '特殊要求', '单价（含税RMB)', '金额 （含税）'],
      ['6290-6', '', '200', 'WS62906', '', '52G', '8.5', '1700'],
      ['6290-NX-1', '', '200', 'WS6290NX1', '', '49G', '5.75', '1150'],
      ['合计', '', '', '', '', '', '2850', ''],
    ]);
    const r = ruleMapMatrix(rows, { folderCustomer: '安宝公司' });
    expect(r.mapping.columns.productName).toBe(1);
    expect(r.mapping.columns.productCode).toBe(0);
    expect(r.dataRows.validRows).toBe(2);
    expect(r.parsed.lines[0].productName).toBe('6290-6'); // 描述列为空 → 用编号兜底
    // 兜底后「名称 === 编号」，按既有口径 productCode 不重复另存（同名不冗余）
    expect(r.parsed.lines[0].productCode).toBeUndefined();
    expect(r.parsed.lines[0].quantity).toBe(200);
    expect(r.parsed.lines[0].unitPrice).toBe(8.5);
  });

  it('回归：尤耐克族「产品编号 / 产品名称」两列并存时，productName 仍取名称列（编号另存）', () => {
    const rows = normalizeMatrix([
      ['No', '产品编号', '产品名称', '数量', '单 价'],
      ['1', '1C001-0001 00#', '1-101 割嘴  00#', '200', '13.20 '],
    ]);
    const r = ruleMapMatrix(rows, { folderCustomer: '尤耐克' });
    expect(r.mapping.columns.productName).toBe(2);
    expect(r.mapping.columns.productCode).toBe(1);
    expect(r.parsed.lines[0].productName).toBe('1-101 割嘴  00#');
    expect(r.parsed.lines[0].productCode).toBe('1C001-0001 00#');
  });
});
