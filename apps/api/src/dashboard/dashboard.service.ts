import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { customers, goodsReceipts, orders, outbounds, planSheets } from '../db/schema';
import { AccountingService } from '../accounting/accounting.service';
import { fromCents, toCents } from '../common/money';

interface StatusCount { status: string; n: number }
interface LowStock { id: number; name: string; safetyStock: number; stock: number }

/**
 * 首页看板（只读聚合）：关键计数、往来与营收、待办提示、最近订单、逾期应收。
 * 金额一律按「分」汇总（common/money），避免浮点尾差。
 */
@Injectable()
export class DashboardService {
  constructor(private readonly accounting: AccountingService) {}

  async overview() {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const [orderCounts, planCounts, outboundCounts, receiptCounts, lowStockRes, receivables, payables, recentRes, profit] =
      await Promise.all([
        db.select({ status: orders.status, n: sql<number>`count(*)::int` }).from(orders).groupBy(orders.status),
        db.select({ status: planSheets.status, n: sql<number>`count(*)::int` }).from(planSheets).groupBy(planSheets.status),
        db.select({ status: outbounds.status, n: sql<number>`count(*)::int` }).from(outbounds).groupBy(outbounds.status),
        db.select({ status: goodsReceipts.status, n: sql<number>`count(*)::int` }).from(goodsReceipts).groupBy(goodsReceipts.status),
        db.execute(sql`
          SELECT p.id, p.name, p.safety_stock::int AS "safetyStock", COALESCE(SUM(i.quantity), 0)::int AS stock
            FROM products p LEFT JOIN inventory i ON i.product_id = p.id
           WHERE p.safety_stock > 0
           GROUP BY p.id, p.name, p.safety_stock
          HAVING COALESCE(SUM(i.quantity), 0) < p.safety_stock
           ORDER BY (p.safety_stock - COALESCE(SUM(i.quantity), 0)) DESC
           LIMIT 20`),
        this.accounting.receivablesList(),
        this.accounting.payablesList(),
        db.execute(sql`
          SELECT o.id, o.order_no AS "orderNo", o.status, o.due_date AS "dueDate", c.name AS "customerName",
                 COALESCE(SUM(ol.quantity * ROUND(ol.unit_price * 100)), 0)::bigint AS "totalCents"
            FROM orders o
            LEFT JOIN customers c ON c.id = o.customer_id
            LEFT JOIN order_lines ol ON ol.order_id = o.id
           GROUP BY o.id, o.order_no, o.status, o.due_date, c.name
           ORDER BY o.id DESC
           LIMIT 8`),
        this.accounting.profit(month),
      ]);

    const cnt = (rows: StatusCount[], status: string) => rows.find((r) => r.status === status)?.n ?? 0;

    const activeRecv = (receivables as Array<Record<string, any>>).filter((r) => r.status !== 'voided');
    const outstanding = fromCents(activeRecv.reduce((s, r) => s + toCents(r.remain), 0));
    const overdue = activeRecv.filter((r) => r.overDue).sort((a, b) => (b.remain as number) - (a.remain as number));
    const overdueAmount = fromCents(overdue.reduce((s, r) => s + toCents(r.remain), 0));
    const activePay = (payables as Array<Record<string, any>>).filter((p) => p.status !== 'voided');
    const payableOutstanding = fromCents(activePay.reduce((s, p) => s + toCents(p.remain), 0));

    const lowStock = (((lowStockRes as any).rows ?? []) as LowStock[]);
    const ordersDraft = cnt(orderCounts, 'draft');
    const plansPendingAudit = cnt(planCounts, 'draft');
    const receiptsDraft = cnt(receiptCounts, 'draft');
    const outboundsPendingOqc = cnt(outboundCounts, 'pending');
    const outboundsDraft = cnt(outboundCounts, 'draft');

    const todo: Array<{ level: 'warn' | 'info'; text: string; page: string }> = [];
    if (plansPendingAudit) todo.push({ level: 'warn', text: `${plansPendingAudit} 张计划单待审核`, page: 'plans' });
    if (outboundsPendingOqc) todo.push({ level: 'warn', text: `${outboundsPendingOqc} 张出库单待 OQC 放行`, page: 'warehouse' });
    if (receiptsDraft) todo.push({ level: 'warn', text: `${receiptsDraft} 张入库单草稿待仓管确认`, page: 'warehouse' });
    if (lowStock.length) todo.push({ level: 'warn', text: `${lowStock.length} 个产品低于安全库存`, page: 'warehouse' });
    if (overdue.length) todo.push({ level: 'warn', text: `${overdue.length} 笔应收逾期，合计 ¥${overdueAmount.toLocaleString('zh-CN')}`, page: 'accounting' });
    if (ordersDraft) todo.push({ level: 'info', text: `${ordersDraft} 张订单仍是草稿（确认后才进入生产）`, page: 'orders' });
    if (outboundsDraft) todo.push({ level: 'info', text: `${outboundsDraft} 张出库单为草稿（待提交）`, page: 'warehouse' });
    if (!todo.length) todo.push({ level: 'info', text: '暂无待办：订单、计划、仓储、账目均无异常', page: 'orders' });

    return {
      kpi: {
        ordersActive: cnt(orderCounts, 'confirmed') + cnt(orderCounts, 'production'),
        ordersDraft,
        ordersCompleted: cnt(orderCounts, 'completed'),
        plansPendingAudit,
        plansInProduction: cnt(planCounts, 'production'),
        plansActive: cnt(planCounts, 'confirmed') + cnt(planCounts, 'production'),
        receiptsDraft,
        outboundsPendingOqc,
        outboundsDraft,
        lowStockCount: lowStock.length,
        receivableOutstanding: outstanding,
        overdueCount: overdue.length,
        overdueAmount,
        payableOutstanding,
        month,
        monthRevenue: profit.revenue,
        monthProfit: profit.profit,
        monthMaterial: profit.material,
        monthManufactureCost: profit.manufactureCost,
      },
      todo,
      lowStock: lowStock.slice(0, 6).map((p) => ({ ...p, gap: p.safetyStock - p.stock })),
      recentOrders: (((recentRes as any).rows ?? []) as Array<Record<string, any>>).map((r) => ({
        id: r.id,
        orderNo: r.orderNo,
        status: r.status,
        dueDate: r.dueDate,
        customerName: r.customerName ?? '',
        totalAmount: fromCents(Number(r.totalCents ?? 0)),
      })),
      overdueTop: overdue.slice(0, 6).map((r) => ({
        id: r.id, recvNo: r.recvNo, customerName: r.customerName, orderNo: r.orderNo,
        remain: r.remain, ageDays: r.ageDays, dueDate: r.dueDate,
      })),
      generatedAt: new Date().toISOString(),
    };
  }
}
