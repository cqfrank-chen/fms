import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, like, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  customers, goodsReceipts, goodsReceiptLines, incomingGoods, inventory, orderLines, orders,
  outboundAllocations, outboundLines, outbounds, payables, planSheets, products, receivables, stocktakes, suppliers,
} from '../db/schema';
import type { Outbound, PackagingSpec } from '../db/schema';
import { fromCents, MONEY_EPS, round2, sumLineCents, toCents } from '../common/money';
import { currentOperatorId } from '../common/operator-context';

const pad2 = (n: number) => String(n).padStart(2, '0');
/** 占位批次：非真实入库，禁止参与 FIFO 扣减，避免"假库存"被当货发出去 */
const PLACEHOLDER_BATCHES = ['FG-未入库', 'FG-冲销回补'];
const PLACEHOLDER_SHORTFALL = 'FG-未入库';
const ymd = (d: Date) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 当日流水号：按单号前缀映射所在表；取当天最大序号+1（count 在删除后会复用旧号） */
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
  const res = (await tx.execute(
    sql`select max(substring(${hit.col} from '[0-9]+$')::int) as mx from ${hit.t} where ${hit.col} like ${`${prefix}%`}`,
  )) as unknown as { rows: Array<{ mx: number | null }> };
  return `${prefix}${pad2((res.rows?.[0]?.mx ?? 0) + 1)}`;
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

  /** 入库确认：草稿 → 已确认；按行批次入库（库存+）。状态流转走事务内条件更新，防并发重复确认 */
  async confirmReceipt(id: number) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(goodsReceipts)
        .set({ status: 'confirmed', confirmedAt: new Date(), updatedAt: new Date(), operatorId: currentOperatorId() })
        .where(and(eq(goodsReceipts.id, id), eq(goodsReceipts.status, 'draft')))
        .returning();
      if (!updated.length) {
        const [cur] = await tx.select().from(goodsReceipts).where(eq(goodsReceipts.id, id));
        if (!cur) throw new NotFoundException('入库单不存在');
        throw new BadRequestException(`仅草稿入库单可确认（当前：${cur.status}）`);
      }
      const r = updated[0];
      const lines = await tx.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.receiptId, id));
      if (!lines.length) throw new BadRequestException('入库单没有可确认的行（先报工产生草稿行）');
      for (const l of lines) await this.bumpStock(tx, l.productId, r.batchNo, l.quantity);
    });
    return this.receipts().then((all) => all.find((x) => x.id === id));
  }

  /** 无订单手动入库（备货/打样/返工回仓）：生成入库草稿 → 仓管确认 → 库存+；不进应收/成本账 */
  async createManualReceipt(dto: { productId: number; quantity: number; batchNo?: string; note?: string }) {
    const [prod] = await db.select().from(products).where(eq(products.id, dto.productId));
    if (!prod) throw new NotFoundException('产品不存在');
    if (dto.quantity <= 0) throw new BadRequestException('入库数量须为正数');
    await db.transaction(async (tx) => {
      const now = new Date();
      const receiptNo = await nextSeqNo(tx, `GR-${ymd(now)}-`);
      let batchNo = dto.batchNo?.trim() || '';
      if (!batchNo) batchNo = await nextSeqNo(tx, `FG-${ymd(now)}-`);
      const [g] = await tx
        .insert(goodsReceipts)
        .values({ receiptNo, planSheetId: null, batchNo, note: dto.note ?? null, operatorId: currentOperatorId() })
        .returning();
      await tx.insert(goodsReceiptLines).values({
        receiptId: g.id,
        planSheetLineId: null,
        productId: dto.productId,
        quantity: dto.quantity,
      });
    });
    return this.receipts().then((all) => all[0]);
  }

  /** 入库冲销：已确认 → 已冲销（库存回减抵销原入账）。状态流转与库存回减同事务原子完成 */
  async voidReceipt(id: number) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(goodsReceipts)
        .set({ status: 'voided', updatedAt: new Date() })
        .where(and(eq(goodsReceipts.id, id), eq(goodsReceipts.status, 'confirmed')))
        .returning();
      if (!updated.length) {
        const [cur] = await tx.select().from(goodsReceipts).where(eq(goodsReceipts.id, id));
        if (!cur) throw new NotFoundException('入库单不存在');
        throw new BadRequestException(`仅已确认入库单可冲销（当前：${cur.status}）`);
      }
      const r = updated[0];
      const lines = await tx.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.receiptId, id));
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

    const ols = await db
      .select()
      .from(orderLines)
      .where(and(inArray(orderLines.id, dto.lines.map((l) => l.orderLineId)), eq(orderLines.orderId, dto.orderId)));
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
          operatorId: currentOperatorId(),
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
    if (o.oqc === 'exempt') return this.shipOutbound(id, 'draft', '仅草稿出库单可提交');
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(outbounds)
        .set({ status: 'pending', updatedAt: new Date() })
        .where(and(eq(outbounds.id, id), eq(outbounds.status, 'draft')))
        .returning({ id: outbounds.id });
      if (!updated.length) {
        const [cur] = await tx.select().from(outbounds).where(eq(outbounds.id, id));
        if (!cur) throw new NotFoundException('出库单不存在');
        throw new BadRequestException(`仅草稿出库单可提交（当前：${cur.status}）`);
      }
    });
    return this.outboundsList().then((all) => all.find((x) => x.id === id));
  }

  /** 分批强校验：本单 + 已提交/已出库 累计不得超过订单行数量 */
  private async assertNotOverShip(o: Outbound) {
    const myLines = await db.select().from(outboundLines).where(eq(outboundLines.outboundId, o.id));
    // 防御历史脏数据：出库行必须归属本单订单，否则拒绝提交
    const lineOlIds = [...new Set(myLines.map((l) => l.orderLineId))];
    const ols = lineOlIds.length
      ? await db
          .select()
          .from(orderLines)
          .where(and(inArray(orderLines.id, lineOlIds), eq(orderLines.orderId, o.orderId)))
      : [];
    if (ols.length !== lineOlIds.length) throw new BadRequestException('存在不属于该订单的出库行');
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
    return this.shipOutbound(id, 'pending', '仅待检出库单可放行');
  }

  /** 删除草稿（误建/放弃）：条件删除草稿（outbound_lines 随外键级联删除），防并发误删已流转单 */
  async removeDraft(id: number) {
    await db.transaction(async (tx) => {
      const deleted = await tx
        .delete(outbounds)
        .where(and(eq(outbounds.id, id), eq(outbounds.status, 'draft')))
        .returning({ id: outbounds.id });
      if (!deleted.length) {
        const [cur] = await tx.select().from(outbounds).where(eq(outbounds.id, id));
        if (!cur) throw new NotFoundException('出库单不存在');
        throw new BadRequestException(`仅草稿出库单可删除（当前：${cur.status}）`);
      }
    });
    return { ok: true };
  }

  /** 出库冲销：已出库 → 已冲销（库存回补；订单级应收按本次退回金额冲减，减到 0 则整单冲销） */
  async voidOutbound(id: number) {
    const o = await this.loadOutbound(id);
    if (o.status !== 'shipped') throw new BadRequestException(`仅已出库单可冲销（当前：${o.status}）`);
    const lines = await db.select().from(outboundLines).where(eq(outboundLines.outboundId, id));
    const ols = await db.select().from(orderLines).where(inArray(orderLines.id, lines.map((l) => l.orderLineId)));
    const olById = new Map(ols.map((l) => [l.id, l]));
    const backAmount = fromCents(
      sumLineCents(lines.map((l) => ({ quantity: l.quantity, unitPrice: Number(olById.get(l.orderLineId)?.unitPrice ?? 0) }))),
    );
    await db.transaction(async (tx) => {
      // 条件更新：并发/重复冲销只有一次能把 shipped → voided，避免库存与应收被重复抵销
      const voided = await tx
        .update(outbounds)
        .set({ status: 'voided', updatedAt: new Date() })
        .where(and(eq(outbounds.id, id), eq(outbounds.status, 'shipped')))
        .returning({ id: outbounds.id });
      if (!voided.length) {
        const [cur] = await tx.select().from(outbounds).where(eq(outbounds.id, id));
        if (!cur) throw new NotFoundException('出库单不存在');
        throw new BadRequestException(`仅已出库单可冲销（当前：${cur.status}）`);
      }
      // 按出库时的批次归因精确回补；修复前历史单据无归因 → 回退「回补最早行」兼容路径
      for (const l of lines) {
        const allocs = await tx.select().from(outboundAllocations).where(eq(outboundAllocations.outboundLineId, l.id));
        if (allocs.length) {
          for (const a of allocs) await this.bumpStock(tx, l.productId, a.batchNo, a.quantity);
        } else {
          await this.addBackToEarliest(tx, l.productId, l.quantity);
        }
      }
      // 关联订单级应收（订单确认时开立，sourceType='order'）：货退回 → 欠款按退回金额冲减；行锁防并发冲减丢更新
      const [recv] = await tx
        .select()
        .from(receivables)
        .where(and(eq(receivables.sourceId, o.orderId), eq(receivables.sourceType, 'order'), ne(receivables.status, 'voided')))
        .for('update');
      if (recv && toCents(backAmount) > 0) {
        const rest = recv.amount - backAmount;
        if (recv.settledAmount > Math.max(0, rest) + MONEY_EPS)
          throw new BadRequestException(`应收 ${recv.recvNo} 已核销 ${recv.settledAmount}，超过退回后应剩 ${Math.max(0, rest)}，请先冲销对应收款单`);
        if (toCents(rest) <= 0)
          await tx.update(receivables).set({ status: 'voided', amount: 0, updatedAt: new Date() }).where(eq(receivables.id, recv.id));
        else
          await tx.update(receivables).set({ amount: round2(rest), updatedAt: new Date() }).where(eq(receivables.id, recv.id));
      }
    });
    return this.outboundsList().then((all) => all.find((x) => x.id === id));
  }

  /** 放行核心：按期望态条件更新为已出库（原子，防重复放行）→ FIFO 扣库存；免检直出 / OQC 放行复用 */
  private async shipOutbound(id: number, from: 'draft' | 'pending', errText: string) {
    const lines = await db.select().from(outboundLines).where(eq(outboundLines.outboundId, id));
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(outbounds)
        .set({ status: 'shipped', shippedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(outbounds.id, id), eq(outbounds.status, from)))
        .returning({ id: outbounds.id });
      if (!updated.length) {
        const [cur] = await tx.select().from(outbounds).where(eq(outbounds.id, id));
        if (!cur) throw new NotFoundException('出库单不存在');
        throw new BadRequestException(`${errText}（当前：${cur.status}）`);
      }
      // FIFO 扣减并落批次归因：冲销时按真实批次回补
      for (const l of lines) {
        const allocs = await this.deductStock(tx, l.productId, l.quantity);
        if (allocs.length) {
          await tx.insert(outboundAllocations).values(
            allocs.map((a) => ({ outboundLineId: l.id, inventoryId: a.inventoryId, batchNo: a.batchNo, quantity: a.quantity })),
          );
        }
      }
    });
    const one = (await this.outboundsList()).find((x) => x.id === id);
    return { ...one, shipped: true };
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
          operatorId: currentOperatorId(),
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

  /**
   * 来料冲销：错录来料不再永久污染材料成本。
   * 关联应付未核销则同步冲销；已核销则拒绝（需先冲销付款单，保证账目不断链）。
   */
  async voidIncoming(id: number) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(incomingGoods)
        .set({ status: 'voided', updatedAt: new Date() })
        .where(and(eq(incomingGoods.id, id), eq(incomingGoods.status, 'confirmed')))
        .returning();
      if (!updated.length) {
        const [cur] = await tx.select().from(incomingGoods).where(eq(incomingGoods.id, id));
        if (!cur) throw new NotFoundException('来料登记单不存在');
        throw new BadRequestException(`仅已确认的来料登记可冲销（当前：${cur.status}）`);
      }
      const [pay] = await tx
        .select()
        .from(payables)
        .where(and(eq(payables.sourceType, 'incoming'), eq(payables.sourceId, id)))
        .for('update');
      if (pay && pay.status !== 'voided') {
        if (toCents(pay.settledAmount) > 0) {
          throw new BadRequestException(`关联应付 ${pay.payNo} 已核销 ${pay.settledAmount}，请先冲销付款单再冲销来料`);
        }
        await tx.update(payables).set({ status: 'voided', amount: 0, updatedAt: new Date() }).where(eq(payables.id, pay.id));
      }
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

  /** 确认盘点：draft→confirmed（条件更新，防并发重复确认）后校准库存到实盘数（盘盈/盘亏调整，留痕） */
  async confirmStocktake(id: number) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(stocktakes)
        .set({ status: 'confirmed', confirmedAt: new Date(), updatedAt: new Date(), operatorId: currentOperatorId() })
        .where(and(eq(stocktakes.id, id), eq(stocktakes.status, 'draft')))
        .returning();
      if (!updated.length) {
        const [cur] = await tx.select().from(stocktakes).where(eq(stocktakes.id, id));
        if (!cur) throw new NotFoundException('盘点单不存在');
        throw new BadRequestException(`仅草稿盘点单可确认（当前：${cur.status}）`);
      }
      const s = updated[0];
      const [inv] = await tx
        .select()
        .from(inventory)
        .where(and(eq(inventory.productId, s.productId), eq(inventory.batchNo, s.batchNo)));
      if (inv) await tx.update(inventory).set({ quantity: s.actualQty, updatedAt: new Date() }).where(eq(inventory.id, inv.id));
      else await tx.insert(inventory).values({ productId: s.productId, batchNo: s.batchNo, quantity: s.actualQty });
    });
    return this.stocktakesList();
  }

  /**
   * 盘点冲销：把确认时「账面→实盘」的差异反向应用回去。
   * 采用反向增量（-diffQty）而非覆盖为账面数，避免覆盖确认后发生的正常出入库。
   */
  async voidStocktake(id: number) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(stocktakes)
        .set({ status: 'voided', updatedAt: new Date() })
        .where(and(eq(stocktakes.id, id), eq(stocktakes.status, 'confirmed')))
        .returning();
      if (!updated.length) {
        const [cur] = await tx.select().from(stocktakes).where(eq(stocktakes.id, id));
        if (!cur) throw new NotFoundException('盘点单不存在');
        throw new BadRequestException(`仅已确认的盘点单可冲销（当前：${cur.status}）`);
      }
      const s = updated[0];
      if (s.diffQty !== 0) await this.bumpStock(tx, s.productId, s.batchNo, -s.diffQty);
    });
    return this.stocktakesList();
  }

  // ==================== 库存内部操作 ====================
  /** 明确批次 ±delta（入库/冲销回补）：命中即原子自增；缺失则插入（并发撞唯一键转自增，避免读改写丢更新） */
  private async bumpStock(tx: Tx, productId: number, batchNo: string, delta: number) {
    const bumped = await tx
      .update(inventory)
      .set({ quantity: sql`${inventory.quantity} + ${delta}`, updatedAt: new Date() })
      .where(and(eq(inventory.productId, productId), eq(inventory.batchNo, batchNo)))
      .returning({ id: inventory.id });
    if (bumped.length) return;
    await tx
      .insert(inventory)
      .values({ productId, batchNo, quantity: delta })
      .onConflictDoUpdate({
        target: [inventory.productId, inventory.batchNo],
        set: { quantity: sql`${inventory.quantity} + ${delta}`, updatedAt: new Date() },
      });
  }

  /** 冲销回补：锁定最早库存行后加回（与 FIFO 扣减近似可逆）；无行则建占位行 */
  private async addBackToEarliest(tx: Tx, productId: number, qty: number) {
    const [first] = await tx
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId))
      .orderBy(asc(inventory.id))
      .limit(1)
      .for('update');
    if (first) {
      await tx.update(inventory).set({ quantity: first.quantity + qty, updatedAt: new Date() }).where(eq(inventory.id, first.id));
    } else {
      await tx.insert(inventory).values({ productId, batchNo: 'FG-冲销回补', quantity: qty });
    }
  }

  /**
   * 出库扣减：按 id 升序 FOR UPDATE 锁定该产品批次行（统一锁序防死锁），FIFO 扣减。
   * - 占位批次（FG-未入库/FG-冲销回补）不参与 FIFO：假库存不得被当货发出
   * - 正库存不足 → 差额记到 FG-未入库 负库存（可追溯），并返回扣减归因供冲销精确回补
   */
  private async deductStock(tx: Tx, productId: number, qty: number): Promise<Array<{ inventoryId: number | null; batchNo: string; quantity: number }>> {
    const all = await tx
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId))
      .orderBy(asc(inventory.id))
      .for('update');
    const rows = all.filter((r) => !PLACEHOLDER_BATCHES.includes(r.batchNo));
    const allocs: Array<{ inventoryId: number | null; batchNo: string; quantity: number }> = [];
    let remain = qty;
    for (const r of rows) {
      if (remain <= 0) break;
      if (r.quantity <= 0) continue;
      const take = Math.min(r.quantity, remain);
      await tx.update(inventory).set({ quantity: r.quantity - take, updatedAt: new Date() }).where(eq(inventory.id, r.id));
      allocs.push({ inventoryId: r.id, batchNo: r.batchNo, quantity: take });
      remain -= take;
    }
    if (remain > 0) {
      await this.bumpStock(tx, productId, PLACEHOLDER_SHORTFALL, -remain);
      const [ph] = await tx
        .select()
        .from(inventory)
        .where(and(eq(inventory.productId, productId), eq(inventory.batchNo, PLACEHOLDER_SHORTFALL)));
      allocs.push({ inventoryId: ph?.id ?? null, batchNo: PLACEHOLDER_SHORTFALL, quantity: -remain });
    }
    return allocs;
  }
}
