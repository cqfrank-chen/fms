import { Injectable, Logger } from '@nestjs/common';
import { LlmGatewayService } from './llm-gateway.service';
import type { LlmMessage } from './llm-gateway.service';

/**
 * 利润月报摘要（I12，spec §8「模板化渲染 + LLM 摘要」）：
 * - 指标/模板层确定性：数字全部来自 AccountingService.profit（SQL 结果），不经过 LLM 计算
 * - LLM 叙述层：只解释数字、不得改写/编造；mock/降级时用确定性模板兜底（同样只引用上下文数字）
 * - 数字回核：输出后程序化抽取所有数字与「允许数字集」比对，疑似幻觉标出（验收：无数字幻觉）
 */

export interface ProfitData {
  month: string;
  revenue: number;
  revenueByCustomer: Array<{ customer: string; amount: number }>;
  material: number;
  costs: { labor: number; electricity: number; gas: number; rent: number; depreciation: number; other: number };
  manufactureCost: number;
  totalCost: number;
  profit: number;
}

const COST_LABEL: Record<keyof ProfitData['costs'], string> = {
  labor: '人工', electricity: '电费', gas: '气费', rent: '房租', depreciation: '折旧', other: '其他',
};

/** 把利润数据渲染成给 LLM 的紧凑上下文（每个数字都进 allowSet，供回核） */
function renderContext(p: ProfitData, allowSet: Set<number>): string {
  const add = (n: number) => allowSet.add(Math.round(n * 100) / 100);
  add(p.revenue); add(p.material); add(p.manufactureCost); add(p.totalCost); add(p.profit);
  Object.values(p.costs).forEach(add);
  const costLines = Object.entries(p.costs)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${COST_LABEL[k as keyof ProfitData['costs']]} ${fmt(v)} 元`)
    .join('、');
  const custLines = p.revenueByCustomer.map((c) => `${c.customer} ${fmt(c.amount)} 元`).join('；') || '（本月无客户收款）';
  return [
    `月度：${p.month}`,
    `营收（收款核销，现金收付制）：${fmt(p.revenue)} 元，按客户：${custLines}`,
    `材料成本（来料登记月汇总）：${fmt(p.material)} 元`,
    `制造费用（六类手填合计）：${fmt(p.manufactureCost)} 元（${costLines || '本月未填'}）`,
    `总成本（材料+制造）：${fmt(p.totalCost)} 元`,
    `利润（营收-总成本）：${fmt(p.profit)} 元`,
  ].join('\n');
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

/** 确定性兜底摘要（mock/LLM 降级时用；只引用上下文数字，天然无幻觉） */
function fallbackSummary(p: ProfitData): string {
  const parts = [`${p.month} 经营摘要：营收 ${fmt(p.revenue)} 元，材料成本 ${fmt(p.material)} 元，制造费用 ${fmt(p.manufactureCost)} 元，总成本 ${fmt(p.totalCost)} 元，当月利润 ${fmt(p.profit)} 元。`];
  if (p.profit < 0) parts.push(`利润为负，主因是总成本 ${fmt(p.totalCost)} 元远高于当期收款确认的营收 ${fmt(p.revenue)} 元（成本按月归集、收入按收款确认，两者口径不同期）。`);
  if (p.material > 0 && p.manufactureCost > 0) {
    const bigger = p.material >= p.manufactureCost ? '材料' : '制造费用';
    parts.push(`成本构成中 ${bigger} 占比更高（材料 ${fmt(p.material)} 元 / 制造 ${fmt(p.manufactureCost)} 元）。`);
  }
  if (p.revenueByCustomer.length) {
    const top = p.revenueByCustomer[0];
    parts.push(`本月主要收款客户：${top.customer} ${fmt(top.amount)} 元。`);
  }
  parts.push('以上数字均由系统按月报表计算，请以账目页「利润月报」明细为准。');
  return parts.join(' ');
}

const SYSTEM_PROMPT = `你是工厂经营月报分析助手。用户给你一份「利润月报数据上下文」，请写一段 120 字以内的中文执行摘要。
硬性规则（违反即不合格）：
1. 只解释上下文里的数字，绝不自行计算、推算或编造任何数字；引用的每个数字必须与上下文一致（可省略，不可改动）。
2. 结构建议：一句话总览（营收/总成本/利润）→ 成本构成或客户特点 → 一两个关注点（异常/口径提示）。
3. 不写"同比增长"之类上下文没有的比较；不用模糊夸大词。
4. 若利润为负，只做客观说明（成本归集与收款确认口径不同期是常见原因，可提示），不输出"经营恶化"类臆断。`;

@Injectable()
export class ReportSummaryService {
  private readonly logger = new Logger(ReportSummaryService.name);

  constructor(private readonly llm: LlmGatewayService) {}

  /** 生成利润月报摘要 + 数字回核 */
  async summarize(p: ProfitData): Promise<{
    month: string;
    summary: string;
    provider: 'llm' | 'template';
    mock: boolean;
    check: { ok: boolean; suspicious: string[] };
  }> {
    const allowSet = new Set<number>();
    const ctx = renderContext(p, allowSet);

    let summary: string;
    let provider: 'llm' | 'template';
    let mock = false;
    if (await this.llm.hasChatKey()) {
      const messages: LlmMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `[利润月报数据]\n${ctx}\n[END]\n请输出执行摘要。` },
      ];
      const r = await this.llm.chat(messages, { temperature: 0.2 });
      summary = r.text.trim();
      provider = 'llm';
      mock = !!r.mock;
    } else {
      summary = fallbackSummary(p);
      provider = 'template';
      mock = true;
    }
    const check = verifyNumbers(summary, allowSet);
    return { month: p.month, summary, provider, mock, check };
  }
}

/** 数字回核：摘要中每个数字必须命中「允许数字集」；否则标疑似幻觉 */
export function verifyNumbers(text: string, allowSet: Set<number>): { ok: boolean; suspicious: string[] } {
  const re = /(?<![\d.])(-?\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?(?![\d.])/g;
  const suspicious: string[] = [];
  const allow = (n: number) => [...allowSet].some((a) => Math.abs(a - n) < 0.021);
  for (const m of text.matchAll(re)) {
    const n = parseFloat(m[0].replace(/,/g, ''));
    if (Number.isNaN(n)) continue;
    if (n >= 1900 && n <= 2199 && !m[0].includes('.')) continue; // 年份/单号
    if (n >= 1 && n <= 31 && !m[0].includes('.') && !m[0].includes('-')) continue; // 日期号/序号（如月份 MM）
    if (allow(n)) continue;
    suspicious.push(m[0]);
  }
  return { ok: suspicious.length === 0, suspicious };
}
