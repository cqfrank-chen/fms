import { Injectable, Logger, Optional } from '@nestjs/common';
import { db } from '../db';
import { customers, products } from '../db/schema';
import { fromCents, lineCents, sumLineCents } from '../common/money';
import { LlmGatewayService } from './llm-gateway.service';
import type { LlmMessage } from './llm-gateway.service';
import { matrixToCompactText, ruleMapMatrix, sameProductDigits } from './table-parser.service';
import { findProductCandidates } from './product-model';
import type { HeaderArea, RuleMapResult } from './table-parser.service';
import { QuotesService } from '../quotes/quotes.service';
import { describeHit } from '../quotes/quote-pricing';
import { normalizeCurrency } from '../common/currency';
import type { PriceHit, PriceRule } from '../quotes/quote-pricing';

/**
 * 订单解析（I12 核心）：多模态/文本 → 结构化抽取 → 确定性规则校验 → 主数据匹配
 * → 低置信标红 → 人工确认（直通判定 directPass 供验收与「一键确认」）。
 *
 * 架构（调研 02-ai-integration §2.2）：LLM 直出 + JSON Schema 约束（json:true 强制）+ 规则兜底。
 * 确定性为骨：数值/日期/匹配规则全部代码执行，不经 LLM；LLM 只做语义抽取。
 */

// ============ 契约 ============

export interface ParsedOrderLine {
  productName: string;
  /** 产品编号（表内「产品编号/货号」列）：产品名称优先，编号另存，便于人工回溯与建档 */
  productCode?: string;
  quantity?: number;
  unitPrice?: number;
  /** 币种：甲方裁定统一归一为 CNY / USD（RMB / ￥ / 人民币 等写法一律归一到 CNY，见 common/currency.ts） */
  currency?: 'CNY' | 'USD';
  engraving?: string;
  packagingText?: string; // 包装要求原文 → 规则转 PackagingSpec
}

export interface ParsedOrder {
  customerName: string;
  poNo?: string;
  dueDate?: string; // YYYY-MM-DD
  note?: string;
  lines: ParsedOrderLine[];
  confidence: 'high' | 'low';
  notes: string[];
}

export interface Issue {
  path: string; // 如 customer / lines[0].product
  level: 'error' | 'warn';
  message: string;
}

export interface ResolvedLine extends ParsedOrderLine {
  productId: number | null;
  match: 'exact' | 'none';
  packaging?: Record<string, string>; // packTextToSpec 转换结果
  issues: Issue[];
  /** 行金额（分）：数量 × 单价，按 common/money 定点计算（金额一律以「分」为准） */
  amountCents: number;
  /** 单价来源（I17）：'quote' = 该行缺价，由报价记录自动补全（来源可追溯）；缺省 = 原始单据自带 */
  priceFrom?: 'quote';
  /** 命中的报价记录 id 与规则（priceFrom='quote' 时给出，便于人工回溯到具体报价单） */
  quoteId?: number;
  quoteRule?: PriceRule;
  quoteRuleText?: string;
}

export interface ResolveResult {
  customerId: number | null;
  customerName: string;
  customerMatch: 'exact' | 'none';
  poNo?: string;
  dueDate?: string;
  note?: string;
  lines: ResolvedLine[];
  issues: Issue[];
  confidence: 'high' | 'low';
  notes: string[];
  /** 直通：无 error 且客户/全部产品都精确匹配 → 可一键确认（验收口径 ≥70%） */
  directPass: boolean;
  /** 订单合计金额（分）：各行 amountCents 之和 */
  totalCents: number;
  /** 实际使用的解析通道（便于前端/接口自测断言分支是否正确） */
  parseSource: ParseSource;
  /** 报价自动补价的行数（I17：缺 unitPrice 的行按报价记录补价；0 = 未补价或无可命中报价） */
  quoteFilledCount: number;
  /** 表格映射诊断（仅 Excel/CSV 输入有值：命中率/缺失列/是否走了 LLM 兜底/数据行边界/抬头区） */
  table?: {
    headerRowIndex: number;
    hitRate: number;
    requiredHits: number;
    /** 本次口径的关键列总数（给了 folderCustomer → 3：客户列不再必填） */
    requiredTotal: number;
    missingRequired: string[];
    dataRowCount: number;
    usedLlm: boolean;
    /** 数据行终止原因（合计/大写金额/正唛/备注/合同条款/表尾） */
    stopReason: string;
    /** 被跳过的非产品行数（含条款/大写金额/正唛/空行） */
    skippedNoiseRows: number;
    /** 实际输出的产品行数（含缺数量/单价的残缺行） */
    emittedRows: number;
    /** 抬头区 + 条款区扫描结果（合同编号/供方/需方/交货期限） */
    headerArea: HeaderArea;
    /** productName 由产品编号列兜底（表里没有产品名称列） */
    productNameFromCode: boolean;
    /** 客户由文件所属文件夹决定（甲方裁定「文件夹=客户」） */
    folderCustomer?: string;
    /** 口径校验提示（如抬头需方与文件夹客户不一致）：只提示，不阻断 */
    warnings: string[];
  };
}

/** 解析通道：文本 / 图片（vision）/ 表格规则映射 / 表格 LLM 兜底映射 / 测试直通 */
export type ParseSource = 'text' | 'image' | 'table-rule' | 'table-llm' | 'stub';

const SYSTEM_PROMPT = `你是工厂订单录入助手，把客户发来的订单（邮件/Excel文本/图片）抽取为 JSON。
硬性要求：只输出 JSON，不输出任何多余文字。
字段结构（缺失的字段用 null 或省略，不要编造）：
{
  "customerName": "客户公司名（原文）",
  "poNo": "客户PO号",
  "dueDate": "YYYY-MM-DD",
  "note": "备注",
  "confidence": "high|low",
  "notes": ["不确定点，中文短句"],
  "lines": [{
    "productName": "产品型号（保留原文如 ANM 3 / PNM 1/32 / 6290 / 101，不要改写或加注释）",
    "quantity": 数量数字,
    "unitPrice": 单价数字,
    "currency": "CNY|USD（未标明币种时按单据语境推断；人民币一律写 CNY，仍拿不准填 CNY）",
    "engraving": "刻字需求（无则空串）",
    "packagingText": "包装要求原文整段（无则空串）"
  }]
}
抽取规则：
1. 产品行一条条拆开，不要合并；数量单位通常是"只/个/pcs"，剥离单位只留数字。
2. 若某行缺关键信息（数量或型号），把该行抽出来但字段留空，并在 notes 里说明。
3. 单据字迹不清/信息矛盾/疑似缺页 → confidence="low" 并说明。
4. 若内容完全不是订单（如说明书/报价表闲聊），lines 给空数组、confidence="low"、notes=["无法识别为订单"]。
5. 金额四舍五入保留 2 位小数。`;

const VISION_PROMPT = `${SYSTEM_PROMPT}\n注意：这是一张订单图片（可能是客户微信传单/拍照/扫描件），请仔细阅读图中全部行项目与数值。`;

/**
 * 表格（Excel/CSV）语义映射提示词：与图片识别**共用同一 JSON schema**（SYSTEM_PROMPT 的字段结构），
 * 仅追加「表格形态」的说明与严格输出约束，保证下游 resolve() 无需分支处理两种来源。
 */
const TABLE_PROMPT = `${SYSTEM_PROMPT}

注意：输入是客户订单表格的**逐行紧凑文本**（R1/R2… 为行号，" | " 为列分隔符，通常第一行是表头）。
表格之外可能还有邮件正文线索（[上下文线索]），客户名/交期可能只出现在线索里，请一并利用。
严格输出约束（硬性）：
1. 只输出一个 JSON 对象，不要 markdown 代码块、不要解释文字；
2. 顶层键固定为 customerName / poNo / dueDate / note / confidence / notes / lines，不要增删键；
3. lines 必须是数组，表格里每一条产品行对应一个元素，保持原有行序与行数，不要合并或去重；
4. 数量/单价输出纯数字（去掉千分位、货币符号与"只/个/pcs"等单位和括号内备注）；
5. dueDate 输出 YYYY-MM-DD；表格里是"9/30/2026"这类写法也要归一化；
6. 表格里的合计行/小计行/空行不要当产品行输出。`;

/** 包装要求原文 → 复合包装规格（box/bag/carton/label）。
 *  短语级分类：按空格/标点切短语，逐短语打标签；"纸箱"短语含"盒"视为纸箱子描述（不重复归 box）；
 *  未命中任何类的短语进 residual 提示人工核对。 */
export function packTextToSpec(text?: string): { packaging?: Record<string, string>; residual?: string } {
  if (!text) return {};
  const packaging: Record<string, string> = {};
  const parts = text.split(/[\s,，。;；、]+/).filter(Boolean);
  const residual: string[] = [];
  for (const ph of parts) {
    const isCarton = /纸箱|carton/i.test(ph);
    const isLabel = /不干胶|(?<![a-z])label/i.test(ph);
    const isBag = /袋|(?<![a-z])bag/i.test(ph);
    const isBox = /盒|(?<![a-z])box/i.test(ph);
    const hits: string[] = [];
    if (isCarton) hits.push('carton');
    if (isLabel) hits.push('label');
    if (isBag) hits.push('bag');
    if (isBox && !isCarton) hits.push('box'); // 纸箱短语里的"盒"是子描述，不重复归类
    if (!hits.length) { residual.push(ph); continue; }
    for (const t of hits) packaging[t] = packaging[t] ? `${packaging[t]} ${ph}` : ph;
  }
  return {
    packaging: Object.keys(packaging).length ? packaging : undefined,
    residual: residual.length ? residual.join(' ') : undefined,
  };
}

/** 名称归一化：小写/去空格/去常见公司后缀（用于模糊匹配）；也供订单落草稿的客户/产品建档比对复用 */
export const normName = (s: string) =>
  s.toLowerCase().replace(/\s+/g, '').replace(/(公司|有限公司|co\.?|ltd\.?|inc\.?|llc|gmbh)$/g, '');

@Injectable()
export class OrderParserService {
  private readonly logger = new Logger(OrderParserService.name);

  /** quotes 可选：单测里直接 new OrderParserService(llm) 时不做报价补价（行为与改造前一致） */
  constructor(
    private readonly llm: LlmGatewayService,
    @Optional() private readonly quotes?: QuotesService,
  ) {}

  /** 主入口：文本 / 图片(dataURL) / 表格矩阵 → 解析 + 规则校验 + 主数据匹配
   *  stub：仅 mock（未配 AI_API_KEY）时用于验收/离线测试直通 LLM 输出；真 key 环境忽略
   *
   *  表格分支（Excel/CSV）：先做**规则映射**（表头关键词命中客户/产品/数量/单价四列 → 直接出结果，不调 LLM）；
   *  命中率不足才把表格前 N 行转紧凑文本交给 LLM 做语义映射（严格 JSON schema，与图片结果同构）。 */
  async parseAndResolve(input: {
    text?: string;
    image?: string;
    /** 表格矩阵（Excel/CSV 解析产物） */
    table?: { rows: string[][]; source?: 'excel' | 'csv' };
    /**
     * 文件所属的顶层客户文件夹名（甲方裁定：**以文件夹为识别主体，同一文件夹内的都是同一家**）。
     * 给出后：客户直接取该文件夹名，表内不再要求客户列/需方行；若抬头区扫到需方，仅做一致性 warn。
     */
    folderCustomer?: string;
    /** 附加线索（随表格一起提交的文本，如客户邮件原文/粘贴的说明），仅在表格命中率不足时随表格一起喂给 LLM */
    hint?: string;
    stub?: ParsedOrder;
    /**
     * 是否用报价记录补价（I17，默认 true）。**向后兼容**：库里没有可命中的报价时结果与改造前完全一致；
     * 显式传 false 可关闭（离线复现旧口径用）。
     */
    quotePricing?: boolean;
  }): Promise<ResolveResult> {
    let parsed: ParsedOrder;
    let parseSource: ParseSource = 'text';
    let tableDiag: ResolveResult['table'];

    if (input.stub && !(await this.llm.hasChatKey())) {
      parsed = input.stub;
      parseSource = 'stub';
    } else if (input.image) {
      parsed = await this.visionParse(input.image);
      parseSource = 'image';
    } else if (input.table?.rows?.length) {
      const folder = input.folderCustomer?.trim() || undefined;
      // 客户由文件夹决定：customer 不再计入必填列（见 requiredTableFields）
      const rule: RuleMapResult = ruleMapMatrix(input.table.rows, { folderCustomer: folder });
      let usedLlm = false;
      if (rule.mapping.sufficient && rule.dataRowCount > 0) {
        parsed = rule.parsed; // 规则映射命中齐全：完全不调 LLM（可复现、离线可用）
      } else {
        usedLlm = true;
        parsed = await this.tableLlmParse(input.table.rows, input.hint, rule, folder);
        if (!parsed.lines.length && rule.parsed.lines.length) {
          // LLM 兜底也没出产品行 → 退回规则映射（至少人工能在预览里修正）
          parsed = { ...rule.parsed, notes: [...rule.parsed.notes, 'AI 语义映射未识别出产品行，已回退表头规则映射结果'] };
        }
      }
      // 甲方裁定「文件夹=客户」：客户名**一律以文件夹为准**（LLM 抽到的客户名同样被覆盖），
      // 抬头区扫到的「需方」只做一致性校验（不一致给 warning，不报错）。
      if (folder) {
        parsed = { ...parsed, customerName: folder, notes: [...(parsed.notes ?? []), ...rule.warnings] };
      } else if (rule.warnings.length) {
        parsed = { ...parsed, notes: [...(parsed.notes ?? []), ...rule.warnings] };
      }
      parseSource = usedLlm ? 'table-llm' : 'table-rule';
      tableDiag = {
        headerRowIndex: rule.mapping.headerRowIndex,
        hitRate: rule.mapping.hitRate,
        requiredHits: rule.mapping.requiredHits,
        requiredTotal: rule.mapping.requiredTotal,
        missingRequired: rule.mapping.missingRequired as string[],
        dataRowCount: rule.dataRowCount,
        usedLlm,
        stopReason: rule.dataRows.stopReason,
        skippedNoiseRows: rule.dataRows.skipped.length,
        emittedRows: rule.dataRows.emittedRows,
        headerArea: rule.headerArea,
        productNameFromCode: !!rule.mapping.productNameFromCode,
        folderCustomer: folder,
        warnings: rule.warnings,
      };
    } else {
      parsed = await this.textParse(input.text ?? '');
      parseSource = 'text';
    }

    const resolved = await this.resolve(parsed, parseSource, { quotePricing: input.quotePricing });
    return { ...resolved, table: tableDiag };
  }

  /** 表格 → LLM 语义映射（命中率不足时）：紧凑文本 + 上下文线索，要求严格 JSON（与图片结构一致） */
  private async tableLlmParse(rows: string[][], hint: string | undefined, rule: RuleMapResult, folderCustomer?: string): Promise<ParsedOrder> {
    const compact = matrixToCompactText(rows, 40);
    const head = '表头规则映射命中率 ' + rule.mapping.requiredHits + '/' + rule.mapping.requiredTotal
      + (rule.mapping.missingRequired.length ? '，缺失列：' + rule.mapping.missingRequired.join('、') : '') + '。'
      + (folderCustomer ? '客户已由「文件所属文件夹」确定为「' + folderCustomer + '」，不要从表内另取客户名。' : '')
      + (rule.headerArea.matches.length ? '抬头区已抽取：' + rule.headerArea.matches.join('；') + '。' : '');
    const user = '[订单表格逐行文本]\n' + compact + '\n[表格结束]\n'
      + (hint ? '[上下文线索]\n' + hint.slice(0, 2000) + '\n[线索结束]\n' : '')
      + '[提示]' + head;
    const messages: LlmMessage[] = [
      { role: 'system', content: TABLE_PROMPT },
      { role: 'user', content: user },
    ];
    const r = await this.llm.chat(messages, { json: true });
    return this.safeParse(r.text);
  }

  private async textParse(text: string): Promise<ParsedOrder> {
    const messages: LlmMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `[订单原文]\n${text.slice(0, 8000)}\n[END]` },
    ];
    const r = await this.llm.chat(messages, { json: true });
    return this.safeParse(r.text);
  }

  private async visionParse(imageDataUrl: string): Promise<ParsedOrder> {
    const r = await this.llm.vision([imageDataUrl], VISION_PROMPT, { json: true });
    return this.safeParse(r.text);
  }

  private safeParse(raw: string): ParsedOrder {
    try {
      const obj = JSON.parse(raw) as ParsedOrder;
      const lines = Array.isArray(obj.lines) ? obj.lines : [];
      return {
        customerName: typeof obj.customerName === 'string' ? obj.customerName : '',
        poNo: obj.poNo || undefined,
        dueDate: obj.dueDate || undefined,
        note: obj.note || undefined,
        lines,
        confidence: obj.confidence === 'low' ? 'low' : 'high',
        notes: Array.isArray(obj.notes) ? obj.notes.map(String) : [],
      };
    } catch (e) {
      this.logger.warn(`LLM JSON 解析失败，降级 low 置信: ${(e as Error).message}`);
      return { customerName: '', lines: [], confidence: 'low', notes: ['AI 输出无法解析，请人工录入'] };
    }
  }

  /** 确定性校验 + 主数据匹配（学习闭环的规则热追加点）；parseSource 由调用方按实际通道传入。 */
  async resolve(parsed: ParsedOrder, parseSource: ParseSource = 'text', opts: { quotePricing?: boolean } = {}): Promise<ResolveResult> {
    const issues: Issue[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // ---- 客户匹配 ----
    let customerId: number | null = null;
    let customerMatch: 'exact' | 'none' = 'none';
    let customerName = parsed.customerName?.trim() ?? '';
    if (!customerName) {
      issues.push({ path: 'customer', level: 'error', message: '未识别到客户名称' });
    } else {
      const all = await db.select({ id: customers.id, name: customers.name }).from(customers);
      const nn = normName(customerName);
      const exact = all.find((c) => c.name.trim() === customerName);
      if (exact) {
        customerId = exact.id;
        customerMatch = 'exact';
      } else {
        const cands = all.filter((c) => nn && (nn.includes(normName(c.name)) || normName(c.name).includes(nn)));
        if (cands.length === 1) {
          customerId = cands[0].id;
          customerMatch = 'exact';
          customerName = cands[0].name;
        } else if (cands.length > 1) {
          issues.push({ path: 'customer', level: 'warn', message: `客户「${customerName}」匹配到多个档案，请选择（候选：${cands.map((c) => c.name).join('、')}）` });
        } else {
          issues.push({ path: 'customer', level: 'error', message: `客户「${customerName}」不在档案中，请在确认前先建档或改选` });
        }
      }
    }

    // ---- 交期校验 ----
    let dueDate = parsed.dueDate;
    if (!dueDate) {
      issues.push({ path: 'dueDate', level: 'error', message: '未识别到交期' });
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(new Date(dueDate).getTime())) {
      issues.push({ path: 'dueDate', level: 'error', message: `交期「${dueDate}」不是合法日期` });
      dueDate = undefined;
    } else if (new Date(dueDate) < today) {
      issues.push({ path: 'dueDate', level: 'error', message: `交期 ${dueDate} 早于今天，请确认` });
    }

    // ---- 第一遍：产品行匹配（先定 productId，报价补价才能按「客户+产品」精确取价） ----
    const allProducts = await db.select({ id: products.id, name: products.name }).from(products);
    if (!parsed.lines.length) {
      issues.push({ path: 'lines', level: 'error', message: '未识别到任何产品行' });
    }
    const lineMeta = parsed.lines.map((l) => {
      const name = l.productName?.trim() ?? '';
      let productId: number | null = null;
      let match: 'exact' | 'none' = 'none';
      let productIssue: Issue | null = null;
      if (!name) {
        productIssue = { path: '', level: 'error', message: '行缺少产品型号' };
      } else {
        // 产品档案候选（唯一权威选法，见 ai/product-model.ts findProductCandidates）：
        //   ① 名称完全相同 → ② **基础型号 + size 相同**（甲方规则：品牌前缀差异忽略、size 逐字符一致）
        //   → ③ 子串容错（必须带数字指纹守卫）。多候选一律**不自动选**，交人工（宁缺勿错）。
        const found = findProductCandidates(name, allProducts, { sameDigits: sameProductDigits, normName });
        const pick = found.kind === 'exact' && found.hits.length ? found.hits[0] : (found.hits.length === 1 ? found.hits[0] : null);
        if (pick) {
          productId = pick.id;
          match = 'exact';
        } else {
          productIssue = {
            path: '',
            level: 'error',
            message: found.hits.length > 1
              ? `「${name}」匹配到多个产品（${found.hits.slice(0, 3).map((p) => p.name).join('、')}…），请选择`
              : `产品「${name}」不在目录中（请先到设置建档或改选）`,
          };
        }
      }
      return { name, productId, match, productIssue };
    });

    // ---- 第二遍：缺价行按「报价记录」补价（I17） ----
    // 规则：按「文件夹客户 + 该行产品」取价（客户+产品 > 客户+产品名文本 > 通用价），
    // 命中则补价并标注 priceFrom='quote'（来源可追溯）；未命中**保持缺价待补**，绝不编造价格。
    const quoteHits: Array<PriceHit | null> = new Array(parsed.lines.length).fill(null);
    const quoteNotes: string[] = [];
    if (opts.quotePricing !== false && this.quotes) {
      const needIdx = parsed.lines
        .map((l, i) => ({ l, i }))
        .filter((x) => x.l.unitPrice === undefined || x.l.unitPrice === null)
        .map((x) => x.i);
      if (needIdx.length) {
        try {
          const hits = await this.quotes.lookupMany(needIdx.map((i) => ({
            customerId,
            productId: lineMeta[i].productId,
            productName: lineMeta[i].name || null,
          })));
          needIdx.forEach((i, k) => {
            const h = hits[k];
            if (!h) return;
            quoteHits[i] = h; // 命中：补价 + 标注来源（第 3 遍装配行时写入）
            quoteNotes.push('第 ' + (i + 1) + ' 行「' + (lineMeta[i].name || '未命名') + '」缺单价，已按报价记录补价：' + describeHit(h));
          });
        } catch (e) {
          // 报价取价失败不阻断识单：如实告警并保持缺价待补（人工补填）
          quoteNotes.push('报价取价失败，本单按缺价处理：' + (e as Error).message);
        }
      }
    }

    // ---- 第三遍：装配行（问题顺序与改造前完全一致：产品 → 数量 → 单价 → 包装） ----
    const lines: ResolvedLine[] = [];
    parsed.lines.forEach((l, i) => {
      const lineIssues: Issue[] = [];
      const { name, productId, match, productIssue } = lineMeta[i];
      if (productIssue) lineIssues.push({ ...productIssue, path: `lines[${i}].product` });
      if (!l.quantity || l.quantity <= 0) {
        lineIssues.push({ path: `lines[${i}].quantity`, level: 'error', message: '行缺少有效数量' });
      }
      const hit = quoteHits[i];
      // 报价补价后的单价/币种（未命中时保持原值 —— 缺价仍标 error 待补）
      const unitPrice = hit ? fromCents(hit.unitPriceCents) : l.unitPrice;
      // 币种：报价命中按报价币种归一；单据自带 / LLM 返回的写法也统一归一到 CNY / USD（甲方裁定）
      const currency = normalizeCurrency(hit ? hit.currency : l.currency);
      if (unitPrice === undefined || unitPrice === null || unitPrice < 0) {
        lineIssues.push({ path: `lines[${i}].unitPrice`, level: 'error', message: '未识别到单价（须人工补填价格）' });
      }
      const { packaging, residual } = packTextToSpec(l.packagingText);
      if (residual) {
        lineIssues.push({ path: `lines[${i}].packaging`, level: 'warn', message: `包装描述有未归类片段：「${residual}」，请核对` });
      }
      lines.push({
        productName: name,
        productCode: l.productCode || undefined,
        productId,
        match,
        quantity: l.quantity,
        unitPrice,
        currency,
        engraving: l.engraving || undefined,
        packagingText: l.packagingText,
        packaging,
        issues: lineIssues,
        // 行金额（分）：定点计算，避免浮点尾差（金额口径统一走 common/money）
        amountCents: l.quantity && unitPrice !== undefined && unitPrice !== null
          ? lineCents(l.quantity, unitPrice)
          : 0,
        ...(hit ? { priceFrom: 'quote' as const, quoteId: hit.quoteId, quoteRule: hit.rule, quoteRuleText: hit.ruleText } : {}),
      });
    });

    const allIssues = [...issues, ...lines.flatMap((l) => l.issues)];
    const hasError = allIssues.some((i) => i.level === 'error');
    const directPass = !hasError && !!customerId && lines.length > 0 && lines.every((l) => l.productId != null && l.quantity && l.quantity > 0);
    // 订单合计（分）：与前端展示/落库口径一致（各行 amountCents 已定点）
    const totalCents = sumLineCents(lines.map((l) => ({ quantity: l.quantity ?? 0, unitPrice: l.unitPrice ?? 0 })));
    const quoteFilledCount = quoteHits.filter((h) => !!h).length;
    return {
      customerId, customerName, customerMatch,
      poNo: parsed.poNo, dueDate, note: parsed.note,
      lines,
      issues: allIssues,
      confidence: hasError ? 'low' : parsed.confidence,
      notes: [...(parsed.notes ?? []), ...quoteNotes],
      directPass,
      totalCents,
      parseSource,
      quoteFilledCount,
    };
  }
}
