import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  collectionSlipLines, collectionSlips, customers, incomingGoods, monthlyCosts, orders, outbounds,
  payables, paymentSlipLines, paymentSlips, receivables, suppliers,
} from '../db/schema';

const pad2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function nextSeqNo(tx: Tx, prefix: string): Promise<string> {
  const tables = [
    { p: 'CO-', t: collectionSlips, col: collectionSlips.collectNo },
    { p: 'PM-', t: paymentSlips, col: paymentSlips.payNo },
  ];
  const hit = tables.find((x) => prefix.startsWith(x.p));
  if (!hit) throw new Error(`未知单号前缀：${prefix}`);
  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(hit.t)
    .where(like(hit.col, `${prefix}%`));
  return `${prefix}${pad2(count + 1)}`;
}

const owing = (r: { amount: number; settledAmount: number }) => r.amount - r.settledAmount;

/**
 * 账目域（I09，spec §7）：
 * 应收/应付列表、收款/付款单（核销+预收预付双模式·一步生效·冲销）、
 * 对账单（账龄分桶标红）、利润视图（现金收付制营收）、月度成本六类、四表导出
 */
@Injectable()
export class AccountingService {
  // ==================== 应收/应付 ====================
  /** 应收来源 → 订单号解析：order 来源直接关联订单；outbound 历史数据（旧规则出货生成）经出库单中转 */
  private async resolveOrderNos(recvs: Array<{ sourceType: string | null; sourceId: number | null }>) {
    const map = new Map<number, string>();
    const orderIds = new Set<number>();
    const outIds = new Set<number>();
    for (const r of recvs) {
      if (r.sourceType === 'order' && r.sourceId != null) orderIds.add(r.sourceId);
      else if (r.sourceType === 'outbound' && r.sourceId != null) outIds.add(r.sourceId);
    }
    const ordRows = orderIds.size
      ? await db.select({ id: orders.id, no: orders.orderNo }).from(orders).where(inArray(orders.id, [...orderIds]))
      : [];
    for (const o of ordRows) map.set(o.id, o.no);
    const obRows = outIds.size
      ? await db.select({ id: outbounds.id, orderId: outbounds.orderId }).from(outbounds).where(inArray(outbounds.id, [...outIds]))
      : [];
    const mid = obRows.length
      ? await db.select({ id: orders.id, no: orders.orderNo }).from(orders).where(inArray(orders.id, obRows.map((x) => x.orderId)))
      : [];
    const noByOrder = new Map(mid.map((o) => [o.id, o.no]));
    for (const ob of obRows) map.set(ob.id, noByOrder.get(ob.orderId) ?? '');
    return map;
  }

  async receivablesList() {
    const rows = await db
      .select({ r: receivables, customerName: customers.name, shipNo: outbounds.shipNo })
      .from(receivables)
      .leftJoin(customers, eq(receivables.customerId, customers.id))
      .leftJoin(outbounds, and(eq(outbounds.id, receivables.sourceId), eq(receivables.sourceType, 'outbound')))
      .orderBy(asc(receivables.id));
    const orderNoBy = await this.resolveOrderNos(rows.map((x) => x.r));
    return rows.map(({ r, ...rest }) =>
      this.decorateReceivable(r, rest.customerName, rest.shipNo, orderNoBy.get(r.sourceId) ?? ''),
    );
  }

  private decorateReceivable(r: any, customerName?: string | null, shipNo?: string | null, orderNo?: string) {
    const remain = Math.max(0, owing(r));
    const ageDays = r.dueDate ? Math.floor((Date.now() - new Date(r.dueDate).getTime()) / 86400000) : 0;
    const bucket = ageDays <= 0 ? 'current' : ageDays <= 30 ? 'd30' : ageDays <= 60 ? 'd60' : ageDays <= 90 ? 'd90' : 'd90p';
    return {
      ...r,
      customerName: customerName ?? '',
      shipNo: shipNo ?? '',
      orderNo: orderNo ?? '',
      remain,
      overDue: ageDays > 0 && remain > 0,
      ageDays: Math.max(0, ageDays),
      bucket,
      settled: r.settledAmount >= r.amount,
    };
  }

  async payablesList() {
    const rows = await db
      .select({ p: payables, supplierName: suppliers.name, incomingNo: incomingGoods.incomingNo })
      .from(payables)
      .leftJoin(suppliers, eq(payables.supplierId, suppliers.id))
      .leftJoin(incomingGoods, and(eq(incomingGoods.id, payables.sourceId), eq(payables.sourceType, 'incoming')))
      .orderBy(asc(payables.id));
    return rows.map(({ p, ...rest }) => ({
      ...p,
      supplierName: rest.supplierName ?? '',
      incomingNo: rest.incomingNo ?? '',
      remain: Math.max(0, owing(p)),
      settled: p.settledAmount >= p.amount,
    }));
  }

  // ==================== 收款单 ====================
  async collectionSlipsList() {
    const rows = await db
      .select({ s: collectionSlips, customerName: customers.name })
      .from(collectionSlips)
      .leftJoin(customers, eq(collectionSlips.customerId, customers.id))
      .orderBy(desc(collectionSlips.id));
    if (!rows.length) return [];
    const ids = rows.map((x) => x.s.id);
    const lines = await db
      .select({
        l: collectionSlipLines, recvNo: receivables.recvNo,
        sourceType: receivables.sourceType, sourceId: receivables.sourceId,
      })
      .from(collectionSlipLines)
      .leftJoin(receivables, eq(collectionSlipLines.receivableId, receivables.id))
      .where(inArray(collectionSlipLines.slipId, ids))
      .orderBy(collectionSlipLines.id);
    const orderNoBy = await this.resolveOrderNos(lines);
    const byId = new Map<number, any[]>();
    for (const row of lines) {
      const arr = byId.get(row.l.slipId) ?? [];
      arr.push({ ...row.l, recvNo: row.recvNo, orderNo: orderNoBy.get(row.sourceId ?? -1) ?? '' });
      byId.set(row.l.slipId, arr);
    }
    return rows.map(({ s, customerName }) => ({ ...s, customerName, lines: byId.get(s.id) ?? [] }));
  }

  /** 新建收款单：settle 核销（可一张核销多笔/部分） / prepay 预收（挂客户贷方余额）；一步生效 */
  async createCollectionSlip(dto: { customerId: number; mode: 'settle' | 'prepay'; amount: number; note?: string; lines?: Array<{ receivableId: number; amount: number }> }) {
    const [cust] = await db.select().from(customers).where(eq(customers.id, dto.customerId));
    if (!cust) throw new NotFoundException('客户不存在');
    if (dto.amount <= 0) throw new BadRequestException('金额须为正数');
    if (dto.mode === 'prepay') {
      if (dto.lines?.length) throw new BadRequestException('预收模式不核销具体应收（出库后余额自动冲抵）');
    } else {
      if (!dto.lines?.length) throw new BadRequestException('核销模式至少选一笔应收');
      const sum = dto.lines.reduce((s, l) => s + l.amount, 0);
      if (Math.abs(sum - dto.amount) > 0.009) throw new BadRequestException(`核销合计（${sum}）须等于收款金额（${dto.amount}）`);
      const recvIds = dto.lines.map((l) => l.receivableId);
      const recvs = await db.select().from(receivables).where(inArray(receivables.id, recvIds));
      if (recvs.length !== recvIds.length) throw new BadRequestException('存在无效应收');
      for (const l of dto.lines) {
        const r = recvs.find((x) => x.id === l.receivableId)!;
        if (r.customerId !== dto.customerId) throw new BadRequestException('应收属于其他客户');
        if (r.status === 'voided') throw new BadRequestException(`应收 ${r.recvNo} 已冲销不可核销`);
        if (l.amount <= 0 || l.amount > owing(r) + 0.009) throw new BadRequestException(`核销金额超应收剩余（${r.recvNo} 剩余 ${owing(r)}）`);
      }
    }
    await db.transaction(async (tx) => {
      const [s] = await tx
        .insert(collectionSlips)
        .values({
          collectNo: await nextSeqNo(tx, `CO-${ymd(new Date())}-`),
          customerId: dto.customerId,
          mode: dto.mode,
          amount: dto.amount,
          note: dto.note ?? null,
        })
        .returning();
      if (dto.mode === 'settle') {
        await tx.insert(collectionSlipLines).values(
          dto.lines!.map((l) => ({ slipId: s.id, receivableId: l.receivableId, amount: l.amount })),
        );
        for (const l of dto.lines!) {
          const [r] = await tx.select().from(receivables).where(eq(receivables.id, l.receivableId));
          await tx
            .update(receivables)
            .set({ settledAmount: r.settledAmount + l.amount, updatedAt: new Date() })
            .where(eq(receivables.id, l.receivableId));
        }
      }
    });
    return this.collectionSlipsList().then((all) => all[0]);
  }

  /** 冲销收款单：回滚核销（应收 settledAmount 减回）；仅可冲销未冲销的单 */
  async voidCollectionSlip(id: number) {
    const [s] = await db.select().from(collectionSlips).where(eq(collectionSlips.id, id));
    if (!s) throw new NotFoundException('收款单不存在');
    if (s.status !== 'confirmed') throw new BadRequestException(`仅已生效收款单可冲销（当前：${s.status}）`);
    await db.transaction(async (tx) => {
      await tx.update(collectionSlips).set({ status: 'voided', voidedAt: new Date(), updatedAt: new Date() }).where(eq(collectionSlips.id, id));
      const lines = await tx.select().from(collectionSlipLines).where(eq(collectionSlipLines.slipId, id));
      for (const l of lines) {
        const [r] = await tx.select().from(receivables).where(eq(receivables.id, l.receivableId));
        await tx
          .update(receivables)
          .set({ settledAmount: Math.max(0, r.settledAmount - l.amount), updatedAt: new Date() })
          .where(eq(receivables.id, l.receivableId));
      }
    });
    return this.collectionSlipsList();
  }

  // ==================== 付款单（与收款单同构） ====================
  async paymentSlipsList() {
    const rows = await db
      .select({ s: paymentSlips, supplierName: suppliers.name })
      .from(paymentSlips)
      .leftJoin(suppliers, eq(paymentSlips.supplierId, suppliers.id))
      .orderBy(desc(paymentSlips.id));
    if (!rows.length) return [];
    const ids = rows.map((x) => x.s.id);
    const lines = await db
      .select({ l: paymentSlipLines, payNo: payables.payNo })
      .from(paymentSlipLines)
      .leftJoin(payables, eq(paymentSlipLines.payableId, payables.id))
      .where(inArray(paymentSlipLines.slipId, ids))
      .orderBy(paymentSlipLines.id);
    const byId = new Map<number, any[]>();
    for (const { l, payNo } of lines) {
      const arr = byId.get(l.slipId) ?? [];
      arr.push({ ...l, payNo });
      byId.set(l.slipId, arr);
    }
    return rows.map(({ s, supplierName }) => ({ ...s, supplierName, lines: byId.get(s.id) ?? [] }));
  }

  async createPaymentSlip(dto: { supplierId: number; mode: 'settle' | 'prepay'; amount: number; note?: string; lines?: Array<{ payableId: number; amount: number }> }) {
    const [sup] = await db.select().from(suppliers).where(eq(suppliers.id, dto.supplierId));
    if (!sup) throw new NotFoundException('供应商不存在');
    if (dto.amount <= 0) throw new BadRequestException('金额须为正数');
    if (dto.mode === 'prepay') {
      if (dto.lines?.length) throw new BadRequestException('预付模式不核销具体应付');
    } else {
      if (!dto.lines?.length) throw new BadRequestException('核销模式至少选一笔应付');
      const sum = dto.lines.reduce((s, l) => s + l.amount, 0);
      if (Math.abs(sum - dto.amount) > 0.009) throw new BadRequestException(`核销合计（${sum}）须等于付款金额（${dto.amount}）`);
      const ids = dto.lines.map((l) => l.payableId);
      const pays = await db.select().from(payables).where(inArray(payables.id, ids));
      if (pays.length !== ids.length) throw new BadRequestException('存在无效应付');
      for (const l of dto.lines) {
        const p = pays.find((x) => x.id === l.payableId)!;
        if (p.supplierId !== dto.supplierId) throw new BadRequestException('应付属于其他供应商');
        if (p.status === 'voided') throw new BadRequestException(`应付 ${p.payNo} 已冲销不可核销`);
        if (l.amount <= 0 || l.amount > owing(p) + 0.009) throw new BadRequestException(`核销金额超应付剩余（${p.payNo}）`);
      }
    }
    await db.transaction(async (tx) => {
      const [s] = await tx
        .insert(paymentSlips)
        .values({
          payNo: await nextSeqNo(tx, `PM-${ymd(new Date())}-`),
          supplierId: dto.supplierId,
          mode: dto.mode,
          amount: dto.amount,
          note: dto.note ?? null,
        })
        .returning();
      if (dto.mode === 'settle') {
        await tx.insert(paymentSlipLines).values(
          dto.lines!.map((l) => ({ slipId: s.id, payableId: l.payableId, amount: l.amount })),
        );
        for (const l of dto.lines!) {
          const [p] = await tx.select().from(payables).where(eq(payables.id, l.payableId));
          await tx.update(payables).set({ settledAmount: p.settledAmount + l.amount, updatedAt: new Date() }).where(eq(payables.id, l.payableId));
        }
      }
    });
    return this.paymentSlipsList().then((all) => all[0]);
  }

  async voidPaymentSlip(id: number) {
    const [s] = await db.select().from(paymentSlips).where(eq(paymentSlips.id, id));
    if (!s) throw new NotFoundException('付款单不存在');
    if (s.status !== 'confirmed') throw new BadRequestException(`仅已生效付款单可冲销（当前：${s.status}）`);
    await db.transaction(async (tx) => {
      await tx.update(paymentSlips).set({ status: 'voided', voidedAt: new Date(), updatedAt: new Date() }).where(eq(paymentSlips.id, id));
      const lines = await tx.select().from(paymentSlipLines).where(eq(paymentSlipLines.slipId, id));
      for (const l of lines) {
        const [p] = await tx.select().from(payables).where(eq(payables.id, l.payableId));
        await tx.update(payables).set({ settledAmount: Math.max(0, p.settledAmount - l.amount), updatedAt: new Date() }).where(eq(payables.id, l.payableId));
      }
    });
    return this.paymentSlipsList();
  }

  // ==================== 对账单（账龄分桶） ====================
  async statements() {
    const recvs = (await this.receivablesList()).filter((r: any) => r.status !== 'voided');
    const prepays = await db
      .select()
      .from(collectionSlips)
      .where(and(eq(collectionSlips.mode, 'prepay'), eq(collectionSlips.status, 'confirmed')));
    const custIds = new Set<number>([...recvs.map((r: any) => r.customerId), ...prepays.map((p) => p.customerId)]);
    const custs = await db.select().from(customers).where(inArray(customers.id, [...custIds]));
    const custName = new Map(custs.map((c) => [c.id, c.name]));

    return [...custIds].map((cid) => {
      const list = recvs.filter((r: any) => r.customerId === cid);
      const invoiced = list.reduce((s: number, r: any) => s + r.amount, 0);
      const settled = list.reduce((s: number, r: any) => s + r.settledAmount, 0);
      const prepay = prepays.filter((p) => p.customerId === cid).reduce((s, p) => s + p.amount, 0);
      const balance = invoiced - settled - prepay;
      const buckets = { current: 0, d30: 0, d60: 0, d90: 0, d90p: 0 };
      for (const r of list) {
        if (r.remain > 0) buckets[r.bucket as keyof typeof buckets] += r.remain;
      }
      return {
        customerId: cid,
        customerName: custName.get(cid) ?? '',
        invoiced, settled, prepay, balance,
        buckets,
        overDueTotal: buckets.d30 + buckets.d60 + buckets.d90 + buckets.d90p,
      };
    }).sort((a, b) => a.customerId - b.customerId);
  }

  // ==================== 利润视图（现金收付制） ====================
  async profit(month: string) {
    const [y, m] = month.split('-').map(Number);
    const monthStart = `${month}-01T00:00:00Z`;
    const monthEnd = `${new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)}T00:00:00Z`;
    // 营收：收款核销（settle 单，现金收付制）；材料：来料登记单月合计 —— 原生 SQL 聚合，规避绑定差异
    const revRes = await db.execute(sql`
      SELECT COALESCE(SUM(s.amount),0)::float8 AS revenue
      FROM collection_slips s
      JOIN customers c ON c.id = s.customer_id
      WHERE s.mode = 'settle' AND s.status = 'confirmed'
        AND s.created_at >= ${monthStart}::timestamptz AND s.created_at < ${monthEnd}::timestamptz`);
    const revenue = Number((revRes.rows[0] as any)?.revenue ?? 0);
    const byCustRes = await db.execute(sql`
      SELECT c.name AS customer, COALESCE(SUM(s.amount),0)::float8 AS amount
      FROM collection_slips s JOIN customers c ON c.id = s.customer_id
      WHERE s.mode = 'settle' AND s.status = 'confirmed'
        AND s.created_at >= ${monthStart}::timestamptz AND s.created_at < ${monthEnd}::timestamptz
      GROUP BY c.name ORDER BY amount DESC`);
    const revenueByCustomer = byCustRes.rows as unknown as Array<{ customer: string; amount: number }>;
    const matRes = await db.execute(sql`
      SELECT COALESCE(SUM(amount),0)::float8 AS material
      FROM incoming_goods
      WHERE created_at >= ${monthStart}::timestamptz AND created_at < ${monthEnd}::timestamptz`);
    const material = Number((matRes.rows[0] as any)?.material ?? 0);
    // 六类成本
    const costs = await db.select().from(monthlyCosts).where(eq(monthlyCosts.month, month));
    const cat = new Map<string, number>(costs.map((c) => [c.category as string, c.amount]));
    const getCat = (k: string) => cat.get(k) ?? 0;
    const labor = getCat('labor');
    const electricity = getCat('electricity');
    const gas = getCat('gas');
    const rent = getCat('rent');
    const depreciation = getCat('depreciation');
    const other = getCat('other');
    const manufactureCost = labor + electricity + gas + rent + depreciation + other;
    return {
      month,
      revenue,
      revenueByCustomer,
      material,
      costs: { labor, electricity, gas, rent, depreciation, other },
      manufactureCost,
      totalCost: material + manufactureCost,
      profit: revenue - material - manufactureCost,
    };
  }

  // ==================== 月度成本（固定六类手填） ====================
  async listMonthlyCosts(month: string) {
    const rows = await db.select().from(monthlyCosts).where(eq(monthlyCosts.month, month));
    return rows;
  }

  async upsertMonthlyCost(dto: { month: string; category: string; amount: number; note?: string }) {
    if (!/^\d{4}-\d{2}$/.test(dto.month)) throw new BadRequestException('月份格式须为 YYYY-MM');
    if (dto.amount < 0) throw new BadRequestException('金额不能为负');
    const [exist] = await db
      .select()
      .from(monthlyCosts)
      .where(and(eq(monthlyCosts.month, dto.month), eq(monthlyCosts.category, dto.category as any)));
    if (exist) {
      await db.update(monthlyCosts).set({ amount: dto.amount, note: dto.note ?? exist.note, updatedAt: new Date() }).where(eq(monthlyCosts.id, exist.id));
    } else {
      await db.insert(monthlyCosts).values({ month: dto.month, category: dto.category as any, amount: dto.amount, note: dto.note ?? null });
    }
    return this.listMonthlyCosts(dto.month);
  }

  // ==================== 四表导出（CSV 给外部做账） ====================
  private csvEscape(v: unknown): string {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  async exportCsv(kind: string): Promise<{ name: string; csv: string }> {
    const esc = this.csvEscape;
    const line = (row: unknown[]) => row.map(esc).join(',') + '\n';
    if (kind === 'outbounds') {
      const rows = await this.recvExportRows();
      const csv = line(['应收号', '日期', '客户', '出库单号', '金额', '币种', '到期日']) + rows.map(line).join('');
      return { name: `出库明细-${ymd(new Date())}.csv`, csv };
    }
    if (kind === 'incoming') {
      const rows = await this.incomingExportRows();
      const csv = line(['来料登记号', '日期', '供应商', '物料', '数量', '金额', '批次号']) + rows.map(line).join('');
      return { name: `来料采购-${ymd(new Date())}.csv`, csv };
    }
    if (kind === 'collection') {
      const rows = await this.collectExportRows();
      const csv = line(['收款单号', '日期', '客户', '模式', '金额', '核销应收', '状态']) + rows.map(line).join('');
      return { name: `收款明细-${ymd(new Date())}.csv`, csv };
    }
    if (kind === 'payment') {
      const rows = await this.payExportRows();
      const csv = line(['付款单号', '日期', '供应商', '模式', '金额', '核销应付', '状态']) + rows.map(line).join('');
      return { name: `付款明细-${ymd(new Date())}.csv`, csv };
    }
    throw new BadRequestException('未知导出类型（outbounds|incoming|collection|payment）');
  }

  private async recvExportRows() {
    const recvs = await this.receivablesList();
    // 只导出有效应收（出库明细=有效发票）；已冲销应收不进外部做账（对应出库已作废）
    return recvs
      .filter((r: any) => r.status !== 'voided')
      .map((r: any) => [
        r.recvNo, this.day(r.createdAt), r.customerName, r.shipNo, r.amount, r.currency,
        r.dueDate ? this.day(r.dueDate) : '',
      ]);
  }
  private day(v: unknown): string {
    if (!v) return '';
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
  }
  private async incomingExportRows() {
    const rows = await db
      .select({ g: incomingGoods, supplierName: suppliers.name })
      .from(incomingGoods)
      .leftJoin(suppliers, eq(incomingGoods.supplierId, suppliers.id))
      .orderBy(asc(incomingGoods.id));
    return rows.map(({ g, supplierName }) => [g.incomingNo, this.day(g.createdAt), supplierName, g.materialName, g.quantity, g.amount, g.batchNo ?? '']);
  }
  private async collectExportRows() {
    const list = await this.collectionSlipsList();
    return list.map((s: any) => [s.collectNo, this.day(s.createdAt), s.customerName, s.mode === 'settle' ? '核销' : '预收', s.amount, s.lines?.map((l: any) => l.recvNo).join('|') ?? '', s.status === 'confirmed' ? '生效' : '已冲销']);
  }
  private async payExportRows() {
    const list = await this.paymentSlipsList();
    return list.map((s: any) => [s.payNo, this.day(s.createdAt), s.supplierName, s.mode === 'settle' ? '核销' : '预付', s.amount, s.lines?.map((l: any) => l.payNo).join('|') ?? '', s.status === 'confirmed' ? '生效' : '已冲销']);
  }
}
