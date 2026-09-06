import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, like, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  customers, goodsReceiptLines, goodsReceipts, orderLines, orders,
  planSheetLines, planSheets, products,
} from '../db/schema';
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

    const existing = await db
      .select()
      .from(planSheets)
      .where(and(eq(planSheets.orderId, orderId), ne(planSheets.status, 'voided')));
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

  /** 审核不通过：草稿计划单作废 + 来源订单退回草稿（可编辑后重新确认，生成新计划单） */
  async reject(planId: number) {
    const [plan] = await db.select().from(planSheets).where(eq(planSheets.id, planId));
    if (!plan) throw new NotFoundException('计划单不存在');
    if (plan.status !== 'draft')
      throw new BadRequestException(`仅草稿计划单可驳回（当前：${plan.status}）`);
    const [order] = await db.select().from(orders).where(eq(orders.id, plan.orderId));
    if (!order) throw new NotFoundException('来源订单不存在');
    if (order.status !== 'confirmed')
      throw new BadRequestException(`仅来源订单为「已确认」时可驳回（当前订单：${order.status}）`);
    await db.transaction(async (tx) => {
      // 1. 删计划单行（行快照引用订单行，若保留会挡后续订单行编辑的 FK）
      await tx.delete(planSheetLines).where(eq(planSheetLines.planSheetId, planId));
      // 2. 计划单作废（保留单头作驳回轨迹）
      await tx.update(planSheets).set({ status: 'voided' }).where(eq(planSheets.id, planId));
      // 3. 订单退回草稿：可编辑/删除，重新确认即生成新计划单
      await tx.update(orders).set({ status: 'draft' }).where(eq(orders.id, plan.orderId));
    });
    return this.findOne(planId);
  }

  // ---------- I06 行报工 + 状态聚合 + 入库草稿 ----------

  /** 行报工：录本次完成数量（增量）→ 行累计 → 计划单/订单状态联动 → 触发入库单草稿 */
  async report(planId: number, dto: { lineId: number; doneQty: number }) {
    const plan = await this.loadPlan(planId);
    if (plan.status !== 'confirmed' && plan.status !== 'production')
      throw new BadRequestException(`仅已确认/生产中计划单可报工（当前：${plan.status}）`);

    const [line] = await db
      .select()
      .from(planSheetLines)
      .where(and(eq(planSheetLines.id, dto.lineId), eq(planSheetLines.planSheetId, planId)));
    if (!line) throw new NotFoundException('计划单行不存在或不属于该计划单');
    if (line.completedQuantity + dto.doneQty > line.quantity)
      throw new BadRequestException(
        `报工超量：已完成 ${line.completedQuantity}/${line.quantity}，本次最多可报 ${line.quantity - line.completedQuantity}`,
      );

    await db.transaction(async (tx) => {
      // 1. 行累计
      const newDone = line.completedQuantity + dto.doneQty;
      await tx
        .update(planSheetLines)
        .set({ completedQuantity: newDone })
        .where(eq(planSheetLines.id, line.id));

      // 2. 状态聚合：首报>0 → 生产中；全部行完成 → 计划单已完成
      const all = await tx.select().from(planSheetLines).where(eq(planSheetLines.planSheetId, planId));
      const allDone = all.length > 0 && all.every((l) => l.completedQuantity >= l.quantity);
      const anyDone = all.some((l) => l.completedQuantity > 0);
      const nextPlanStatus: PlanStatus = allDone ? 'completed' : anyDone ? 'production' : 'confirmed';
      if (plan.status !== nextPlanStatus)
        await tx.update(planSheets).set({ status: nextPlanStatus }).where(eq(planSheets.id, planId));

      // 3. 订单联动：计划单已完成 → 订单已完成（进归档）
      if (allDone) {
        await tx.update(orders).set({ status: 'completed' }).where(eq(orders.id, plan.orderId));
      }

      // 4. 入库草稿 upsert：找未确认草稿，无则新建（批次=一计划单一批次）
      const now = new Date();
      let [receipt] = await tx
        .select()
        .from(goodsReceipts)
        .where(and(eq(goodsReceipts.planSheetId, planId), eq(goodsReceipts.status, 'draft')));
      if (!receipt) {
        const [{ rc }] = await tx
          .select({ rc: sql<number>`count(*)::int` })
          .from(goodsReceipts)
          .where(like(goodsReceipts.receiptNo, `GR-${ymd(now)}-%`));
        const [{ bc }] = await tx
          .select({ bc: sql<number>`count(*)::int` })
          .from(goodsReceipts)
          .where(like(goodsReceipts.batchNo, `FG-${ymd(now)}-%`));
        const [created] = await tx
          .insert(goodsReceipts)
          .values({
            receiptNo: `GR-${ymd(now)}-${pad2(rc + 1)}`,
            planSheetId: planId,
            batchNo: `FG-${ymd(now)}-${pad2(bc + 1)}`,
          })
          .returning();
        receipt = created;
      }
      const [rline] = await tx
        .select()
        .from(goodsReceiptLines)
        .where(and(eq(goodsReceiptLines.receiptId, receipt.id), eq(goodsReceiptLines.planSheetLineId, line.id)));
      if (rline) {
        await tx
          .update(goodsReceiptLines)
          .set({ quantity: rline.quantity + dto.doneQty })
          .where(eq(goodsReceiptLines.id, rline.id));
      } else {
        await tx.insert(goodsReceiptLines).values({
          receiptId: receipt.id,
          planSheetLineId: line.id,
          productId: line.productId,
          quantity: dto.doneQty,
        });
      }
    });
    return this.findOne(planId);
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

  /** 取计划单（不存在 404） */
  private async loadPlan(id: number) {
    const [plan] = await db.select().from(planSheets).where(eq(planSheets.id, id));
    if (!plan) throw new NotFoundException('计划单不存在');
    return plan;
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
