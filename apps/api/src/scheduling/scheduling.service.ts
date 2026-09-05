import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  customers,
  orderLines,
  orders,
  planSheetLines,
  planSheets,
  processes,
  productProcesses,
  products,
  workCenters,
} from '../db/schema';

const SHIFT_MIN = 8 * 60; // 单班 8 小时 = 480 分钟
/** YYYY-MM-DD 加减 n 天（返回 YYYY-MM-DD） */
const addDays = (dateStr: string, n: number): string => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
};
const tsToDate = (ts: Date | string | null): string | null =>
  ts ? (typeof ts === 'string' ? ts.slice(0, 10) : ts.toISOString().slice(0, 10)) : null;

/**
 * 排期看板（I11，spec §5 / research/04-process-data.md）
 *  - 6 工序泳道（工作中心）看板，纵轴固定为 wc 集合
 *  - 行级排期单元 = plan_sheet_line（已确认计划单全进池）
 *  - 工期推算：数量×单件耗时÷设备数 / 8h → 天；可覆盖
 */
@Injectable()
export class SchedulingService {
  /** 工作中心列表（看板纵轴） */
  async listWorkCenters() {
    return db.select().from(workCenters).orderBy(asc(workCenters.sortOrder));
  }

  /** 工序字典 */
  async listProcesses() {
    return db.select().from(processes).orderBy(asc(processes.sortOrder));
  }

  /** 排期任务池：已确认计划单的全部行（每计划单行一任务） */
  async listTasks() {
    const rows = await db
      .select({
        line: planSheetLines,
        plan: planSheets,
        orderLine: orderLines,
        order: orders,
        product: products,
        customer: customers,
      })
      .from(planSheetLines)
      .innerJoin(planSheets, eq(planSheets.id, planSheetLines.planSheetId))
      .innerJoin(orders, eq(orders.id, planSheets.orderId))
      .innerJoin(orderLines, eq(orderLines.id, planSheetLines.orderLineId))
      .innerJoin(products, eq(products.id, planSheetLines.productId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(eq(planSheets.status, 'confirmed'))
      .orderBy(asc(planSheets.planNo), asc(planSheetLines.id));

    // 预拉所有产品×工序耗时，避免 N+1
    const ppRows = await db
      .select({
        productId: productProcesses.productId,
        wcKey: processes.wcKey,
        unitSeconds: productProcesses.unitSeconds,
        seq: productProcesses.seq,
      })
      .from(productProcesses)
      .innerJoin(processes, eq(processes.id, productProcesses.processId))
      .orderBy(asc(productProcesses.seq));
    const unitMap = new Map<string, number>(); // key=`${productId}:${wcKey}` -> unitSeconds
    for (const r of ppRows) {
      if (r.unitSeconds == null) continue;
      const k = `${r.productId}:${r.wcKey}`;
      if (!unitMap.has(k)) unitMap.set(k, Number(r.unitSeconds));
    }
    const wcMap = new Map((await db.select().from(workCenters)).map((w) => [w.key, w]));

    return rows.map(({ line, plan, order, orderLine, product, customer }) => {
      const completed = line.completedQuantity ?? 0;
      const progress = line.quantity ? Math.min(1, completed / line.quantity) : 0;
      const scheduled = !!line.wcKey && !!line.startDate;
      const due = tsToDate(order.dueDate);
      const wc = line.wcKey ? wcMap.get(line.wcKey) : null;
      const unit = line.wcKey ? unitMap.get(`${line.productId}:${line.wcKey}`) ?? null : null;
      const autoDays = wc ? this.computeAutoDays(line.quantity, unit, wc.machines) : 1;
      const durDays = line.coverDays ?? autoDays;
      const endDate = scheduled && line.startDate
        ? addDays(line.startDate as unknown as string, Math.max(1, durDays) - 1)
        : null;
      const overdue = scheduled && due && endDate && progress < 1 ? endDate >= due : false;
      return {
        lineId: line.id,
        planId: plan.id,
        planNo: plan.planNo,
        planStatus: plan.status,
        orderId: order.id,
        orderNo: order.orderNo,
        customerId: order.customerId,
        customerName: customer?.name ?? '',
        orderLineId: orderLine.id,
        productId: product.id,
        productName: product.name,
        quantity: line.quantity,
        completed,
        progress,
        wcKey: line.wcKey,
        wcName: wc?.name ?? null,
        startDate: line.startDate,
        coverDays: line.coverDays,
        autoDays,
        durDays,
        unitSeconds: unit,
        scheduled,
        dueDate: due,
        endDate,
        overdue,
        engraving: line.engraving,
        packaging: line.packaging,
      };
    });
  }

  /** 行级排期核验（弹窗实时计算） */
  async verify(lineId: number, wcKey: string, startDate: string) {
    const [line] = await db.select().from(planSheetLines).where(eq(planSheetLines.id, lineId));
    if (!line) throw new NotFoundException(`计划单行 ${lineId} 不存在`);
    const wcList = await db.select().from(workCenters);
    const wc = wcList.find((w) => w.key === wcKey);
    if (!wc) throw new BadRequestException(`工作中心 ${wcKey} 不存在`);
    const unitSeconds = await this.unitSecondsFor(line.productId, wcKey);
    const autoDays = this.computeAutoDays(line.quantity, unitSeconds, wc.machines);
    const coverDays = line.coverDays ?? autoDays;
    const endDate = addDays(startDate, Math.max(1, coverDays) - 1);
    const [plan] = await db.select().from(planSheets).where(eq(planSheets.id, line.planSheetId));
    const [order] = await db.select().from(orders).where(eq(orders.id, plan.orderId));
    const due = tsToDate(order?.dueDate);
    const overdue = due ? endDate >= due : false;
    const laneRes = await db.execute(sql`
      SELECT COUNT(*)::int AS c FROM plan_sheet_lines
       WHERE wc_key = ${wcKey} AND id <> ${lineId} AND start_date IS NOT NULL
    `);
    const laneLoad = Number((laneRes as any).rows?.[0]?.c ?? 0);
    return {
      unitSeconds,
      machines: wc.machines,
      autoDays,
      coverDays,
      durationHint: unitSeconds == null ? '该产品未配置该工序单件耗时，请确认工期覆盖' : '按 qty×单件耗时÷设备数÷8h 推算',
      startDate,
      endDate,
      dueDate: due,
      overdue,
      laneLoad: laneLoad as number,
      wcName: wc.name,
    };
  }

  /** 设置/更新行排期 */
  async scheduleLine(lineId: number, dto: { wcKey: string; startDate: string; coverDays?: number | null }) {
    const [line] = await db.select().from(planSheetLines).where(eq(planSheetLines.id, lineId));
    if (!line) throw new NotFoundException(`计划单行 ${lineId} 不存在`);
    const wcList = await db.select().from(workCenters);
    if (!wcList.find((w) => w.key === dto.wcKey)) throw new BadRequestException(`工作中心 ${dto.wcKey} 不存在`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dto.startDate)) throw new BadRequestException('开始日须为 YYYY-MM-DD');
    await db.update(planSheetLines).set({
      wcKey: dto.wcKey,
      startDate: dto.startDate,
      coverDays: dto.coverDays ?? null,
    }).where(eq(planSheetLines.id, lineId));
    return { ok: true };
  }

  /** 取消行排期 */
  async unscheduleLine(lineId: number) {
    const [line] = await db.select().from(planSheetLines).where(eq(planSheetLines.id, lineId));
    if (!line) throw new NotFoundException(`计划单行 ${lineId} 不存在`);
    await db.update(planSheetLines).set({
      wcKey: null,
      startDate: null,
      coverDays: null,
    }).where(eq(planSheetLines.id, lineId));
    return { ok: true };
  }

  // ============ 内部：工期推算 ============
  private async unitSecondsFor(productId: number, wcKey: string): Promise<number | null> {
    const r = await db.execute(sql`
      SELECT pp.unit_seconds
        FROM product_processes pp
        JOIN processes p ON p.id = pp.process_id
       WHERE pp.product_id = ${productId} AND p.wc_key = ${wcKey}
       ORDER BY pp.seq
       LIMIT 1
    `);
    const row = (r as any).rows?.[0];
    return row?.unit_seconds == null ? null : Number(row.unit_seconds);
  }

  private computeAutoDays(qty: number, unitSeconds: number | null, machines: number): number {
    if (unitSeconds == null || unitSeconds <= 0) return 1; // 占位默认 1 天
    const totalMin = (qty * unitSeconds) / 60 / Math.max(1, machines);
    const days = totalMin / SHIFT_MIN;
    return Math.max(1, Math.ceil(days));
  }
}