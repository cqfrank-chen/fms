import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { customers, invoiceOrders, invoices, operators, orderLines, orders, receivables } from '../db/schema';
import type { InvoiceStatus, InvoiceType } from '../db/schema';
import { currentOperatorId } from '../common/operator-context';
import { toCents } from '../common/money';
import { normalizeInvoiceAmounts } from './invoice-amount';
import {
  alreadyVoidedMessage, amountImmutableMessage, invoiceNoConflictMessage,
  orderCustomerMismatchMessage, ordersMissingMessage, voidedImmutableMessage,
} from './invoice-messages';
import { buildOrderInvoiceView, summarizeInvoices } from './invoice-stats';

const pad2 = (n: number) => String(n).padStart(2, '0');
/** 业务日（本地时区，东八区）：开票日期默认当天，不因 UTC 化串日 */
const todayYmd = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** 作废操作人（与开票人分开 join，避免同一张表两次左连的别名冲突） */
const voidOperator = alias(operators, 'void_operator');
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CreateInvoiceDto {
  invoiceNo: string;
  invoiceType: InvoiceType;
  customerId: number;
  amountExclCents: number;
  taxRate: number;
  taxCents?: number;
  amountInclCents?: number;
  issueDate?: string;
  orderIds?: number[];
  remark?: string;
}

export interface UpdateInvoiceDto {
  remark?: string | null;
  issueDate?: string;
  taxRate?: number;
  taxCents?: number;
  amountInclCents?: number;
  /** 显式传入即拒绝：金额关键字段只能作废后重开 */
  amountExclCents?: number;
  orderIds?: number[];
}

export interface InvoiceListQuery {
  page?: number;
  pageSize?: number;
  customerId?: number;
  status?: InvoiceStatus;
  from?: string;
  to?: string;
  keyword?: string;
  orderId?: number;
}

/** PostgreSQL 唯一约束冲突（SQLSTATE 23505） */
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';

/**
 * 开票模块（I16）—— 与收款/核销并行的独立线
 * ------------------------------------------------------------------
 * · 开票只记「开票事实」（票号/票种/税率/三金额/关联订单），不参与核销、不改收款逻辑；
 * · 金额全部按「分」整数存储与校验（money.ts 定点助手），三兄弟恒等式由 invoice-amount.ts 强校验；
 * · 订单已开票金额**实时聚合**（invoice_orders × invoices where status='normal'），不落冗余字段；
 * · 作废只置状态并留痕（原因/时间/操作人），保留可查、不计入统计；未作废票号唯一（部分唯一索引）。
 */
@Injectable()
export class InvoicesService {
  // ==================== 列表 / 详情 ====================
  async list(q: InvoiceListQuery) {
    const page = Math.max(1, Math.trunc(Number(q.page) || 1));
    const pageSize = Math.min(200, Math.max(1, Math.trunc(Number(q.pageSize) || 20)));
    const where = this.listWhere(q);

    const [countRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(invoices)
      .leftJoin(customers, eq(invoices.customerId, customers.id))
      .where(where);
    const rows = await db
      .select({
        inv: invoices,
        customerName: customers.name,
        operatorName: operators.name,
        voidOperatorName: voidOperator.name,
      })
      .from(invoices)
      .leftJoin(customers, eq(invoices.customerId, customers.id))
      .leftJoin(operators, eq(invoices.operatorId, operators.id))
      .leftJoin(voidOperator, eq(invoices.voidOperatorId, voidOperator.id))
      .where(where)
      .orderBy(desc(invoices.issueDate), desc(invoices.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const refs = await this.orderRefs(rows.map((r) => r.inv.id));
    return {
      items: rows.map((r) => this.toItem(r, refs.get(r.inv.id) ?? [])),
      total: Number(countRow?.n ?? 0),
      page,
      pageSize,
    };
  }

  async findOne(id: number) {
    const [row] = await db
      .select({
        inv: invoices,
        customerName: customers.name,
        operatorName: operators.name,
        voidOperatorName: voidOperator.name,
      })
      .from(invoices)
      .leftJoin(customers, eq(invoices.customerId, customers.id))
      .leftJoin(operators, eq(invoices.operatorId, operators.id))
      .leftJoin(voidOperator, eq(invoices.voidOperatorId, voidOperator.id))
      .where(eq(invoices.id, id));
    if (!row) throw new NotFoundException('发票不存在');
    const refs = await this.orderRefs([row.inv.id]);
    return this.toItem(row, refs.get(row.inv.id) ?? []);
  }

  private listWhere(q: InvoiceListQuery) {
    const conds = [];
    if (q.customerId) conds.push(eq(invoices.customerId, Number(q.customerId)));
    if (q.status) conds.push(eq(invoices.status, q.status));
    if (q.from) conds.push(gte(invoices.issueDate, q.from));
    if (q.to) conds.push(lte(invoices.issueDate, q.to));
    if (q.orderId) {
      conds.push(
        sql`exists (select 1 from ${invoiceOrders} io where io.invoice_id = ${invoices.id} and io.order_id = ${Number(q.orderId)})`,
      );
    }
    const kwRaw = (q.keyword ?? '').trim();
    if (kwRaw) {
      const kw = `%${kwRaw}%`;
      conds.push(
        or(
          ilike(invoices.invoiceNo, kw),
          ilike(invoices.remark, kw),
          ilike(customers.name, kw),
          sql`exists (select 1 from ${invoiceOrders} io join ${orders} o on o.id = io.order_id where io.invoice_id = ${invoices.id} and o.order_no ilike ${kw})`,
        ),
      );
    }
    return conds.length ? and(...conds) : undefined;
  }

  /** 发票 → 关联订单（多对多） */
  private async orderRefs(invoiceIds: number[]) {
    const map = new Map<number, Array<{ orderId: number; orderNo: string }>>();
    if (!invoiceIds.length) return map;
    const rows = await db
      .select({ invoiceId: invoiceOrders.invoiceId, orderId: invoiceOrders.orderId, orderNo: orders.orderNo })
      .from(invoiceOrders)
      .innerJoin(orders, eq(invoiceOrders.orderId, orders.id))
      .where(inArray(invoiceOrders.invoiceId, invoiceIds))
      .orderBy(asc(invoiceOrders.id));
    for (const r of rows) {
      const arr = map.get(r.invoiceId) ?? [];
      arr.push({ orderId: r.orderId, orderNo: r.orderNo });
      map.set(r.invoiceId, arr);
    }
    return map;
  }

  private toItem(
    row: { inv: typeof invoices.$inferSelect; customerName?: string | null; operatorName?: string | null; voidOperatorName?: string | null },
    refs: Array<{ orderId: number; orderNo: string }>,
  ) {
    return {
      ...row.inv,
      customerName: row.customerName ?? '',
      operatorName: row.operatorName ?? null,
      voidOperatorName: row.voidOperatorName ?? null,
      orderRefs: refs,
      orderNos: refs.map((r) => r.orderNo),
    };
  }

  // ==================== 开票数目（统计） ====================
  /** 开票数目/金额：张数 + 含税/不含税/税额合计 + 按客户/按月分组（只计未作废） */
  async summary(from?: string, to?: string) {
    const conds = [eq(invoices.status, 'normal' as InvoiceStatus)];
    if (from) conds.push(gte(invoices.issueDate, from));
    if (to) conds.push(lte(invoices.issueDate, to));
    const where = and(...conds);

    const [row] = await db
      .select({
        count: sql<number>`count(*)::int`,
        amountExclCents: sql<string>`coalesce(sum(${invoices.amountExclCents}), 0)::bigint`,
        taxCents: sql<string>`coalesce(sum(${invoices.taxCents}), 0)::bigint`,
        amountInclCents: sql<string>`coalesce(sum(${invoices.amountInclCents}), 0)::bigint`,
      })
      .from(invoices)
      .where(where);

    const byCustomer = await db
      .select({
        customerId: invoices.customerId,
        customerName: customers.name,
        count: sql<number>`count(*)::int`,
        amountExclCents: sql<string>`coalesce(sum(${invoices.amountExclCents}), 0)::bigint`,
        taxCents: sql<string>`coalesce(sum(${invoices.taxCents}), 0)::bigint`,
        amountInclCents: sql<string>`coalesce(sum(${invoices.amountInclCents}), 0)::bigint`,
      })
      .from(invoices)
      .leftJoin(customers, eq(invoices.customerId, customers.id))
      .where(where)
      .groupBy(invoices.customerId, customers.name)
      .orderBy(desc(sql`sum(${invoices.amountInclCents})`));

    const byMonth = await db
      .select({
        month: sql<string>`to_char(${invoices.issueDate}, 'YYYY-MM')`,
        count: sql<number>`count(*)::int`,
        amountExclCents: sql<string>`coalesce(sum(${invoices.amountExclCents}), 0)::bigint`,
        taxCents: sql<string>`coalesce(sum(${invoices.taxCents}), 0)::bigint`,
        amountInclCents: sql<string>`coalesce(sum(${invoices.amountInclCents}), 0)::bigint`,
      })
      .from(invoices)
      .where(where)
      .groupBy(sql`to_char(${invoices.issueDate}, 'YYYY-MM')`)
      .orderBy(asc(sql`to_char(${invoices.issueDate}, 'YYYY-MM')`));

    const num = (v: unknown) => Number(v ?? 0);
    return {
      from: from ?? null,
      to: to ?? null,
      count: Number(row?.count ?? 0),
      amountExclCents: num(row?.amountExclCents),
      taxCents: num(row?.taxCents),
      amountInclCents: num(row?.amountInclCents),
      byCustomer: byCustomer.map((r) => ({
        customerId: r.customerId,
        customerName: r.customerName ?? '',
        count: Number(r.count ?? 0),
        amountExclCents: num(r.amountExclCents),
        taxCents: num(r.taxCents),
        amountInclCents: num(r.amountInclCents),
      })),
      byMonth: byMonth.map((r) => ({
        month: r.month,
        count: Number(r.count ?? 0),
        amountExclCents: num(r.amountExclCents),
        taxCents: num(r.taxCents),
        amountInclCents: num(r.amountInclCents),
      })),
    };
  }

  // ==================== 单订单开票/收款进度 ====================
  /**
   * 订单开票进度（实时聚合）：订单金额 / 已开票（含税）/ 未开票 + 相关发票清单。
   * 附带只读的收款进度（订单级应收的已核销额），便于账务页同屏对账；不改动收款/核销逻辑。
   */
  async orderStatus(orderId: number) {
    const [row] = await db
      .select({ o: orders, customerName: customers.name })
      .from(orders)
      .leftJoin(customers, eq(orders.customerId, customers.id))
      .where(eq(orders.id, orderId));
    if (!row) throw new NotFoundException('订单不存在');

    const orderAmountCents = await this.orderAmountCents(orderId);
    const invs = await this.invoiceRowsByOrder(orderId);
    const view = buildOrderInvoiceView(orderAmountCents, invs.map((x) => x.inv));

    // 订单级应收（订单确认时开立）的已收/未收：只读聚合
    const [recv] = await db
      .select({ amount: receivables.amount, settledAmount: receivables.settledAmount })
      .from(receivables)
      .where(
        and(eq(receivables.sourceType, 'order'), eq(receivables.sourceId, orderId), ne(receivables.status, 'voided')),
      );
    const receivableCents = recv ? toCents(recv.amount) : 0;
    const receivedCents = recv ? toCents(recv.settledAmount) : 0;

    return {
      orderId,
      orderNo: row.o.orderNo,
      customerId: row.o.customerId,
      customerName: row.customerName ?? '',
      orderStatus: row.o.status,
      orderAmountCents,
      invoicedCents: view.invoicedCents,
      uninvoicedCents: view.uninvoicedCents,
      overInvoiced: view.overInvoiced,
      invoiceCount: view.invoiceCount,
      voidedCount: view.voidedCount,
      warning: view.warning,
      receivableCents,
      receivedCents,
      unreceivedCents: Math.max(0, receivableCents - receivedCents),
      invoices: invs.map((x) => this.toItem({ inv: x.inv, customerName: row.customerName, operatorName: x.operatorName, voidOperatorName: x.voidOperatorName }, [])),
    };
  }

  /** 订单金额（分）：按订单行 Σ(数量 × round(单价×100))，SQL 定点计算，无浮点尾差 */
  private async orderAmountCents(orderId: number): Promise<number> {
    const [row] = await db
      .select({
        cents: sql<string>`coalesce(sum(${orderLines.quantity} * round(${orderLines.unitPrice} * 100)), 0)::bigint`,
      })
      .from(orderLines)
      .where(eq(orderLines.orderId, orderId));
    return Number(row?.cents ?? 0);
  }

  private async invoiceRowsByOrder(orderId: number) {
    return db
      .select({ inv: invoices, operatorName: operators.name, voidOperatorName: voidOperator.name })
      .from(invoiceOrders)
      .innerJoin(invoices, eq(invoiceOrders.invoiceId, invoices.id))
      .leftJoin(operators, eq(invoices.operatorId, operators.id))
      .leftJoin(voidOperator, eq(invoices.voidOperatorId, voidOperator.id))
      .where(eq(invoiceOrders.orderId, orderId))
      .orderBy(asc(invoices.id));
  }

  /** 批量：订单 id → 已开票含税金额（分，只计未作废）。订单列表/详情挂「已开票/未开票」用 */
  async invoicedCentsByOrder(orderIds: number[]): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (!orderIds.length) return map;
    const rows = await db
      .select({ orderId: invoiceOrders.orderId, cents: invoices.amountInclCents })
      .from(invoiceOrders)
      .innerJoin(
        invoices,
        and(eq(invoiceOrders.invoiceId, invoices.id), eq(invoices.status, 'normal' as InvoiceStatus)),
      )
      .where(inArray(invoiceOrders.orderId, orderIds));
    for (const r of rows) map.set(r.orderId, (map.get(r.orderId) ?? 0) + Math.round(Number(r.cents ?? 0)));
    return map;
  }

  // ==================== 新建 ====================
  async create(dto: CreateInvoiceDto) {
    const amounts = normalizeInvoiceAmounts(dto);
    const invoiceNo = (dto.invoiceNo ?? '').trim();
    if (!invoiceNo) throw new BadRequestException('发票号码（invoiceNo）必填');
    const issueDate = (dto.issueDate ?? '').trim() || todayYmd();
    this.assertDate(issueDate, '开票日期（issueDate）');
    const orderIds = [...new Set((dto.orderIds ?? []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];

    const created = await db
      .transaction(async (tx: Tx) => {
        const [cust] = await tx.select().from(customers).where(eq(customers.id, dto.customerId));
        if (!cust) throw new NotFoundException('客户不存在');
        await this.assertOrders(tx, orderIds, dto.customerId);
        const [dup] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(and(eq(invoices.invoiceNo, invoiceNo), eq(invoices.status, 'normal' as InvoiceStatus)));
        if (dup) {
          throw new BadRequestException(invoiceNoConflictMessage(invoiceNo));
        }
        const [inv] = await tx
          .insert(invoices)
          .values({
            invoiceNo,
            invoiceType: dto.invoiceType,
            customerId: dto.customerId,
            taxRate: amounts.taxRate,
            amountExclCents: amounts.amountExclCents,
            taxCents: amounts.taxCents,
            amountInclCents: amounts.amountInclCents,
            issueDate,
            remark: dto.remark ?? null,
            operatorId: currentOperatorId(),
          })
          .returning();
        if (orderIds.length) {
          await tx.insert(invoiceOrders).values(orderIds.map((orderId) => ({ invoiceId: inv.id, orderId })));
        }
        return inv;
      })
      .catch((e: unknown) => {
        // 并发同号：预检查会漏，兜底唯一索引冲突 → 同一句中文提示
        if (isUniqueViolation(e)) {
          throw new BadRequestException(invoiceNoConflictMessage(invoiceNo));
        }
        throw e;
      });

    const item = await this.findOne(created.id);
    const warning = await this.overInvoiceWarning(orderIds);
    return warning ? { ...item, warning } : item;
  }

  // ==================== 编辑（非金额关键字段） ====================
  async update(id: number, dto: UpdateInvoiceDto) {
    const cur = await this.findOne(id);
    if (cur.status !== 'normal') {
      throw new BadRequestException(voidedImmutableMessage(cur.invoiceNo));
    }
    // 金额关键字段（不含税金额）一律不可改；改税率时由服务端按定点助手重算税额与含税金额
    if (dto.amountExclCents !== undefined) {
      throw new BadRequestException(amountImmutableMessage('不含税金额（amountExclCents）'));
    }
    const nextRate = dto.taxRate !== undefined ? dto.taxRate : Number(cur.taxRate);
    const amounts = normalizeInvoiceAmounts({
      amountExclCents: cur.amountExclCents,
      taxRate: nextRate,
      taxCents: dto.taxCents,
      amountInclCents: dto.amountInclCents,
    });
    const issueDate = dto.issueDate !== undefined ? String(dto.issueDate).trim() : cur.issueDate;
    this.assertDate(issueDate, '开票日期（issueDate）');
    const orderIds = dto.orderIds !== undefined
      ? [...new Set((dto.orderIds ?? []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))]
      : null;

    await db.transaction(async (tx: Tx) => {
      if (orderIds) await this.assertOrders(tx, orderIds, cur.customerId);
      await tx
        .update(invoices)
        .set({
          taxRate: amounts.taxRate,
          taxCents: amounts.taxCents,
          amountInclCents: amounts.amountInclCents,
          issueDate,
          remark: dto.remark !== undefined ? (dto.remark ?? null) : cur.remark,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, id));
      if (orderIds) {
        await tx.delete(invoiceOrders).where(eq(invoiceOrders.invoiceId, id));
        if (orderIds.length) {
          await tx.insert(invoiceOrders).values(orderIds.map((orderId) => ({ invoiceId: id, orderId })));
        }
      }
    });

    const item = await this.findOne(id);
    const warning = orderIds ? await this.overInvoiceWarning(orderIds) : undefined;
    return warning ? { ...item, warning } : item;
  }

  // ==================== 作废 ====================
  /** 作废：只置状态并留痕（原因/时间/作废人），不物理删除；作废后不计入统计但记录可查 */
  async voidInvoice(id: number, reason: string) {
    const text = (reason ?? '').trim();
    if (!text) throw new BadRequestException('作废原因（reason）必填');
    await db.transaction(async (tx: Tx) => {
      const updated = await tx
        .update(invoices)
        .set({
          status: 'voided',
          voidReason: text,
          voidedAt: new Date(),
          voidOperatorId: currentOperatorId(),
          updatedAt: new Date(),
        })
        .where(and(eq(invoices.id, id), eq(invoices.status, 'normal' as InvoiceStatus)))
        .returning({ id: invoices.id });
      if (!updated.length) {
        const [cur] = await tx
          .select({ no: invoices.invoiceNo, status: invoices.status, voidedAt: invoices.voidedAt, reason: invoices.voidReason })
          .from(invoices)
          .where(eq(invoices.id, id));
        if (!cur) throw new NotFoundException('发票不存在');
        const when = cur.voidedAt instanceof Date ? cur.voidedAt.toISOString().slice(0, 16).replace('T', ' ') : '';
        throw new BadRequestException(alreadyVoidedMessage(cur.no, when, cur.reason));
      }
    });
    return this.findOne(id);
  }

  // ==================== 内部校验 ====================
  private assertDate(v: string, label: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
      throw new BadRequestException(`${label}格式须为 YYYY-MM-DD，实际：${v}`);
    }
  }

  /** 关联订单校验：必须存在，且与发票客户一致（否则对账口径会串客户） */
  private async assertOrders(tx: Tx, orderIds: number[], customerId: number) {
    if (!orderIds.length) return;
    const rows = await tx.select().from(orders).where(inArray(orders.id, orderIds));
    if (rows.length !== orderIds.length) {
      const found = new Set(rows.map((o) => o.id));
      const missing = orderIds.filter((x) => !found.has(x));
      throw new BadRequestException(ordersMissingMessage(missing));
    }
    const mismatch = rows.filter((o) => o.customerId !== customerId);
    if (mismatch.length) {
      throw new BadRequestException(orderCustomerMismatchMessage(mismatch.map((o) => o.orderNo), customerId));
    }
  }

  /** 超额开票提示（不阻断）：逐个订单实时聚合后拼提示 */
  private async overInvoiceWarning(orderIds: number[]): Promise<string | undefined> {
    if (!orderIds.length) return undefined;
    const parts: string[] = [];
    for (const orderId of orderIds) {
      const [row] = await db.select({ no: orders.orderNo }).from(orders).where(eq(orders.id, orderId));
      if (!row) continue;
      const amount = await this.orderAmountCents(orderId);
      const invs = await this.invoiceRowsByOrder(orderId);
      const view = buildOrderInvoiceView(amount, invs.map((x) => x.inv));
      if (view.overInvoiced && view.warning) parts.push(`${row.no}：${view.warning}`);
    }
    return parts.length ? parts.join('；') : undefined;
  }

  /** 供其它模块复用：按订单 id 汇总已开票（含税分）—— 与 orderStatus 同一口径 */
  async summarizeOfOrder(orderId: number) {
    const amount = await this.orderAmountCents(orderId);
    const invs = await this.invoiceRowsByOrder(orderId);
    return buildOrderInvoiceView(amount, invs.map((x) => x.inv));
  }

  /** 求和使用（供单测/报表复算）：只计未作废 */
  summarizeRows(rows: Array<{ status: string; amountExclCents: number; taxCents: number; amountInclCents: number }>) {
    return summarizeInvoices(rows);
  }
}
