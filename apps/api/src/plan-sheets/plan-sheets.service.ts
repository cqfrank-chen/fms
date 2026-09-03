import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '../db';
import { customers, orderLines, orders, planSheetLines, planSheets, products } from '../db/schema';
import type { PlanStatus } from '../db/schema';

const pad2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

export interface PlanListQuery { status?: PlanStatus; customerId?: number; kw?: string }

/**
 * 计划单模块：订单确认 → 自动生成草稿 → 计划员审核
 * （I05；行报工/状态聚合为 I06，排期池消费在 I11）
 */
@Injectable()
export class PlanSheetsService {
  /** 生成计划单号 PS-YYYYMMDD-NN */
  private async nextPlanNo(now: Date): Promise<string> {
    const prefix = `PS-${ymd(now)}-`;
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(planSheets)
      .where(like(planSheets.planNo, `${prefix}%`));
    return `${prefix}${pad2(count + 1)}`;
  }

  /** 订单确认：草稿 → 已确认，同时自动生成计划单草稿（一单一计划单） */
  async confirmOrder(orderId: number) {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status !== 'draft')
      throw new BadRequestException(`仅草稿订单可确认（当前：${order.status}）`);

    const existing = await db.select().from(planSheets).where(eq(planSheets.orderId, orderId));
    if (existing.length)
      throw new BadRequestException(`订单已存在计划单（${existing[0].planNo}），勿重复确认`);

    const plan = await db.transaction(async (tx) => {
      // 1. 订单置为已确认
      await tx.update(orders).set({ status: 'confirmed' }).where(eq(orders.id, orderId));
      // 2. 建计划单草稿
      const [created] = await tx
        .insert(planSheets)
        .values({ planNo: await this.nextPlanNo(new Date()), orderId })
        .returning();
      // 3. 行快照：产品/数量/刻字/包装 从订单行复制
      const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId));
      if (lines.length) {
        await tx.insert(planSheetLines).values(
          lines.map((l) => ({
            planSheetId: created.id,
            orderLineId: l.id,
            productId: l.productId,
            quantity: l.quantity,
            engraving: l.engraving,
            packaging: l.packaging,
          })),
        );
      }
      return created;
    });
    return this.findOne(plan.id);
  }

  /** 计划员审核：草稿 → 已确认（行进入排期池由 I11 消费） */
  async audit(planId: number) {
    const [plan] = await db.select().from(planSheets).where(eq(planSheets.id, planId));
    if (!plan) throw new NotFoundException('计划单不存在');
    if (plan.status !== 'draft')
      throw new BadRequestException(`仅草稿计划单可审核（当前：${plan.status}）`);
    const [updated] = await db
      .update(planSheets)
      .set({ status: 'confirmed' })
      .where(eq(planSheets.id, planId))
      .returning();
    return this.findOne(updated.id);
  }

  /** 列表（筛选：状态/客户/单号PO关键字），关联订单行产品名与客户名 */
  async findAll(q: PlanListQuery) {
    const conds = [];
    if (q.status) conds.push(eq(planSheets.status, q.status));
    if (q.customerId) conds.push(eq(orders.customerId, q.customerId));
    if (q.kw) {
      const kw = `%${q.kw}%`;
      conds.push(like(planSheets.planNo, kw));
    }
    const rows = await db
      .select({
        plan: planSheets,
        orderNo: orders.orderNo,
        customerId: orders.customerId,
        customerName: customers.name,
        poNo: orders.poNo,
        dueDate: orders.dueDate,
      })
      .from(planSheets)
      .innerJoin(orders, eq(planSheets.orderId, orders.id))
      .leftJoin(customers, eq(orders.customerId, customers.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(planSheets.id));
    return this.attachLines(rows);
  }

  /** 详情（含来源订单单头信息） */
  async findOne(id: number) {
    const rows = await db
      .select({
        plan: planSheets,
        orderNo: orders.orderNo,
        customerId: orders.customerId,
        customerName: customers.name,
        poNo: orders.poNo,
        dueDate: orders.dueDate,
        note: orders.note,
        orderStatus: orders.status,
      })
      .from(planSheets)
      .innerJoin(orders, eq(planSheets.orderId, orders.id))
      .leftJoin(customers, eq(orders.customerId, customers.id))
      .where(eq(planSheets.id, id));
    if (!rows.length) throw new NotFoundException('计划单不存在');
    const [r] = await this.attachLines(rows as any);
    return r;
  }

  /** 为行补产品名 */
  private async attachLines(rows: Array<Record<string, any>>) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.plan.id);
    const lines = await db
      .select({ line: planSheetLines, productName: products.name })
      .from(planSheetLines)
      .leftJoin(products, eq(planSheetLines.productId, products.id))
      .where(inArray(planSheetLines.planSheetId, ids))
      .orderBy(planSheetLines.id);
    const byPlan = new Map<number, Array<any>>();
    for (const { line, productName } of lines) {
      const arr = byPlan.get(line.planSheetId) ?? [];
      arr.push({ ...line, productName });
      byPlan.set(line.planSheetId, arr);
    }
    return rows.map(({ plan, ...rest }) => ({
      ...plan,
      ...rest,
      lines: byPlan.get(plan.id) ?? [],
    }));
  }
}
