import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  customers, goodsReceipts, goodsReceiptLines, incomingGoods, inventory, orderLines, orders,
  outboundLines, outbounds, payables, planSheets, products, receivables, stocktakes, suppliers,
} from '../db/schema';
import type { Outbound, PackagingSpec } from '../db/schema';

const pad2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 当日流水号：按单号前缀映射所在表 */
async function nextSeqNo(tx: Tx, prefix: string): Promise<string> {
  const tables = [
    { p: 'GR-', t: goodsReceipts, col: goodsReceipts.receiptNo },
    { p: 'FG-', t: goodsReceipts, col: goodsReceipts.batchNo },
    { p: 'OUT-', t: outbounds, col: outbounds.shipNo },
    { p: 'IN-', t: incomingGoods, col: incomingGoods.incomingNo },
    { p: 'ST-', t: stocktakes, col: stocktakes.stocktakeNo },
    { p: 'REC-', t: receivables, col: receivables.recvNo },
    { p: 'PAY-', t: payables, col: payables.payNo },
  ];
  const hit = tables.find((x) => prefix.startsWith(x.p));
  if (!hit) throw new Error(`未知单号前缀：${prefix}`);
  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(hit.t)
    .where(like(hit.col, `${prefix}%`));
  return `${prefix}${pad2(count + 1)}`;
}

/**
 * 仓储域（I08，spec §6）：
 * 库存 / 入库确认与冲销 / 出库（挂订单·OQC 先检后出·FIFO 扣库存·生成应收）/
 * 来料登记（生成应付）/ 盘点校准 / 冲销回补
 */
@Injectable()
export class WarehouseService {
  // ==================== 库存 ====================
  async inventoryList() {
    const rows = await db
      .select({ inv: inventory, productName: products.name, safetyStock: products.safetyStock })
      .from(inventory)
      .innerJoin(products, eq(inventory.productId, products.id))
      .orderBy(asc(inventory.id));
    return rows.map(({ inv, ...rest }) => ({
      ...inv,
      productName: rest.productName,
      safetyStock: rest.safetyStock,
      low: inv.quantity < rest.safetyStock,
    }));
  }

  // ==================== 入库单 ====================
  async receipts() {
    const rows = await db
      .select({ r: goodsReceipts, planNo: planSheets.planNo })
      .from(goodsReceipts)
      .leftJoin(planSheets, eq(goodsReceipts.planSheetId, planSheets.id))
      .orderBy(desc(goodsReceipts.id));
    if (!rows.length) return [];
    const ids = rows.map((x) => x.r.id);
    const lines = await db
      .select({ l: goodsReceiptLines, productName: products.name })
      .from(goodsReceiptLines)
      .leftJoin(products, eq(goodsReceiptLines.productId, products.id))
      .where(inArray(goodsReceiptLines.receiptId, ids))
      .orderBy(goodsReceiptLines.id);
    const byId = new Map<number, any[]>();
    for (const { l, productName } of lines) {
      const arr = byId.get(l.receiptId) ?? [];
      arr.push({ ...l, productName });
      byId.set(l.receiptId, arr);
    }
    return rows.map(({ r, planNo }) => ({ ...r, planNo, lines: byId.get(r.id) ?? [] }));
  }

  /** 入库确认：草稿 → 已确认；按行批次入库（库存+） */
  async confirmReceipt(id: number) {
    const [r] = await db.select().from(goodsReceipts).where(eq(goodsReceipts.id, id));
    if (!r) throw new NotFoundException('入库单不存在');
    if (r.status !== 'draft') throw new BadRequestException(`仅草稿入库单可确认（当前：${r.status}）`);
    const lines = await db.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.receiptId, id));
    if (!lines.length) throw new BadRequestException('入库单没有可确认的行（先报工产生草稿行）');
    await db.transaction(async (tx) => {
      await tx.update(goodsReceipts).set({ status: 'confirmed', confirmedAt: new Date() }).where(eq(goodsReceipts.id, id));
      for (const l of lines) await this.bumpStock(tx, l.productId, r.batchNo, l.quantity);
    });
    return this.receipts().then((all) => all.find((x) => x.id === id));
  }

  /** 入库冲销：已确认 → 已冲销（库存回减抵销原入账） */
  async voidReceipt(id: number) {
    const [r] = await db.select().from(goodsReceipts).where(eq(goodsReceipts.id, id));
    if (!r) throw new NotFoundException('入库单不存在');
    if (r.status !== 'confirmed') throw new BadRequestException(`仅已确认入库单可冲销（当前：${r.status}）`);
    const lines = await db.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.receiptId, id));
    await db.transaction(async (tx) => {
      await tx.update(goodsReceipts).set({ status: 'voided' }).where(eq(goodsReceipts.id, id));
      for (const l of lines) await this.bumpStock(tx, l.productId, r.batchNo, -l.quantity);
    });
    return this.receipts().then((all) => all.find((x) => x.id === id));
  }

  // ==================== 出库单 ====================
  async outboundsList() {
    const rows = await db
      .select({
        o: outbounds, orderNo: orders.orderNo, customerId: orders.customerId, customerName: customers.name,
      })
      .from(outbounds)
      .innerJoin(orders, eq(outbounds.orderId, orders.id))
      .leftJoin(customers, eq(orders.customerId, customers.id))
      .orderBy(desc(outbounds.id));
    if (!rows.length) return [];
    const ids = rows.map((x) => x.o.id);
    const lines = await db
      .select({ l: outboundLines, productName: products.name })
      .from(outboundLines)
      .leftJoin(products, eq(outboundLines.productId, products.id))
      .where(inArray(outboundLines.outboundId, ids))
      .orderBy(outboundLines.id);
    const byId = new Map<number, any[]>();
    for (const { l, productName } of lines) {
      const arr = byId.get(l.outboundId) ?? [];
      arr.push({ ...l, productName });
      byId.set(l.outboundId, arr);
    }
    return rows.map(({ o, ...rest }) => ({ ...o, ...rest, lines: byId.get(o.id) ?? [] }));
  }

  /** 新建出库草稿：选订单 + 行（可分批），数量不超订单行剩余未出 */
  async createOutbound(dto: { orderId: number; oqc: 'pending' | 'exempt'; lines: Array<{ orderLineId: number; quantity: number }> }) {
    const [order] = await db.select().from(orders).where(eq(orders.id, dto.orderId));
    if (!order) throw new NotFoundException('订单不存在');
    // 生产完成（completed）后方可发货；生产中亦可；草稿/取消不可
    if (order.status !== 'confirmed' && order.status !== 'production' && order.status !== 'completed')
      throw new BadRequestException(`仅生产中/已完成订单可出库（当前：${order.status}）`);
    if (!dto.lines.length) throw new BadRequestException('出库行不能为空');

    const ols = await db.select().from(orderLines).where(inArray(orderLines.id, dto.lines.map((l) => l.orderLineId)));
    if (ols.length !== dto.lines.length) throw new BadRequestException('存在不属于该订单的出库行');
    const olById = new Map(ols.map((l) => [l.id, l]));

    // 草稿可先建（允许并行准备多批）；超量强校验在提交时做（assertNotOverShip）
    for (const l of dto.lines) {
      const ol = olById.get(l.orderLineId)!;
      if (l.quantity <= 0) throw new BadRequestException('出库数量须为正数');
      if (l.quantity > ol.quantity) throw new BadRequestException(`超出订单行数量：该行仅 ${ol.quantity}`);
    }

    const created = await db.transaction(async (tx) => {
      const [o] = await tx
        .insert(outbounds)
        .values({
          shipNo: await nextSeqNo(tx, `OUT-${ymd(new Date())}-`),
          orderId: dto.orderId,
          oqc: dto.oqc,
        })
        .returning();
      await tx.insert(outboundLines).values(
        dto.lines.map((l) => ({
          outboundId: o.id,
          orderLineId: l.orderLineId,
          productId: olById.get(l.orderLineId)!.productId,
          quantity: l.quantity,
          packaging: olById.get(l.orderLineId)!.packaging ?? null,
        })),
      );
      return o;
    });
    return this.outboundsList().then((all) => all.find((x) => x.id === created.id));
  }

  /** 提交出库：草稿 →（免检直出 / 普通转 OQC 待检）；提交时强校验分批累计 ≤ 订单行数量 */
  async submitOutbound(id: number) {
    const o = await this.loadOutbound(id);
    if (o.status !== 'draft') throw new BadRequestException(`仅草稿出库单可提交（当前：${o.status}）`);
    await this.assertNotOverShip(o);
    if (o.oqc === 'exempt') return this.shipOutbound(id);
    await db.update(outbounds).set({ status: 'pending' }).where(eq(outbounds.id, id));
    return this.outboundsList().then((all) => all.find((x) => x.id === id));
  }

  /** 分批强校验：本单 + 已提交/已出库 累计不得超过订单行数量 */
  private async assertNotOverShip(o: Outbound) {
    const myLines = await db.select().from(outboundLines).where(eq(outboundLines.outboundId, o.id));
    const ols = await db
      .select()
      .from(orderLines)
      .where(inArray(orderLines.id, myLines.map((l) => l.orderLineId)));
    const oq = new Map(ols.map((l) => [l.id, l.quantity]));
    const shipped = await db
      .select({ olId: outboundLines.orderLineId, qty: outboundLines.quantity })
      .from(outboundLines)
      .innerJoin(outbounds, eq(outboundLines.outboundId, outbounds.id))
      .where(inArray(outbounds.status, ['pending', 'shipped']));
    const sums = new Map<number, number>();
    for (const s of shipped) sums.set(s.olId, (sums.get(s.olId) ?? 0) + s.qty);
    for (const l of myLines) {
      const total = (sums.get(l.orderLineId) ?? 0) + l.quantity;
      const qty = oq.get(l.orderLineId) ?? 0;
      if (total > qty)
        throw new BadRequestException(`分批超量：订单行累计出库 ${total} > 订单数量 ${qty}`);
    }
  }

  /** OQC 放行：待检 → 已出库（FIFO 扣库存 + 生成应收） */
  async oqcPass(id: number) {
    const o = await this.loadOutbound(id);
    if (o.status !== 'pending') throw new BadRequestException(`仅待检出库单可放行（当前：${o.status}）`);
    return this.shipOutbound(id);
  }

  /** 删除草稿（误建/放弃） */
  async removeDraft(id: number) {
    const o = await this.loadOutbound(id);
    if (o.status !== 'draft') throw new BadRequestException(`仅草稿出库单可删除（当前：${o.status}）`);
    await db.delete(outboundLines).where(eq(outboundLines.outboundId, id));
    await db.delete(outbounds).where(eq(outbounds.id, id));
    return { ok: true };
  }

  /** 出库冲销：已出库 → 已冲销（库存回补；应收未核销则一并冲销） */
  async voidOutbound(id: number) {
    const o = await this.loadOutbound(id);
    if (o.status !== 'shipped') throw new BadRequestException(`仅已出库单可冲销（当前：${o.status}）`);
    const [recv] = await db
      .select()
      .from(receivables)
      .where(and(eq(receivables.sourceId, id), eq(receivables.sourceType, 'outbound')));
    if (recv && recv.settledAmount > 0)
      throw new BadRequestException(`应收 ${recv.recvNo} 已核销，请先冲销收款（I09）`);
    const lines = await db.select().from(outboundLines).where(eq(outboundLines.outboundId, id));
    await db.transaction(async (tx) => {
      await tx.update(outbounds).set({ status: 'voided' }).where(eq(outbounds.id, id));
      for (const l of lines) await this.addBackToEarliest(tx, l.productId, l.quantity);
      if (recv) await tx.update(receivables).set({ status: 'voided' }).where(eq(receivables.id, recv.id));
    });
    return this.outboundsList().then((all) => all.find((x) => x.id === id));
  }

  /** 放行核心：FIFO 扣库存 + 自动生成应收（I09 界面/核销消费） */
  private async shipOutbound(id: number) {
    const o = await this.loadOutbound(id);
    const lines = await db.select().from(outboundLines).where(eq(outboundLines.outboundId, id));
    const ols = await db.select().from(orderLines).where(inArray(orderLines.id, lines.map((l) => l.orderLineId)));
    const olById = new Map(ols.map((l) => [l.id, l]));
    const [order] = await db.select().from(orders).where(eq(orders.id, o.orderId));
    const [cust] = await db.select().from(customers).where(eq(customers.id, order.customerId));

    await db.transaction(async (tx) => {
      await tx.update(outbounds).set({ status: 'shipped', shippedAt: new Date() }).where(eq(outbounds.id, id));
      for (const l of lines) await this.deductStock(tx, l.productId, l.quantity);
      const amount = lines.reduce((s, l) => s + l.quantity * olById.get(l.orderLineId)!.unitPrice, 0);
      await tx.insert(receivables).values({
        recvNo: await nextSeqNo(tx, `REC-${ymd(new Date())}-`),
        customerId: order.customerId,
        sourceType: 'outbound',
        sourceId: id,
        amount,
        currency: ols[0]?.currency ?? 'RMB',
        dueDate: cust.creditDays > 0 ? new Date(Date.now() + cust.creditDays * 86400000) : null,
        status: 'draft',
      });
    });
    const one = (await this.outboundsList()).find((x) => x.id === id);
    return { ...one, generatedAmount: lines.reduce((s, l) => s + l.quantity * olById.get(l.orderLineId)!.unitPrice, 0) };
  }

  private async loadOutbound(id: number) {
    const [o] = await db.select().from(outbounds).where(eq(outbounds.id, id));
    if (!o) throw new NotFoundException('出库单不存在');
    return o;
  }

  // ==================== 来料登记 ====================
  async incomingList() {
    const rows = await db
      .select({ g: incomingGoods, supplierName: suppliers.name })
      .from(incomingGoods)
      .leftJoin(suppliers, eq(incomingGoods.supplierId, suppliers.id))
      .orderBy(desc(incomingGoods.id));
    return rows.map(({ g, supplierName }) => ({ ...g, supplierName }));
  }

  async createIncoming(dto: { supplierId: number; materialName: string; quantity: number; amount: number; batchNo?: string }) {
    const [s] = await db.select().from(suppliers).where(eq(suppliers.id, dto.supplierId));
    if (!s) throw new NotFoundException('供应商不存在');
    if (!dto.materialName?.trim()) throw new BadRequestException('物料名必填');
    if (dto.quantity <= 0 || dto.amount <= 0) throw new BadRequestException('数量与金额须为正数');
    await db.transaction(async (tx) => {
      const [g] = await tx
        .insert(incomingGoods)
        .values({
          incomingNo: await nextSeqNo(tx, `IN-${ymd(new Date())}-`),
          supplierId: dto.supplierId,
          materialName: dto.materialName.trim(),
          quantity: dto.quantity,
          amount: dto.amount,
          batchNo: dto.batchNo ?? null,
          iqcStatus: 'pending', // IQC 预留：一期线下纸质，登记默认待检
        })
        .returning();
      await tx.insert(payables).values({
        payNo: await nextSeqNo(tx, `PAY-${ymd(new Date())}-`),
        supplierId: dto.supplierId,
        sourceType: 'incoming',
        sourceId: g.id,
        amount: dto.amount,
        status: 'draft',
      });
    });
    return this.incomingList();
  }

  // ==================== 盘点 ====================
  async stocktakesList() {
    const rows = await db
      .select({ s: stocktakes, productName: products.name })
      .from(stocktakes)
      .leftJoin(products, eq(stocktakes.productId, products.id))
      .orderBy(desc(stocktakes.id));
    return rows.map(({ s, productName }) => ({ ...s, productName }));
  }

  /** 建档盘点：对 SKU×批次录实盘数（账面自动取现库存） */
  async createStocktake(dto: { productId: number; batchNo: string; actualQty: number }) {
    const [p] = await db.select().from(products).where(eq(products.id, dto.productId));
    if (!p) throw new NotFoundException('产品不存在');
    if (!dto.batchNo?.trim()) throw new BadRequestException('批次号必填');
    if (dto.actualQty < 0) throw new BadRequestException('实盘数不能为负');
    const [inv] = await db
      .select()
      .from(inventory)
      .where(and(eq(inventory.productId, dto.productId), eq(inventory.batchNo, dto.batchNo)));
    const bookQty = inv?.quantity ?? 0;
    await db.transaction(async (tx) => {
      await tx.insert(stocktakes).values({
        stocktakeNo: await nextSeqNo(tx, `ST-${ymd(new Date())}-`),
        productId: dto.productId,
        batchNo: dto.batchNo,
        bookQty,
        actualQty: dto.actualQty,
        diffQty: dto.actualQty - bookQty,
      });
    });
    return this.stocktakesList();
  }

  /** 确认盘点：校准库存到实盘数（盘盈/盘亏调整，留痕） */
  async confirmStocktake(id: number) {
    const [s] = await db.select().from(stocktakes).where(eq(stocktakes.id, id));
    if (!s) throw new NotFoundException('盘点单不存在');
    if (s.status !== 'draft') throw new BadRequestException(`仅草稿盘点单可确认（当前：${s.status}）`);
    await db.transaction(async (tx) => {
      await tx.update(stocktakes).set({ status: 'confirmed', confirmedAt: new Date() }).where(eq(stocktakes.id, id));
      const [inv] = await tx
        .select()
        .from(inventory)
        .where(and(eq(inventory.productId, s.productId), eq(inventory.batchNo, s.batchNo)));
      if (inv) await tx.update(inventory).set({ quantity: s.actualQty }).where(eq(inventory.id, inv.id));
      else await tx.insert(inventory).values({ productId: s.productId, batchNo: s.batchNo, quantity: s.actualQty });
    });
    return this.stocktakesList();
  }

  // ==================== 库存内部操作 ====================
  /** 明确批次 ±delta（入库/冲销回补） */
  private async bumpStock(tx: Tx, productId: number, batchNo: string, delta: number) {
    const [inv] = await tx
      .select()
      .from(inventory)
      .where(and(eq(inventory.productId, productId), eq(inventory.batchNo, batchNo)));
    if (inv) {
      await tx.update(inventory).set({ quantity: inv.quantity + delta }).where(eq(inventory.id, inv.id));
    } else {
      await tx.insert(inventory).values({ productId, batchNo, quantity: delta });
    }
  }

  /** 冲销回补：加回到最早库存行（与 FIFO 扣减近似可逆）；无行则建占位行 */
  private async addBackToEarliest(tx: Tx, productId: number, qty: number) {
    const [first] = await tx.select().from(inventory).where(eq(inventory.productId, productId)).orderBy(asc(inventory.id)).limit(1);
    if (first) {
      await tx.update(inventory).set({ quantity: first.quantity + qty }).where(eq(inventory.id, first.id));
    } else {
      await tx.insert(inventory).values({ productId, batchNo: 'FG-冲销回补', quantity: qty });
    }
  }

  /** 出库扣减：FIFO 从最早批次扣；正库存不足 → 允许负库存 */
  private async deductStock(tx: Tx, productId: number, qty: number) {
    const rows = await tx.select().from(inventory).where(eq(inventory.productId, productId)).orderBy(asc(inventory.id));
    let remain = qty;
    for (const r of rows) {
      if (remain <= 0) break;
      if (r.quantity <= 0) continue;
      const take = Math.min(r.quantity, remain);
      await tx.update(inventory).set({ quantity: r.quantity - take }).where(eq(inventory.id, r.id));
      remain -= take;
    }
    if (remain > 0) {
      if (rows.length) {
        await tx.update(inventory).set({ quantity: rows[0].quantity - remain }).where(eq(inventory.id, rows[0].id));
      } else {
        await tx.insert(inventory).values({ productId, batchNo: 'FG-未入库', quantity: -remain });
      }
    }
  }
}
