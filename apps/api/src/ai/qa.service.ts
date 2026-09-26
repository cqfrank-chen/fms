import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { AccountingService } from '../accounting/accounting.service';
import { db } from '../db';
import {
  customers, inventory, orders, planSheets, products, receivables, workCenters,
} from '../db/schema';
import { SchedulingService } from '../scheduling/scheduling.service';
import { LlmGatewayService } from './llm-gateway.service';
import type { LlmMessage, LlmToolDef } from './llm-gateway.service';

/**
 * 自然语言查数（I12 一期，spec §8）：function calling —— LLM 只选工具填参、不见 schema；
 * 后端执行参数化查询，结果 100% 确定。一期 8 个工具覆盖订单/库存/账款/排期四域。
 * mock（无 key）：确定性关键词路由兜底，选同一套工具执行，保证离线可演示、口径一致可测。
 */

/** 工具定义辅助：name|description 合写，参数全部 optional */
const def = (nameDesc: string, props: Record<string, { type: string; description: string }> = {}) => {
  const [name, description] = nameDesc.split('|');
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties: props } },
  } as LlmToolDef;
};

/** 查数工具注册表（四域 8 个；参数化查询，LLM 缺参走默认/全量） */
export const QA_TOOLS: LlmToolDef[] = [
  def('query_profit|查询某月利润月报（营收/材料成本/制造费用/总成本/利润）', {
    month: { type: 'string', description: 'YYYY-MM；缺省=本月' },
  }),
  def('query_receivables|查询应收往来（带客户筛选或只看已逾期）', {
    customer: { type: 'string', description: '客户名关键字' },
    overdueOnly: { type: 'string', description: '"true" 只看逾期，缺省全部' },
  }),
  def('query_inventory|查询成品库存（带产品名筛选或只看低于安全库存）', {
    product: { type: 'string', description: '产品名关键字' },
    lowOnly: { type: 'string', description: '"true" 只看低于安全库存，缺省全部' },
  }),
  def('query_orders|查询订单（可按客户/状态/月份筛选）', {
    customer: { type: 'string', description: '客户名关键字' },
    status: { type: 'string', description: 'draft/confirmed/production/completed/cancelled' },
    month: { type: 'string', description: '下单月 YYYY-MM' },
  }),
  def('query_schedule|查询排程任务（可按计划单号筛选或只看超期）', {
    planNo: { type: 'string', description: '计划单号关键字' },
    overdueOnly: { type: 'string', description: '"true" 只看超期，缺省全部' },
  }),
  def('query_customers|查客户档案列表', {
    kw: { type: 'string', description: '名称关键字' },
  }),
  def('query_processes|查工序产能池（工作中心/设备数）', {}),
  def('query_plan_sheets|查计划单列表（可按状态）', {
    status: { type: 'string', description: 'draft/confirmed/production/completed/voided' },
  }),
];

type Executor = (args: Record<string, string>) => Promise<string>;

@Injectable()
export class QaService {
  private readonly logger = new Logger(QaService.name);

  constructor(
    private readonly llm: LlmGatewayService,
    private readonly accounting: AccountingService,
    private readonly sched: SchedulingService,
  ) {}

  private async exec(name: string, args: Record<string, string>): Promise<string> {
    const fns: Record<string, Executor> = {
      query_profit: async (a) => {
        const month = a.month ?? this.currentMonth();
        const p = await this.accounting.profit(month);
        return `[利润月报 ${month}] 营收 ${p.revenue} 元；材料成本 ${p.material}；制造费用 ${p.manufactureCost}（人工${p.costs.labor}/电${p.costs.electricity}/气${p.costs.gas}/房租${p.costs.rent}/折旧${p.costs.depreciation}/其他${p.costs.other}）；总成本 ${p.totalCost}；利润 ${p.profit} 元。按客户：${p.revenueByCustomer.map((c) => `${c.customer} ${c.amount}`).join('、') || '无'}`;
      },
      query_receivables: async (a) => {
        const rows = await this.accounting.receivablesList();
        const today = new Date();
        const items = rows.filter((r: any) => {
          if (a.customer && !String(r.customerName ?? '').includes(a.customer)) return false;
          const owing = Number(r.amount) - Number(r.settledAmount);
          if (a.overdueOnly === 'true') {
            return owing > 0.005 && r.dueDate && new Date(r.dueDate) < today && r.status !== 'voided';
          }
          return r.status !== 'voided' && owing > 0.005;
        });
        if (!items.length) return '（无匹配应收）';
        return items.map((r: any) => {
          const owing = Number(r.amount) - Number(r.settledAmount);
          const od = r.dueDate && new Date(r.dueDate) < today ? '（已逾期）' : '';
          return `${r.recvNo} ${r.customerName} 应收${Number(r.amount).toFixed(2)} 未收${owing.toFixed(2)} ${r.currency} 到期${r.dueDate ? new Date(r.dueDate).toISOString().slice(0, 10) : '—'}${od}`;
        }).join('\n');
      },
      query_inventory: async (a) => {
        const rows = await db
          .select({
            productId: products.id, name: products.name, safetyStock: products.safetyStock,
            current: sql<number>`coalesce(sum(${inventory.quantity}),0)::int`,
          })
          .from(products)
          .leftJoin(inventory, eq(inventory.productId, products.id))
          .groupBy(products.id);
        const items = rows.filter((r) => {
          if (a.product && !r.name.includes(a.product)) return false;
          if (a.lowOnly === 'true') return r.current < r.safetyStock;
          return true;
        });
        if (!items.length) return '（无匹配库存）';
        return items.map((r) => `${r.name}：${r.current} 只（安全库存 ${r.safetyStock}${r.current < r.safetyStock ? '，⚠ 低于安全线' : ''}）`).join('\n');
      },
      query_orders: async (a) => {
        const conds = [];
        if (a.customer) {
          const cs = await db.select().from(customers).where(ilike(customers.name, `%${a.customer}%`));
          if (cs.length) conds.push(eq(orders.customerId, cs[0].id));
        }
        if (a.status) conds.push(eq(orders.status, a.status as never));
        if (a.month) {
          const gte_ = `${a.month}-01T00:00:00Z`;
          const [y, m] = a.month.split('-').map(Number);
          const lt_ = new Date(Date.UTC(y, m, 1)).toISOString().replace('T', ' ').slice(0, 10);
          conds.push(sql`${orders.createdAt} >= ${gte_}::timestamptz AND ${orders.createdAt} < ${lt_}::timestamptz`);
        }
        const where = conds.length ? and(...conds) : undefined;
        const rows = await db
          .select({ id: orders.id, orderNo: orders.orderNo, customerId: orders.customerId, dueDate: orders.dueDate, status: orders.status, createdAt: orders.createdAt })
          .from(orders)
          .where(where)
          .orderBy(desc(orders.id))
          .limit(20);
        if (!rows.length) return '（无匹配订单）';
        const cs = await db.select().from(customers);
        const cm = new Map(cs.map((c) => [c.id, c.name]));
        return rows.map((r) => `${r.orderNo} ${cm.get(r.customerId) ?? ''} 交期${new Date(r.dueDate).toISOString().slice(0, 10)} ${r.status}`).join('\n');
      },
      query_schedule: async (a) => {
        const tasks = await this.sched.listTasks();
        const items = tasks.filter((t) => {
          if (!t.scheduled) return false;
          if (a.planNo && !t.planNo.includes(a.planNo)) return false;
          if (a.overdueOnly === 'true' && !t.overdue) return false;
          return true;
        });
        if (!items.length) return '（无匹配排程）';
        return items.map((t) => `${t.planNo}·行${t.lineId} ${t.productName} ${t.wcName ?? ''} ${t.startDate}→${t.endDate}${t.overdue ? ' ⚠超期' : ''}`).join('\n');
      },
      query_customers: async (a) => {
        const rows = a.kw
          ? await db.select().from(customers).where(ilike(customers.name, `%${a.kw}%`))
          : await db.select().from(customers);
        return rows.map((c) => `${c.name}（账期 ${c.creditDays} 天）`).join('\n') || '（无）';
      },
      query_processes: async () => {
        const wcs = await db.select().from(workCenters);
        return wcs.map((w) => `${w.key} ${w.name}（设备 ${w.machines} 台）`).join('\n');
      },
      query_plan_sheets: async (a) => {
        const rows = await db
          .select({ id: planSheets.id, planNo: planSheets.planNo, status: planSheets.status, orderId: planSheets.orderId })
          .from(planSheets)
          .where(a.status ? eq(planSheets.status, a.status as never) : undefined)
          .orderBy(desc(planSheets.id))
          .limit(20);
        if (!rows.length) return '（无计划单）';
        return rows.map((r) => `${r.planNo} ${r.status}（订单 ${r.orderId}）`).join('\n');
      },
    };
    const fn = fns[name];
    if (!fn) return `未知工具：${name}`;
    return fn(args);
  }

  private currentMonth(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  /** mock 确定性路由：关键词 → 工具+参数（与 LLM 同一执行器，离线口径一致） */
  private route(question: string): { name: string; args: Record<string, string> } {
    const q = question.toLowerCase();
    const month = q.match(/(20\d{2})[年.\-/](\d{1,2})月?/);
    const m = month ? `${month[1]}-${month[2].padStart(2, '0')}` : '';
    const args: Record<string, string> = {};
    if (m) args.month = m;
    if (/逾期|超期/.test(q)) {
      if (/应收|欠款|回款/.test(q)) return { name: 'query_receivables', args: { ...args, overdueOnly: 'true' } };
      return { name: 'query_schedule', args: { overdueOnly: 'true' } };
    }
    if (/利润|盈亏|赚|亏|月报|营收|经营/.test(q)) return { name: 'query_profit', args };
    if (/库存|现货|缺货|安全库存|还有.*货/.test(q)) return { name: 'query_inventory', args: { lowOnly: /低|缺|安全/.test(q) ? 'true' : '' } };
    if (/应收|往来|欠|未收|账龄/.test(q)) return { name: 'query_receivables', args };
    if (/排程|排期|排产|任务|进度/.test(q)) return { name: 'query_schedule', args };
    if (/计划单/.test(q)) return { name: 'query_plan_sheets', args: {} };
    if (/工序|产能|工作中心|设备/.test(q)) return { name: 'query_processes', args: {} };
    if (/客户/.test(q)) return { name: 'query_customers', args: {} };
    if (/订单/.test(q)) return { name: 'query_orders', args: {} };
    return { name: 'query_orders', args: {} };
  }

  /** 问数主入口 */
  async ask(question: string): Promise<{
    question: string;
    answer: string;
    calls: Array<{ name: string; args: Record<string, string>; result: string }>;
    provider: 'llm' | 'router';
    /** AI 调用失败并降级（与「未配置 Key 的 mock」区分） */
    degraded?: boolean;
    /** 降级说明（失败原因），供界面提示 */
    notice?: string;
  }> {
    const calls: Array<{ name: string; args: Record<string, string>; result: string }> = [];
    const runCall = async (name: string, args: Record<string, string>) => {
      const result = await this.exec(name, args);
      calls.push({ name, args, result });
    };

    if (!(await this.llm.hasChatKey())) {
      const r = this.route(question);
      await runCall(r.name, r.args);
      const answer = `（mock 路由）已查询「${r.name}」：\n${calls[0].result}`;
      return { question, answer, calls, provider: 'router' };
    }

    // live：LLM 工具调用（最多两轮：择参→执行→汇总）
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: '你是工厂数据查询助手。根据用户问题选择最合适的工具查询（参数用中文/缩写也尽量补全为正式格式，如月份 YYYY-MM）。先调用工具拿到结果，再基于结果用中文简洁回答。若问题不需要数据，直接回答。',
      },
      { role: 'user', content: question },
    ];
    const first = await this.llm.chat(messages, { tools: QA_TOOLS });
    if (first.degraded) {
      // 真实调用失败：改用确定性关键词路由，并如实告知失败原因（不再伪装成模型回答）
      const r = this.route(question);
      await runCall(r.name, r.args);
      return {
        question,
        calls,
        provider: 'router',
        degraded: true,
        notice: `AI 调用失败：${first.reason ?? '未知原因'}`,
        answer: `（AI 暂不可用，已改用规则路由）已查询「${r.name}」：\n${calls[0].result}`,
      };
    }
    const picked = first.toolCalls?.[0];
    if (picked) {
      let args: Record<string, string> = {};
      try { args = JSON.parse(picked.arguments ?? '{}'); } catch { /* 容错 */ }
      await runCall(picked.name, args);
      // OpenAI 兼容协议：tool 结果必须跟随带 tool_calls 的 assistant 消息（否则真 Key 环境下二轮会 400）
      messages.push({
        role: 'assistant',
        content: first.text ?? '',
        tool_calls: (first.toolCalls ?? []).map((tc, i) => ({
          id: `call_${i}`,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
      messages.push({ role: 'tool', tool_call_id: 'call_0', content: `工具 ${picked.name} 返回：\n${calls[0].result}` });
      messages.push({ role: 'user', content: '基于以上查询结果，用中文回答我的问题。' });
      const second = await this.llm.chat(messages, { temperature: 0.2 });
      if (second.degraded || !second.text.trim()) {
        // 汇总轮失败：直接展示第一轮工具结果（权威数据），不丢结果、不伪造回答
        return {
          question,
          calls,
          provider: 'llm',
          degraded: second.degraded,
          notice: second.degraded ? `AI 汇总失败：${second.reason ?? '未知原因'}` : undefined,
          answer: calls[0].result,
        };
      }
      return { question, answer: second.text.trim(), calls, provider: 'llm' };
    }
    return { question, answer: first.text.trim() || '无法回答', calls, provider: 'llm' };
  }
}
