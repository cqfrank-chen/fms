import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  collectionSlipLines, collectionSlips, customers, incomingGoods, monthlyCosts, orders, outbounds,
  payables, paymentSlipLines, paymentSlips, receivables, suppliers,
} from '../db/schema';
import { toCents, fromCents, round2, MONEY_EPS, centsEq, remainOf } from '../common/money';

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
  // 取同前缀（当日）最大序号 + 1：count(*)+1 在冲销/删单后会重号
  const res = await tx.execute(sql`
    SELECT COALESCE(MAX(CAST(SPLIT_PART(${hit.col}, '-', 3) AS INTEGER)), 0) AS n
      FROM ${hit.t}
     WHERE ${hit.col} LIKE ${prefix + '%'}`);
  const n = Number((res as any).rows?.[0]?.n ?? 0);
  return `${prefix}${pad2(n + 1)}`;
}

const owing = (r: { amount: number; settledAmount: number }) => fromCents(toCents(r.amount) - toCents(r.settledAmount));

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

  /** 客户可用预收余额（分）：已确认预收 − 已确认预收冲抵；须在事务内调用 */
  private async prepayBalanceCents(tx: Tx, customerId: number): Promise<number> {
    const rows = await tx
      .select({ mode: collectionSlips.mode, amount: collectionSlips.amount, status: collectionSlips.status })
      .from(collectionSlips)
      .where(and(eq(collectionSlips.customerId, customerId), inArray(collectionSlips.mode, ['prepay', 'apply'])));
    let cents = 0;
    for (const r of rows) {
      if (r.status !== 'confirmed') continue;
      cents += r.mode === 'prepay' ? toCents(r.amount) : -toCents(r.amount);
    }
    return cents;
  }

  /** 供应商可用预付余额（分）：已确认预付 − 已确认预付冲抵 */
  private async prepayBalanceCentsSupplier(tx: Tx, supplierId: number): Promise<number> {
    const rows = await tx
      .select({ mode: paymentSlips.mode, amount: paymentSlips.amount, status: paymentSlips.status })
      .from(paymentSlips)
      .where(and(eq(paymentSlips.supplierId, supplierId), inArray(paymentSlips.mode, ['prepay', 'apply'])));
    let cents = 0;
    for (const r of rows) {
      if (r.status !== 'confirmed') continue;
      cents += r.mode === 'prepay' ? toCents(r.amount) : -toCents(r.amount);
    }
    return cents;
  }

  async receivablesList() {
    const rows = await db
      .select({ r: receivables, customerName: customers.name, shipNo: outbounds.shipNo })
      .from(receivables)
      .leftJoin(customers, eq(receivables.customerId, customers.id))
      .leftJoin(outbounds, and(eq(outbounds.id, receivables.sourceId), eq(receivables.sourceType, 'outbound')))
      .orderBy(desc(receivables.id));
    const orderNoBy = await this.resolveOrderNos(rows.map((x) => x.r));
    return rows.map(({ r, ...rest }) =>
      this.decorateReceivable(r, rest.customerName, rest.shipNo, orderNoBy.get(r.sourceId) ?? ''),
    );
  }

  private decorateReceivable(r: any, customerName?: string | null, shipNo?: string | null, orderNo?: string) {
    const remain = remainOf(r.amount, r.settledAmount);
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
      settled: toCents(r.settledAmount) >= toCents(r.amount),
    };
  }

  async payablesList() {
    const rows = await db
      .select({ p: payables, supplierName: suppliers.name, incomingNo: incomingGoods.incomingNo })
      .from(payables)
      .leftJoin(suppliers, eq(payables.supplierId, suppliers.id))
      .leftJoin(incomingGoods, and(eq(incomingGoods.id, payables.sourceId), eq(payables.sourceType, 'incoming')))
      .orderBy(desc(payables.id));
    return rows.map(({ p, ...rest }) => ({
      ...p,
      supplierName: rest.supplierName ?? '',
      incomingNo: rest.incomingNo ?? '',
      remain: remainOf(p.amount, p.settledAmount),
      settled: toCents(p.settledAmount) >= toCents(p.amount),
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
  async createCollectionSlip(dto: { customerId: number; mode: 'settle' | 'prepay' | 'apply'; amount: number; note?: string; lines?: Array<{ receivableId: number; amount: number }> }) {
    if (dto.amount <= 0) throw new BadRequestException('金额须为正数');
    if (dto.mode === 'prepay') {
      if (dto.lines?.length) throw new BadRequestException('预收模式不核销具体应收（先挂客户预收余额）');
    } else if (!dto.lines?.length) {
      throw new BadRequestException(dto.mode === 'apply' ? '预收冲抵至少选一笔应收' : '核销模式至少选一笔应收');
    }
    // 校验与写入同一事务：先按 id 升序对涉及的应收加行锁（SELECT ... FOR UPDATE），
    // 防止并发下的丢更新 / 超核销；金额比较全部按“分”进行。
    await db.transaction(async (tx) => {
      const [cust] = await tx.select().from(customers).where(eq(customers.id, dto.customerId));
      if (!cust) throw new NotFoundException('客户不存在');
      if (dto.mode === 'settle' || dto.mode === 'apply') {
        const lines = dto.lines!;
        const sumCents = lines.reduce((s, l) => s + toCents(l.amount), 0);
        if (!centsEq(fromCents(sumCents), dto.amount)) {
          throw new BadRequestException(`核销合计（${fromCents(sumCents)}）须等于收款金额（${dto.amount}）`);
        }
        const recvIds = [...new Set(lines.map((l) => l.receivableId))].sort((a, b) => a - b);
        const recvs = await tx
          .select()
          .from(receivables)
          .where(inArray(receivables.id, recvIds))
          .orderBy(asc(receivables.id))
          .for('update');
        if (recvs.length !== recvIds.length) throw new BadRequestException('存在无效应收');
        const byId = new Map(recvs.map((r) => [r.id, r]));
        const takenCents = new Map<number, number>();
        for (const l of lines) {
          const r = byId.get(l.receivableId)!;
          if (r.customerId !== dto.customerId) throw new BadRequestException('应收属于其他客户');
          if (r.status === 'voided') throw new BadRequestException(`应收 ${r.recvNo} 已冲销不可核销`);
          const remain = remainOf(r.amount, r.settledAmount);
          const nextCents = (takenCents.get(l.receivableId) ?? 0) + toCents(l.amount);
          takenCents.set(l.receivableId, nextCents);
          if (toCents(l.amount) <= 0 || nextCents > toCents(owing(r))) {
            throw new BadRequestException(`核销金额超应收剩余（${r.recvNo} 剩余 ${remain}）`);
          }
        }
        if (dto.mode === 'apply') {
          const avail = await this.prepayBalanceCents(tx, dto.customerId);
          if (sumCents > avail) {
            throw new BadRequestException(`预收余额不足（可用 ¥${fromCents(avail)}，本次冲抵 ¥${fromCents(sumCents)}）`);
          }
        }
      }
      const [s] = await tx
        .insert(collectionSlips)
        .values({
          collectNo: await nextSeqNo(tx, `CO-${ymd(new Date())}-`),
          customerId: dto.customerId,
          mode: dto.mode,
          amount: round2(dto.amount),
          note: dto.note ?? null,
        })
        .returning();
      if (dto.mode === 'settle' || dto.mode === 'apply') {
        await tx.insert(collectionSlipLines).values(
          dto.lines!.map((l) => ({ slipId: s.id, receivableId: l.receivableId, amount: round2(l.amount) })),
        );
        // 行锁内原子自增，替代“读旧值 + 金额写回”
        for (const l of dto.lines!) {
          await tx
            .update(receivables)
            .set({ settledAmount: sql`${receivables.settledAmount} + ${round2(l.amount)}`, updatedAt: new Date() })
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
      // 条件更新：并发重复冲销只有一次成功（以 .returning() 判定）
      const updated = await tx
        .update(collectionSlips)
        .set({ status: 'voided', voidedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(collectionSlips.id, id), eq(collectionSlips.status, 'confirmed')))
        .returning({ id: collectionSlips.id });
      if (!updated.length) {
        const [cur] = await tx.select({ status: collectionSlips.status }).from(collectionSlips).where(eq(collectionSlips.id, id));
        throw new BadRequestException(`仅已生效收款单可冲销（当前：${cur?.status ?? s.status}）`);
      }
      const lines = await tx.select().from(collectionSlipLines).where(eq(collectionSlipLines.slipId, id));
      const recvIds = [...new Set(lines.map((l) => l.receivableId))].sort((a, b) => a - b);
      if (recvIds.length) {
        // 锁内回滚；按 id 升序加锁，避免与核销事务交叉死锁
        await tx
          .select({ id: receivables.id })
          .from(receivables)
          .where(inArray(receivables.id, recvIds))
          .orderBy(asc(receivables.id))
          .for('update');
        for (const l of lines) {
          await tx
            .update(receivables)
            .set({ settledAmount: sql`GREATEST(0, ${receivables.settledAmount} - ${round2(l.amount)})`, updatedAt: new Date() })
            .where(eq(receivables.id, l.receivableId));
        }
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

  async createPaymentSlip(dto: { supplierId: number; mode: 'settle' | 'prepay' | 'apply'; amount: number; note?: string; lines?: Array<{ payableId: number; amount: number }> }) {
    if (dto.amount <= 0) throw new BadRequestException('金额须为正数');
    if (dto.mode === 'prepay') {
      if (dto.lines?.length) throw new BadRequestException('预付模式不核销具体应付（先挂供应商预付余额）');
    } else if (!dto.lines?.length) {
      throw new BadRequestException(dto.mode === 'apply' ? '预付冲抵至少选一笔应付' : '核销模式至少选一笔应付');
    }
    // 校验与写入同一事务：先按 id 升序对涉及的应付加行锁（SELECT ... FOR UPDATE），
    // 防止并发下的丢更新 / 超核销；金额比较全部按“分”进行。
    await db.transaction(async (tx) => {
      const [sup] = await tx.select().from(suppliers).where(eq(suppliers.id, dto.supplierId));
      if (!sup) throw new NotFoundException('供应商不存在');
      if (dto.mode === 'settle' || dto.mode === 'apply') {
        const lines = dto.lines!;
        const sumCents = lines.reduce((s, l) => s + toCents(l.amount), 0);
        if (!centsEq(fromCents(sumCents), dto.amount)) {
          throw new BadRequestException(`核销合计（${fromCents(sumCents)}）须等于付款金额（${dto.amount}）`);
        }
        const ids = [...new Set(lines.map((l) => l.payableId))].sort((a, b) => a - b);
        const pays = await tx
          .select()
          .from(payables)
          .where(inArray(payables.id, ids))
          .orderBy(asc(payables.id))
          .for('update');
        if (pays.length !== ids.length) throw new BadRequestException('存在无效应付');
        const byId = new Map(pays.map((p) => [p.id, p]));
        const takenCents = new Map<number, number>();
        for (const l of lines) {
          const p = byId.get(l.payableId)!;
          if (p.supplierId !== dto.supplierId) throw new BadRequestException('应付属于其他供应商');
          if (p.status === 'voided') throw new BadRequestException(`应付 ${p.payNo} 已冲销不可核销`);
          const remain = remainOf(p.amount, p.settledAmount);
          const nextCents = (takenCents.get(l.payableId) ?? 0) + toCents(l.amount);
          takenCents.set(l.payableId, nextCents);
          if (toCents(l.amount) <= 0 || nextCents > toCents(owing(p))) {
            throw new BadRequestException(`核销金额超应付剩余（${p.payNo} 剩余 ${remain}）`);
          }
        }
        if (dto.mode === 'apply') {
          const avail = await this.prepayBalanceCentsSupplier(tx, dto.supplierId);
          if (sumCents > avail) {
            throw new BadRequestException(`预付余额不足（可用 ¥${fromCents(avail)}，本次冲抵 ¥${fromCents(sumCents)}）`);
          }
        }
      }
      const [s] = await tx
        .insert(paymentSlips)
        .values({
          payNo: await nextSeqNo(tx, `PM-${ymd(new Date())}-`),
          supplierId: dto.supplierId,
          mode: dto.mode,
          amount: round2(dto.amount),
          note: dto.note ?? null,
        })
        .returning();
      if (dto.mode === 'settle' || dto.mode === 'apply') {
        await tx.insert(paymentSlipLines).values(
          dto.lines!.map((l) => ({ slipId: s.id, payableId: l.payableId, amount: round2(l.amount) })),
        );
        // 行锁内原子自增，替代“读旧值 + 金额写回”
        for (const l of dto.lines!) {
          await tx
            .update(payables)
            .set({ settledAmount: sql`${payables.settledAmount} + ${round2(l.amount)}`, updatedAt: new Date() })
            .where(eq(payables.id, l.payableId));
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
      // 条件更新：并发重复冲销只有一次成功（以 .returning() 判定）
      const updated = await tx
        .update(paymentSlips)
        .set({ status: 'voided', voidedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(paymentSlips.id, id), eq(paymentSlips.status, 'confirmed')))
        .returning({ id: paymentSlips.id });
      if (!updated.length) {
        const [cur] = await tx.select({ status: paymentSlips.status }).from(paymentSlips).where(eq(paymentSlips.id, id));
        throw new BadRequestException(`仅已生效付款单可冲销（当前：${cur?.status ?? s.status}）`);
      }
      const lines = await tx.select().from(paymentSlipLines).where(eq(paymentSlipLines.slipId, id));
      const payIds = [...new Set(lines.map((l) => l.payableId))].sort((a, b) => a - b);
      if (payIds.length) {
        // 锁内回滚；按 id 升序加锁，避免与核销事务交叉死锁
        await tx
          .select({ id: payables.id })
          .from(payables)
          .where(inArray(payables.id, payIds))
          .orderBy(asc(payables.id))
          .for('update');
        for (const l of lines) {
          await tx
            .update(payables)
            .set({ settledAmount: sql`GREATEST(0, ${payables.settledAmount} - ${round2(l.amount)})`, updatedAt: new Date() })
            .where(eq(payables.id, l.payableId));
        }
      }
    });
    return this.paymentSlipsList();
  }

  // ==================== 对账单（账龄分桶） ====================
  async statements() {
    const recvs = (await this.receivablesList()).filter((r: any) => r.status !== 'voided');
    // 预收余额 = 已确认预收 − 已确认预收冲抵（apply）
    const prepays = await db
      .select()
      .from(collectionSlips)
      .where(and(inArray(collectionSlips.mode, ['prepay', 'apply']), eq(collectionSlips.status, 'confirmed')));
    const custIds = new Set<number>([...recvs.map((r: any) => r.customerId), ...prepays.map((p) => p.customerId)]);
    const custs = await db.select().from(customers).where(inArray(customers.id, [...custIds]));
    const custName = new Map(custs.map((c) => [c.id, c.name]));

    return [...custIds].map((cid) => {
      const list = recvs.filter((r: any) => r.customerId === cid);
      // 汇总全部按“分”累加，最后一并转元，杜绝 binary64 分位尾差
      const invoicedCents = list.reduce((s: number, r: any) => s + toCents(r.amount), 0);
      const settledCents = list.reduce((s: number, r: any) => s + toCents(r.settledAmount), 0);
      const prepayCents = prepays
        .filter((p) => p.customerId === cid)
        .reduce((s, p) => s + (p.mode === 'prepay' ? toCents(p.amount) : -toCents(p.amount)), 0);
      const bucketsCents = { current: 0, d30: 0, d60: 0, d90: 0, d90p: 0 };
      for (const r of list) {
        if (toCents(r.remain) > 0) bucketsCents[r.bucket as keyof typeof bucketsCents] += toCents(r.remain);
      }
      const invoiced = fromCents(invoicedCents);
      const settled = fromCents(settledCents);
      const prepay = fromCents(prepayCents);
      // 半分容差仅用于把“恰好结清”的余额归零，避免 -0 / 分位残差展示
      const balanceRaw = fromCents(invoicedCents - settledCents - prepayCents);
      const balance = Math.abs(balanceRaw) < MONEY_EPS ? 0 : balanceRaw;
      const buckets = {
        current: fromCents(bucketsCents.current),
        d30: fromCents(bucketsCents.d30),
        d60: fromCents(bucketsCents.d60),
        d90: fromCents(bucketsCents.d90),
        d90p: fromCents(bucketsCents.d90p),
      };
      return {
        customerId: cid,
        customerName: custName.get(cid) ?? '',
        invoiced, settled, prepay, balance,
        buckets,
        overDueTotal: fromCents(bucketsCents.d30 + bucketsCents.d60 + bucketsCents.d90 + bucketsCents.d90p),
      };
    }).sort((a, b) => a.customerId - b.customerId);
  }

  // ==================== 利润视图（现金收付制） ====================
  async profit(month: string) {
    const [y, m] = month.split('-').map(Number);
    // 本地月边界（应用容器 TZ=Asia/Shanghai）：避免每月 1 号 0-8 点收款被算进上月
    const monthStart = new Date(y, m - 1, 1).toISOString();
    const monthEnd = new Date(y, m, 1).toISOString();
    // 营收：收款核销（settle 单，现金收付制）；材料：来料登记单月合计 —— 原生 SQL 聚合，规避绑定差异
    // 聚合用 ::numeric（定点）而非 ::float8，避免 binary64 求和尾差；读出后再 Number() 转换。
    const revRes = await db.execute(sql`
      SELECT COALESCE(SUM(s.amount),0)::numeric AS revenue
      FROM collection_slips s
      JOIN customers c ON c.id = s.customer_id
      WHERE s.mode IN ('settle', 'apply') AND s.status = 'confirmed'
        AND s.created_at >= ${monthStart}::timestamptz AND s.created_at < ${monthEnd}::timestamptz`);
    const revenue = round2(Number((revRes.rows[0] as any)?.revenue ?? 0));
    const byCustRes = await db.execute(sql`
      SELECT c.name AS customer, COALESCE(SUM(s.amount),0)::numeric AS amount
      FROM collection_slips s JOIN customers c ON c.id = s.customer_id
      WHERE s.mode IN ('settle', 'apply') AND s.status = 'confirmed'
        AND s.created_at >= ${monthStart}::timestamptz AND s.created_at < ${monthEnd}::timestamptz
      GROUP BY c.name ORDER BY amount DESC`);
    const revenueByCustomer = byCustRes.rows.map((row: any) => ({
      customer: row.customer as string,
      amount: round2(Number(row.amount ?? 0)),
    }));
    const matRes = await db.execute(sql`
      SELECT COALESCE(SUM(amount),0)::numeric AS material
      FROM incoming_goods
      WHERE created_at >= ${monthStart}::timestamptz AND created_at < ${monthEnd}::timestamptz`);
    const material = round2(Number((matRes.rows[0] as any)?.material ?? 0));
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
    const manufactureCost = round2(labor + electricity + gas + rent + depreciation + other);
    return {
      month,
      revenue,
      revenueByCustomer,
      material,
      costs: { labor, electricity, gas, rent, depreciation, other },
      manufactureCost,
      totalCost: round2(material + manufactureCost),
      profit: round2(revenue - material - manufactureCost),
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
    let s = v == null ? '' : String(v);
    // CSV 公式注入防护：以 = + - @ 或制表符/回车开头的单元格前置单引号，Excel/WPS 不会当公式执行
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
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
    // 按本地时区输出 YYYY-MM-DD：东八区 0-8 点业务不再串到前一天，UTC 零点历史数据也显示为正确业务日
    return Number.isNaN(d.getTime())
      ? String(v).slice(0, 10)
      : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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
