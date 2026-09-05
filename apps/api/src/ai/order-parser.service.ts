import { Injectable, Logger } from '@nestjs/common';
import { db } from '../db';
import { customers, products } from '../db/schema';
import { LlmGatewayService } from './llm-gateway.service';
import type { LlmMessage } from './llm-gateway.service';

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
  quantity?: number;
  unitPrice?: number;
  currency?: 'RMB' | 'USD';
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
}

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
    "currency": "RMB|USD（未标明币种时按单据语境推断，仍拿不准填 RMB）",
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

/** 名称归一化：小写/去空格/去常见公司后缀（用于模糊匹配） */
const normName = (s: string) =>
  s.toLowerCase().replace(/\s+/g, '').replace(/(公司|有限公司|co\.?|ltd\.?|inc\.?|llc|gmbh)$/g, '');

@Injectable()
export class OrderParserService {
  private readonly logger = new Logger(OrderParserService.name);

  constructor(private readonly llm: LlmGatewayService) {}

  /** 主入口：文本 或 图片(dataURL) → 解析 + 规则校验 + 主数据匹配
   *  stub：仅 mock（未配 AI_API_KEY）时用于验收/离线测试直通 LLM 输出；真 key 环境忽略 */
  async parseAndResolve(input: { text?: string; image?: string; stub?: ParsedOrder }): Promise<ResolveResult> {
    let parsed: ParsedOrder;
    if (input.stub && !this.llm.live) parsed = input.stub;
    else if (input.image) parsed = await this.visionParse(input.image);
    else parsed = await this.textParse(input.text ?? '');
    return this.resolve(parsed);
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

  /** 确定性校验 + 主数据匹配（纯函数可测；学习闭环的规则热追加点） */
  async resolve(parsed: ParsedOrder): Promise<ResolveResult> {
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

    // ---- 产品行匹配 + 行校验 ----
    const allProducts = await db.select({ id: products.id, name: products.name }).from(products);
    const lines: ResolvedLine[] = [];
    if (!parsed.lines.length) {
      issues.push({ path: 'lines', level: 'error', message: '未识别到任何产品行' });
    }
    parsed.lines.forEach((l, i) => {
      const lineIssues: Issue[] = [];
      const name = l.productName?.trim() ?? '';
      let productId: number | null = null;
      let match: 'exact' | 'none' = 'none';
      if (!name) {
        lineIssues.push({ path: `lines[${i}].product`, level: 'error', message: '行缺少产品型号' });
      } else {
        const exact = allProducts.find((p) => p.name.trim() === name);
        if (exact) {
          productId = exact.id;
          match = 'exact';
        } else {
          const nn = normName(name);
          const cands = allProducts.filter((p) => nn && (nn.includes(normName(p.name)) || normName(p.name).includes(nn)));
          if (cands.length === 1) {
            productId = cands[0].id;
            match = 'exact';
          } else {
            lineIssues.push({
              path: `lines[${i}].product`,
              level: 'error',
              message: cands.length > 1
                ? `「${name}」匹配到多个产品（${cands.slice(0, 3).map((p) => p.name).join('、')}…），请选择`
                : `产品「${name}」不在目录中（请先到设置建档或改选）`,
            });
          }
        }
      }
      if (!l.quantity || l.quantity <= 0) {
        lineIssues.push({ path: `lines[${i}].quantity`, level: 'error', message: '行缺少有效数量' });
      }
      if (l.unitPrice === undefined || l.unitPrice === null || l.unitPrice < 0) {
        lineIssues.push({ path: `lines[${i}].unitPrice`, level: 'error', message: '未识别到单价（须人工补填价格）' });
      }
      const { packaging, residual } = packTextToSpec(l.packagingText);
      if (residual) {
        lineIssues.push({ path: `lines[${i}].packaging`, level: 'warn', message: `包装描述有未归类片段：「${residual}」，请核对` });
      }
      lines.push({
        productName: name,
        productId,
        match,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        currency: l.currency,
        engraving: l.engraving || undefined,
        packagingText: l.packagingText,
        packaging,
        issues: lineIssues,
      });
    });

    const allIssues = [...issues, ...lines.flatMap((l) => l.issues)];
    const hasError = allIssues.some((i) => i.level === 'error');
    const directPass = !hasError && !!customerId && lines.length > 0 && lines.every((l) => l.productId != null && l.quantity && l.quantity > 0);
    return {
      customerId, customerName, customerMatch,
      poNo: parsed.poNo, dueDate, note: parsed.note,
      lines,
      issues: allIssues,
      confidence: hasError ? 'low' : parsed.confidence,
      notes: parsed.notes,
      directPass,
    };
  }
}
