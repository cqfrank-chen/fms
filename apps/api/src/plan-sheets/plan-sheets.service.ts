import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, like, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  customers, goodsReceiptLines, goodsReceipts, orderLines, orders,
  planSheetLines, planSheets, processes, productProcesses, products, workCenters,
} from '../db/schema';
import type { PlanStatus } from '../db/schema';

const pad2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
const SHIFT_MIN = 8 * 60;
/** YYYY-MM-DD 加减 n 天（返回 YYYY-MM-DD） */
const addDays = (dateStr: string, n: number): string => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
};

export interface PlanListQuery { status?: PlanStatus; customerId?: number; kw?: string }

/** 产品工序路由一步 */
export interface RouteStep { processId: number; name: string; wcKey: string; seq: number }

/**
 * 计划单模块：订单确认 → 自动生成草稿 → 计划员审核
 * （I05；行报工按工序推进/状态聚合为 I06，排期池消费在 I11）
 *
 * 报工模型（I06 修订，整批逐道）：产品配了工序路由（product_processes）时，
 * 报工 = 完成「当前工序」（routeSeq 指向），一次报满整批后推进到路由下一道，
 * 行 wcKey 随推进换下一道泳道、已排期则 startDate 顺延；只有末道工序报满才累计
 * 成品 completedQuantity → 计划单/订单完成 → 触发入库草稿。无路由产品保持成品直报。
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

  // ---------- I06 报工（工序推进·整批逐道）+ 状态聚合 + 入库草稿 ----------

  /** 行报工：完成「当前工序」→ 中间道推进到下一道 / 末道累计成品并完成 → 触发入库单草稿 */
  async report(planId: number, dto: { lineId: number; doneQty: number }) {
    const plan = await this.loadPlan(planId);
    if (plan.status !== 'confirmed' && plan.status !== 'production')
      throw new BadRequestException(`仅已确认/生产中计划单可报工（当前：${plan.status}）`);

    const [line] = await db
      .select()
      .from(planSheetLines)
      .where(and(eq(planSheetLines.id, dto.lineId), eq(planSheetLines.planSheetId, planId)));
    if (!line) throw new NotFoundException('计划单行不存在或不属于该计划单');

    const route = await this.routeFor(line.productId);
    if (route.length === 0) return this.reportDirect(plan, line, dto); // 无工序路由：成品直报

    // —— 工序推进（整批逐道）——
    const L = route.length;
    const cur = Math.min(line.routeSeq ?? 1, L);
    const step = route[cur - 1];
    const isLast = cur >= L;
    const required = isLast ? line.quantity - line.completedQuantity : line.quantity;
    if (dto.doneQty !== required)
      throw new BadRequestException(
        isLast
          ? `末道工序「${step.name}」须一次报满剩余 ${required} 只（已完成成品 ${line.completedQuantity}/${line.quantity}）`
          : `工序「${step.name}」（${cur}/${L}）须整批一次报满 ${required} 只才推进到下一道`,
      );

    if (isLast) {
      // 末道：成品累计到整批 → 完成聚合 + 入库草稿（复用成品直报的收尾），routeSeq 置 L+1 标记全走完
      return this.reportDirect(plan, line, { ...dto, doneQty: required }, L + 1);
    }

    // 中间道：推进指针 → 下一道（routeSeq+1、泳道换下一道、coverDays 复位自动）
    const next = route[cur]; // cur < L 时必存在
    let nextStartDate: string | null = null;
    if (line.startDate) {
      // 已排期则顺延到本工序排期结束次日（coverDays 优先，未覆盖按自动工期）
      const dur = line.coverDays ?? (await this.autoDaysFor(line.productId, line.wcKey, line.quantity));
      nextStartDate = addDays(String(line.startDate), Math.max(1, dur));
    }
    await db.transaction(async (tx) => {
      await tx.update(planSheetLines).set({
        routeSeq: cur + 1,
        wcKey: next.wcKey,
        coverDays: null,
        ...(nextStartDate ? { startDate: nextStartDate } : {}),
      }).where(eq(planSheetLines.id, line.id));
      // 首报开工：confirmed → production（留在排期池推进，池条件含 production）
      if (plan.status === 'confirmed')
        await tx.update(planSheets).set({ status: 'production' }).where(eq(planSheets.id, planId));
    });
    return this.findOne(planId);
  }

  /** 成品直报（无工序路由产品 / 末道工序收尾）：行成品累计 → 状态聚合 → 触发入库草稿 */
  private async reportDirect(
    plan: { id: number; orderId: number; status: PlanStatus },
    line: { id: number; planSheetId: number; productId: number; quantity: number; completedQuantity: number },
    dto: { lineId: number; doneQty: number },
    routeSeqFinal?: number, // 有路由末道报满后置 L+1（标记全走完）
  ) {
    const planId = plan.id;
    const [fresh] = await db
      .select()
      .from(planSheetLines)
      .where(eq(planSheetLines.id, line.id));
    if (!fresh) throw new NotFoundException('计划单行不存在');
    if (fresh.completedQuantity + dto.doneQty > fresh.quantity)
      throw new BadRequestException(
        `报工超量：已完成 ${fresh.completedQuantity}/${fresh.quantity}，本次最多可报 ${fresh.quantity - fresh.completedQuantity}`,
      );

    await db.transaction(async (tx) => {
      // 1. 行成品累计
      const newDone = fresh.completedQuantity + dto.doneQty;
      await tx
        .update(planSheetLines)
        .set({ completedQuantity: newDone, ...(routeSeqFinal ? { routeSeq: routeSeqFinal } : {}) })
        .where(eq(planSheetLines.id, fresh.id));

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
        .where(and(eq(goodsReceiptLines.receiptId, receipt.id), eq(goodsReceiptLines.planSheetLineId, fresh.id)));
      if (rline) {
        await tx
          .update(goodsReceiptLines)
          .set({ quantity: rline.quantity + dto.doneQty })
          .where(eq(goodsReceiptLines.id, rline.id));
      } else {
        await tx.insert(goodsReceiptLines).values({
          receiptId: receipt.id,
          planSheetLineId: fresh.id,
          productId: fresh.productId,
          quantity: dto.doneQty,
        });
      }
    });
    return this.findOne(planId);
  }

  // ---------- 列表 / 详情 ----------

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

  // ---------- 内部 helpers ----------

  /** 取计划单（不存在 404） */
  private async loadPlan(id: number) {
    const [plan] = await db.select().from(planSheets).where(eq(planSheets.id, id));
    if (!plan) throw new NotFoundException('计划单不存在');
    return plan;
  }

  /** 产品工序路由（按 seq 升序）；空 = 未配路由（成品直报） */
  private async routeFor(productId: number): Promise<RouteStep[]> {
    const rows = await db
      .select({
        processId: productProcesses.processId,
        name: processes.name,
        wcKey: processes.wcKey,
        seq: productProcesses.seq,
      })
      .from(productProcesses)
      .innerJoin(processes, eq(processes.id, productProcesses.processId))
      .where(eq(productProcesses.productId, productId))
      .orderBy(productProcesses.seq);
    return rows;
  }

  /** 为行补产品名 + 工序推进信息（当前工序/应报数/完成态，批量避免 N+1） */
  private async attachLines(rows: Array<Record<string, any>>) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.plan.id);
    const lines = await db
      .select({ line: planSheetLines, productName: products.name })
      .from(planSheetLines)
      .leftJoin(products, eq(planSheetLines.productId, products.id))
      .where(inArray(planSheetLines.planSheetId, ids))
      .orderBy(planSheetLines.id);
    // 批量拉产品工序路由
    const productIds = [...new Set(lines.map((l) => l.line.productId))];
    const routeRows = productIds.length
      ? await db
          .select({
            productId: productProcesses.productId,
            processId: productProcesses.processId,
            name: processes.name,
            wcKey: processes.wcKey,
            seq: productProcesses.seq,
          })
          .from(productProcesses)
          .innerJoin(processes, eq(processes.id, productProcesses.processId))
          .where(inArray(productProcesses.productId, productIds))
          .orderBy(productProcesses.seq)
      : [];
    const routeByProduct = new Map<number, RouteStep[]>();
    for (const r of routeRows) {
      const arr = routeByProduct.get(r.productId) ?? [];
      arr.push({ processId: r.processId, name: r.name, wcKey: r.wcKey, seq: r.seq });
      routeByProduct.set(r.productId, arr);
    }
    const byPlan = new Map<number, Array<any>>();
    for (const { line, productName } of lines) {
      const route = routeByProduct.get(line.productId) ?? [];
      const L = route.length;
      const seq = line.routeSeq ?? 1;
      const cur = L ? Math.min(seq, L) : 1;
      const finished = L ? seq > L : (line.completedQuantity ?? 0) >= line.quantity;
      const curStep = L ? route[cur - 1] : null;
      const requiredQty = !L
        ? line.quantity - (line.completedQuantity ?? 0) // 成品直报：剩余量（可分批）
        : cur >= L
          ? line.quantity - (line.completedQuantity ?? 0) // 末道：剩余量（整批）
          : line.quantity; // 中间道：整批一次
      const enriched = {
        ...line,
        productName,
        routeTotal: L,
        currentStepName: curStep?.name ?? null,
        currentWcKey: curStep?.wcKey ?? null,
        finished,
        requiredQty: Math.max(0, requiredQty),
      };
      const arr = byPlan.get(line.planSheetId) ?? [];
      arr.push(enriched);
      byPlan.set(line.planSheetId, arr);
    }
    return rows.map(({ plan, ...rest }) => ({
      ...plan,
      ...rest,
      lines: byPlan.get(plan.id) ?? [],
    }));
  }

  /** 某产品×泳道的单件耗时（秒）；无配置 → null */
  private async unitSecondsOf(productId: number, wcKey: string): Promise<number | null> {
    const r = await db.execute(sql`
      SELECT pp.unit_seconds
        FROM product_processes pp
        JOIN processes p ON p.id = pp.process_id
       WHERE pp.product_id = ${productId} AND p.wc_key = ${wcKey}
       ORDER BY pp.seq LIMIT 1
    `);
    const row = (r as any).rows?.[0];
    return row?.unit_seconds == null ? null : Number(row.unit_seconds);
  }

  /** 行在指定泳道的自动工期（天）；无耗时 → 占位 1 天 */
  private async autoDaysFor(productId: number, wcKey: string | null, quantity: number): Promise<number> {
    if (!wcKey) return 1;
    const wcs = await db.select().from(workCenters).where(eq(workCenters.key, wcKey));
    const machines = wcs[0]?.machines ?? 1;
    const unit = await this.unitSecondsOf(productId, wcKey);
    if (unit == null || unit <= 0) return 1;
    return Math.max(1, Math.ceil((quantity * unit) / 60 / Math.max(1, machines) / SHIFT_MIN));
  }
}
