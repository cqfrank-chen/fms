import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { customers, inventory, products, receivables } from '../db/schema';
import { SchedulingService } from '../scheduling/scheduling.service';

/**
 * 规则预警引擎（I12 一期）：确定性规则触发（spec §8 —— 一期无 LLM 解释）。
 * 三类：① 安全库存穿透（成品库存 < safetyStock）② 应收账龄逾期（到期未核销）
 * ③ 交期冲突（排期完工 ≥ 客户交期且未完工，复用排期域 overdue 口径）。
 */

export interface AlertItem {
  type: 'low_stock' | 'recv_overdue' | 'due_conflict';
  level: 'danger' | 'warning';
  title: string; // 标题（产品/客户/计划单）
  detail: string; // 描述（人话）
  refId?: number | string; // 关联主键（跳转备用）
  days?: number; // 逾期/超期天数
}

@Injectable()
export class RuleAlertService {
  constructor(private readonly sched: SchedulingService) {}

  /** 聚合三类预警（按 severity 排序；无预警返回空数组） */
  async list(): Promise<{ alerts: AlertItem[]; counts: Record<string, number>; generatedAt: string }> {
    const [stock, overdueRecv, dueConflicts] = await Promise.all([
      this.lowStock(),
      this.overdueReceivables(),
      this.dueConflicts(),
    ]);
    const alerts = [...stock, ...overdueRecv, ...dueConflicts];
    const counts = { low_stock: stock.length, recv_overdue: overdueRecv.length, due_conflict: dueConflicts.length };
    return { alerts, counts, generatedAt: new Date().toISOString() };
  }

  /** ① 安全库存：成品可用量（全批次汇总）< safetyStock */
  private async lowStock(): Promise<AlertItem[]> {
    const rows = await db
      .select({
        productId: products.id,
        name: products.name,
        safetyStock: products.safetyStock,
        current: sql<number>`coalesce(sum(${inventory.quantity}), 0)::int`,
      })
      .from(products)
      .leftJoin(inventory, eq(inventory.productId, products.id))
      .groupBy(products.id);
    return rows
      .filter((r) => r.current < r.safetyStock)
      .sort((a, b) => a.current - b.current)
      .map((r) => ({
        type: 'low_stock' as const,
        level: (r.current <= 0 ? 'danger' : 'warning') as 'danger' | 'warning',
        title: r.name,
        detail: `成品库存 ${r.current} 只 < 安全库存 ${r.safetyStock} 只${r.current <= 0 ? '（已缺货）' : ''}`,
        refId: r.productId,
      }));
  }

  /** ② 应收账龄逾期：非冲销 + 未核销余额 > 0 + 已过到期日 */
  private async overdueReceivables(): Promise<AlertItem[]> {
    const today = new Date();
    const rows = await db
      .select({
        r: receivables,
        customerName: customers.name,
      })
      .from(receivables)
      .leftJoin(customers, eq(receivables.customerId, customers.id))
      .where(and(isNotNull(receivables.dueDate), lt(receivables.dueDate, today)));
    const items: AlertItem[] = [];
    for (const { r, customerName } of rows) {
      if (r.status === 'voided') continue;
      const owing = Number(r.amount) - Number(r.settledAmount);
      if (owing <= 0.005) continue;
      const days = Math.max(1, Math.ceil((today.getTime() - new Date(r.dueDate!).getTime()) / 86400000));
      items.push({
        type: 'recv_overdue',
        level: days >= 30 ? 'danger' : 'warning',
        title: `${customerName ?? '客户'} · ${r.recvNo}`,
        detail: `应收 ${r.currency}${owing.toFixed(2)} 已逾期 ${days} 天（到期 ${new Date(r.dueDate!).toISOString().slice(0, 10)}）`,
        refId: r.id,
        days,
      });
    }
    return items.sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  }

  /** ③ 交期冲突：复用排期域 overdue 口径（endDate ≥ due 且未完工），避免重复计算 */
  private async dueConflicts(): Promise<AlertItem[]> {
    const tasks = await this.sched.listTasks();
    const items: AlertItem[] = [];
    for (const t of tasks) {
      if (!t.scheduled || !t.overdue) continue;
      const days = Math.max(1, Math.ceil((new Date(t.endDate as string).getTime() - new Date(t.dueDate as string).getTime()) / 86400000));
      items.push({
        type: 'due_conflict',
        level: days >= 3 ? 'danger' : 'warning',
        title: `${t.planNo}·行${t.lineId} ${t.productName}`,
        detail: `排至 ${t.endDate} 完工，已超客户交期 ${t.dueDate} ${days} 天${t.customerName ? `（${t.customerName}）` : ''}`,
        refId: t.lineId,
        days,
      });
    }
    return items.sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  }
}
