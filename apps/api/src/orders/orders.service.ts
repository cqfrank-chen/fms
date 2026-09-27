import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { customers, operators, orderLines, orders, outbounds, planSheetLines, planSheets, products, receivables } from '../db/schema';
import type { OrderStatus } from '../db/schema';
import { currentOperatorId } from '../common/operator-context';
import { toCents } from '../common/money';

export interface OrderLineDto {
  productId: number;
  quantity: number;
  unitPrice: number;
  currency?: 'RMB' | 'USD';
  engraving?: string;
  packaging?: Record<string, string>;
}

export interface CreateOrderDto {
  customerId: number;
  poNo?: string;
  dueDate: string; // ISO 日期
  note?: string;
  lines: OrderLineDto[];
}

export interface OrderListQuery {
  status?: OrderStatus;
  customerId?: number;
  kw?: string;
}

/** 单头+行+关联名的返回结构（前端直接消费） */
export interface OrderWithLines {
  id: number;
  orderNo: string;
  customerId: number;
  customerName: string;
  poNo: string | null;
  dueDate: Date;
  note: string | null;
  status: OrderStatus;
  createdAt: Date;
  lines: Array<OrderLineDto & { id: number; productName: string }>;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

@Injectable()
export class OrdersService {
  /** 生成单号 SO-YYYYMMDD-NN（当天最大序号+1；count 在删除后会复用旧号，改 max 根治） */
  private async nextOrderNo(now: Date): Promise<string> {
    const prefix = `SO-${ymd(now)}-`;
    const [row] = await db
      .select({ mx: sql<number | null>`max(substring(order_no from '[0-9]+$')::int)` })
      .from(orders)
      .where(like(orders.orderNo, `${prefix}%`));
    return `${prefix}${pad2((row?.mx ?? 0) + 1)}`;
  }

  /** 创建订单（单头+行，事务）；I05 前状态恒为草稿 */
  async create(dto: CreateOrderDto) {
    const now = new Date();
    const orderNo = await this.nextOrderNo(now);
    const dueDate = new Date(dto.dueDate);
    const created = await db.transaction(async (tx) => {
      const [order] = await tx
        .insert(orders)
        .values({ orderNo, customerId: dto.customerId, poNo: dto.poNo ?? null, dueDate, note: dto.note ?? null, operatorId: currentOperatorId() })
        .returning();
      await tx.insert(orderLines).values(
        dto.lines.map((l) => ({
          orderId: order.id,
          productId: l.productId,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          currency: l.currency ?? 'RMB',
          engraving: l.engraving ?? null,
          packaging: l.packaging ?? null,
        })),
      );
      return order;
    });
    return this.findOne(created.id);
  }

  /**
   * 取消订单（五态收敛：draft/confirmed → cancelled）。
   * 已发货 / 已报工 / 计划单已完成 → 拒绝（须先冲销相关单据）；
   * 未开工计划单置 voided，未核销的订单应收同步冲销（账目不断链）。
   */
  async cancelOrder(id: number) {
    await db.transaction(async (tx) => {
      const [o] = await tx.select().from(orders).where(eq(orders.id, id)).for('update');
      if (!o) throw new NotFoundException('订单不存在');
      if (o.status === 'cancelled') throw new BadRequestException('订单已取消');
      if (o.status === 'completed') throw new BadRequestException('已完成订单不可取消（请走出库冲销/退货流程）');
      const ships = await tx.select().from(outbounds).where(eq(outbounds.orderId, id));
      if (ships.some((s) => s.status === 'shipped')) throw new BadRequestException('存在已出库单据，请先冲销出库再取消');
      const [plan] = await tx.select().from(planSheets).where(eq(planSheets.orderId, id)).for('update');
      if (plan) {
        if (plan.status === 'completed') throw new BadRequestException('计划单已完成，不可取消');
        const lines = await tx.select().from(planSheetLines).where(eq(planSheetLines.planSheetId, plan.id));
        if (lines.some((l) => (l.completedQuantity ?? 0) > 0)) {
          throw new BadRequestException('已发生报工，不可取消（请先冲销相关单据）');
        }
        if (plan.status !== 'voided') {
          await tx.update(planSheets).set({ status: 'voided', updatedAt: new Date() }).where(eq(planSheets.id, plan.id));
        }
      }
      const [recv] = await tx
        .select()
        .from(receivables)
        .where(and(eq(receivables.sourceId, id), eq(receivables.sourceType, 'order')))
        .for('update');
      if (recv && recv.status !== 'voided') {
        if (toCents(recv.settledAmount) > 0) {
          throw new BadRequestException(`应收 ${recv.recvNo} 已核销 ${recv.settledAmount}，请先冲销收款单`);
        }
        await tx.update(receivables).set({ status: 'voided', amount: 0, updatedAt: new Date() }).where(eq(receivables.id, recv.id));
      }
      await tx.update(orders).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(orders.id, id));
    });
    return this.findOne(id);
  }

  /** 列表（可选筛选：状态/客户/单号PO关键字） */
  async findAll(q: OrderListQuery) {
    const conds = [];
    if (q.status) conds.push(eq(orders.status, q.status));
    if (q.customerId) conds.push(eq(orders.customerId, q.customerId));
    if (q.kw) {
      const kw = `%${q.kw}%`;
      conds.push(or(like(orders.orderNo, kw), like(orders.poNo, kw)));
    }
    const base = db
      .select({
        order: orders,
        customerName: customers.name,
        operatorName: operators.name,
      })
      .from(orders)
      .leftJoin(customers, eq(orders.customerId, customers.id))
      .leftJoin(operators, eq(orders.operatorId, operators.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(orders.id));
    const rows = await base;
    return this.attachLines(rows);
  }

  /** 详情（404 保护） */
  async findOne(id: number) {
    const rows = await db
      .select({ order: orders, customerName: customers.name })
      .from(orders)
      .leftJoin(customers, eq(orders.customerId, customers.id))
      .where(eq(orders.id, id));
    if (!rows.length) throw new NotFoundException('订单不存在');
    const [r] = await this.attachLines(rows as any);
    return r;
  }

  /** 编辑（仅草稿；单头字段+行整体替换） */
  async update(id: number, dto: Partial<CreateOrderDto>) {
    const existing = await this.requireDraft(id);
    await db.transaction(async (tx) => {
      const dueDate = dto.dueDate ? new Date(dto.dueDate) : existing.dueDate;
      await tx
        .update(orders)
        .set({
          customerId: dto.customerId ?? existing.customerId,
          poNo: dto.poNo !== undefined ? (dto.poNo ?? null) : existing.poNo,
          dueDate,
          note: dto.note !== undefined ? (dto.note ?? null) : existing.note,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, id));
      if (dto.lines) {
        await tx.delete(orderLines).where(eq(orderLines.orderId, id));
        await tx.insert(orderLines).values(
          dto.lines.map((l) => ({
            orderId: id,
            productId: l.productId,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            currency: l.currency ?? 'RMB',
            engraving: l.engraving ?? null,
            packaging: l.packaging ?? null,
          })),
        );
      }
    });
    return this.findOne(id);
  }

  /**
   * 删除（仅草稿）。
   * I05 驳回会把来源订单退回草稿并保留一张 voided 计划单轨迹——
   * 此时删除订单须伴随清理该 voided 计划单（级联删其行），否则 FK 报错；
   * 若关联的是有效计划单则拒绝删除（已确认订单走变更/驳回流程）。
   */
  async remove(id: number) {
    await this.requireDraft(id);
    await db.transaction(async (tx) => {
      const plans = await tx.select().from(planSheets).where(eq(planSheets.orderId, id));
      for (const p of plans) {
        if (p.status !== 'voided') {
          throw new BadRequestException('订单已生成有效计划单，不可删除（可走驳回/变更流程）');
        }
      }
      if (plans.length) {
        await tx.delete(planSheets).where(eq(planSheets.orderId, id)); // 行随 cascade 一并删除
      }
      await tx.delete(orderLines).where(eq(orderLines.orderId, id));
      await tx.delete(orders).where(eq(orders.id, id));
    });
  }

  // ---------- helpers ----------

  private async requireDraft(id: number) {
    const [row] = await db.select().from(orders).where(eq(orders.id, id));
    if (!row) throw new NotFoundException('订单不存在');
    if (row.status !== 'draft') throw new BadRequestException('仅草稿订单可修改/删除（已确认订单走变更流程）');
    return row;
  }

  /** 为列表行补订单行+产品名 */
  private async attachLines(rows: Array<{ order: any; customerName: string | null; operatorName?: string | null }>) {
    if (!rows.length) return [];
    const orderIds = rows.map((r) => r.order.id);
    const lines = await db
      .select({ line: orderLines, productName: products.name })
      .from(orderLines)
      .leftJoin(products, eq(orderLines.productId, products.id))
      .where(inArray(orderLines.orderId, orderIds))
      .orderBy(orderLines.id);
    const byOrder = new Map<number, Array<any>>();
    for (const { line, productName } of lines) {
      const arr = byOrder.get(line.orderId) ?? [];
      arr.push({ ...line, productName });
      byOrder.set(line.orderId, arr);
    }
    return rows.map(({ order, customerName, operatorName }) => ({
      ...order,
      customerName,
      operatorName: operatorName ?? null,
      totalAmount: (byOrder.get(order.id) ?? []).reduce((s, l) => s + l.quantity * l.unitPrice, 0),
      lines: byOrder.get(order.id) ?? [],
    }));
  }
}
