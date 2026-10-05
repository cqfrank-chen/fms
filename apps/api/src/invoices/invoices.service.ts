import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gte, ilike, inArray, like, lte, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { appSettings, customers, invoiceOrders, invoices, operators, orderLines, orders, receivables } from '../db/schema';
import type { InvoiceStatus, InvoiceType } from '../db/schema';
import { currentOperatorId } from '../common/operator-context';
import { fromCents, toCents } from '../common/money';
import { normalizeInvoiceAmounts, solveExclFromIncl, yuanText } from './invoice-amount';
import {
  alreadyVoidedMessage, amountImmutableMessage, invoiceNoConflictMessage, invoiceNoImmutableMessage,
  orderCustomerMismatchMessage, ordersMissingMessage, voidedImmutableMessage,
} from './invoice-messages';
import { INVOICE_DEFAULT_TAX_RATE_KEY, normalizeDefaultTaxRate } from './invoice-settings';
import {
  buildOrderInvoiceView, overInvoiceBlocked, redFlushedCents, redRemainCents, summarizeInvoices,
} from './invoice-stats';

const pad2 = (n: number) => String(n).padStart(2, '0');
/** 业务日（本地时区，东八区）：开票日期默认当天，不因 UTC 化串日 */
const todayYmd = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/**
 * 自动占位票号前缀（简化交互）：发票号选填，缺省时自动生成「待补号-YYYYMMDD-NN」，
 * 后续可在编辑时补录真实票号（仅当当前票号仍是占位号时允许改号）。
 */
export const INVOICE_PLACEHOLDER_PREFIX = '待补号-';

/** 作废操作人（与开票人分开 join，避免同一张表两次左连的别名冲突） */
const voidOperator = alias(operators, 'void_operator');
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 新建开票入参：简化路径只需 amountInclCents（含税，单位分）+ 可选 invoiceNo/issueDate/orderIds */
export interface CreateInvoiceDto {
  /** 发票号码；选填（缺省自动生成占位号「待补号-YYYYMMDD-NN」，可随后补录） */
  invoiceNo?: string;
  /** 票种；选填，缺省 vat_general */
  invoiceType?: InvoiceType;
  /** 客户；选填，缺省由关联订单反推（未挂单时必填） */
  customerId?: number;
  /** 不含税金额（分）；与 amountInclCents 至少给一个 */
  amountExclCents?: number;
  /** 税率；选填，缺省 0（不含税=含税、税额=0） */
  taxRate?: number;
  taxCents?: number;
  /** 含税金额（分）；简化交互主路径 */
  amountInclCents?: number;
  issueDate?: string;
  orderIds?: number[];
  remark?: string;
  /**
   * 允许超开（I16 收敛⑤）：默认 false = 超出订单金额直接 400；
   * 只有前端「高级」显式勾选才放行（放行后仍返回 warning 提示）。
   */
  allowOverInvoiced?: boolean;
}

/** 红冲入参（I16 红字发票）：金额为**正数红冲额**（缺省=全额红冲），服务端落库为负数金额 */
export interface RedFlushDto {
  /** 冲红原因（必填） */
  reason?: string;
  /** 红字发票号（必填：红字票必须有自己的真实票号，不支持占位号） */
  invoiceNo?: string;
  /** 红冲金额（正数，单位分）；缺省 = 原票含税金额（全额红冲）；可小于原票 = 部分红冲 */
  amountInclCents?: number;
  issueDate?: string;
  remark?: string;
}

export interface UpdateInvoiceDto {
  /** 仅当当前票号是占位号（待补号-…）时允许补录真实票号 */
  invoiceNo?: string;
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
  /** 只看待补票号（I16 收敛①）：票号为占位号「待补号-…」且未作废 */
  missingNo?: boolean;
}

/** PostgreSQL 唯一约束冲突（SQLSTATE 23505） */
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';

/**
 * 开票模块（I16）—— 与收款/核销并行的独立线
 * ------------------------------------------------------------------
 * · 开票只记「开票事实」（票号/票种/税率/三金额/关联订单），不参与核销、不改收款逻辑；
 * · 金额全部按「分」整数存储与校验（money.ts 定点助手），三兄弟恒等式由 invoice-amount.ts 强校验；
 * · 订单已开票金额**实时聚合**（净额口径：未作废的票全部计入，红字票为负数），不落冗余字段；
 * · 作废（当月错票）与红冲（跨月错票，红字发票）都只置状态并留痕，保留可查；
 *   净额 = Σ(未作废正常票) + Σ(未作废红字票，负)，已红冲原票仍计正数，故全额红冲后净额精确归零；
 * · 未作废票号唯一（部分唯一索引）。
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
    const red = await this.redRelations(rows.map((r) => r.inv));
    return {
      items: rows.map((r) => this.toItem(r, refs.get(r.inv.id) ?? [], red.get(r.inv.id))),
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
    const red = await this.redRelations([row.inv]);
    return this.toItem(row, refs.get(row.inv.id) ?? [], red.get(row.inv.id));
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
    if (q.missingNo) {
      conds.push(and(eq(invoices.status, 'normal' as InvoiceStatus), like(invoices.invoiceNo, `${INVOICE_PLACEHOLDER_PREFIX}%`)));
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

  /**
   * 红冲关系（I16 红字发票）：给每张票挂上
   *   redFlushOfNo    本票为红字票时的原票号
   *   redFlushNos     本票为原票时的红字票号列表（未作废）
   *   redFlushedCents 该原票已红冲金额（正数，分）
   *   redRemainCents  该原票还可红冲金额（正数，分）
   */
  private async redRelations(rows: Array<{ id: number; invoiceNo: string; status: InvoiceStatus; redFlushOf: number | null; amountInclCents: number }>) {
    const map = new Map<number, { redFlushOfNo: string | null; redFlushNos: string[]; redFlushedCents: number; redRemainCents: number }>();
    if (!rows.length) return map;
    const ids = rows.map((r) => r.id);
    const originIds = [...new Set(rows.map((r) => r.redFlushOf).filter((x): x is number => x != null))];
    const originRows = originIds.length
      ? await db.select({ id: invoices.id, no: invoices.invoiceNo }).from(invoices).where(inArray(invoices.id, originIds))
      : [];
    const originNo = new Map(originRows.map((r) => [r.id, r.no]));
    const children = await db
      .select({ id: invoices.id, no: invoices.invoiceNo, status: invoices.status, of: invoices.redFlushOf, cents: invoices.amountInclCents })
      .from(invoices)
      .where(inArray(invoices.redFlushOf, ids));
    const byOrigin = new Map<number, Array<{ no: string; status: InvoiceStatus; cents: number }>>();
    for (const c of children) {
      if (c.of == null) continue;
      const arr = byOrigin.get(c.of) ?? [];
      arr.push({ no: c.no, status: c.status, cents: Math.round(Number(c.cents ?? 0)) });
      byOrigin.set(c.of, arr);
    }
    for (const r of rows) {
      const kids = (byOrigin.get(r.id) ?? []).filter((k) => k.status !== 'voided');
      const flushed = redFlushedCents(kids.map((k) => ({ status: k.status, amountExclCents: 0, taxCents: 0, amountInclCents: k.cents })));
      map.set(r.id, {
        redFlushOfNo: r.redFlushOf != null ? (originNo.get(r.redFlushOf) ?? null) : null,
        redFlushNos: kids.map((k) => k.no),
        redFlushedCents: flushed,
        redRemainCents: redRemainCents(r.amountInclCents, kids.map((k) => ({ status: k.status, amountExclCents: 0, taxCents: 0, amountInclCents: k.cents }))),
      });
    }
    return map;
  }

  private toItem(
    row: { inv: typeof invoices.$inferSelect; customerName?: string | null; operatorName?: string | null; voidOperatorName?: string | null },
    refs: Array<{ orderId: number; orderNo: string }>,
    red?: { redFlushOfNo: string | null; redFlushNos: string[]; redFlushedCents: number; redRemainCents: number },
  ) {
    return {
      ...row.inv,
      customerName: row.customerName ?? '',
      operatorName: row.operatorName ?? null,
      voidOperatorName: row.voidOperatorName ?? null,
      orderRefs: refs,
      orderNos: refs.map((r) => r.orderNo),
      redFlushOfNo: red?.redFlushOfNo ?? null,
      redFlushNos: red?.redFlushNos ?? [],
      redFlushedCents: red?.redFlushedCents ?? 0,
      redRemainCents: red?.redRemainCents ?? Math.abs(Math.round(row.inv.amountInclCents)),
      isRed: row.inv.redFlushOf != null,
    };
  }

  // ==================== 开票数目（统计） ====================
  /**
   * 开票数目/金额（**净额口径**）：张数 + 含税/不含税/税额合计 + 按客户/按月分组。
   * 只剔除已作废票；红字票以负数计入、已红冲原票仍计正数 → 合计即净额。
   * pendingNoCount：区间内「待补票号」张数（占位号且未作废）。
   */
  async summary(from?: string, to?: string) {
    const conds = [ne(invoices.status, 'voided' as InvoiceStatus)];
    if (from) conds.push(gte(invoices.issueDate, from));
    if (to) conds.push(lte(invoices.issueDate, to));
    const where = and(...conds);
    const pendingNoWhere = and(
      eq(invoices.status, 'normal' as InvoiceStatus),
      like(invoices.invoiceNo, `${INVOICE_PLACEHOLDER_PREFIX}%`),
      ...(from ? [gte(invoices.issueDate, from)] : []),
      ...(to ? [lte(invoices.issueDate, to)] : []),
    );

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

    const [pendingRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(invoices)
      .where(pendingNoWhere);

    const num = (v: unknown) => Number(v ?? 0);
    return {
      from: from ?? null,
      to: to ?? null,
      count: Number(row?.count ?? 0),
      pendingNoCount: Number(pendingRow?.n ?? 0),
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
    const redMap = await this.redRelations(invs.map((x) => x.inv));

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
      invoiceState: view.invoiceState,
      invoiceCount: view.invoiceCount,
      voidedCount: view.voidedCount,
      warning: view.warning,
      receivableCents,
      receivedCents,
      unreceivedCents: Math.max(0, receivableCents - receivedCents),
      invoices: invs.map((x) => this.toItem(
        { inv: x.inv, customerName: row.customerName, operatorName: x.operatorName, voidOperatorName: x.voidOperatorName },
        [],
        redMap.get(x.inv.id),
      )),
    };
  }

  /** 占位票号：待补号-YYYYMMDD-NN（同前缀最大序号 +1，含作废记录一并避开撞号） */
  private async nextPlaceholderNo(tx: Tx, ymdDate: string): Promise<string> {
    const prefix = `${INVOICE_PLACEHOLDER_PREFIX}${ymdDate}-`;
    const [row] = await tx
      .select({ mx: sql<number | null>`coalesce(max(substring(${invoices.invoiceNo} from '[0-9]+$')::int), 0)` })
      .from(invoices)
      .where(like(invoices.invoiceNo, `${prefix}%`));
    return `${prefix}${pad2(Number(row?.mx ?? 0) + 1)}`;
  }

  /** 多订单合计：订单金额（分）与当前已开票净额（分）——超开闸门用 */
  private async ordersInvoiceTotals(orderIds: number[]): Promise<{ amountCents: number; invoicedCents: number }> {
    let amountCents = 0;
    for (const id of orderIds) amountCents += await this.orderAmountCents(id);
    const netMap = await this.invoicedCentsByOrder(orderIds);
    let invoicedCents = 0;
    for (const id of orderIds) invoicedCents += netMap.get(id) ?? 0;
    return { amountCents, invoicedCents };
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

  /**
   * 批量：订单 id → 已开票含税净额（分）。订单列表/详情挂「已开票/开票状态」用。
   * 净额口径：未作废的票全部计入（红字票为负数、已红冲原票仍计正数）。
   */
  async invoicedCentsByOrder(orderIds: number[]): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (!orderIds.length) return map;
    const rows = await db
      .select({ orderId: invoiceOrders.orderId, cents: invoices.amountInclCents })
      .from(invoiceOrders)
      .innerJoin(
        invoices,
        and(eq(invoiceOrders.invoiceId, invoices.id), ne(invoices.status, 'voided' as InvoiceStatus)),
      )
      .where(inArray(invoiceOrders.orderId, orderIds));
    for (const r of rows) map.set(r.orderId, (map.get(r.orderId) ?? 0) + Math.round(Number(r.cents ?? 0)));
    return map;
  }

  // ==================== 新建 ====================
  /**
   * 新建发票（简化交互）：
   * · 金额：只需 amountInclCents（含税，单位分），税率缺省 0 → 不含税=含税、税额=0；
   *   完整入参（amountExclCents ± taxCents/amountInclCents）与既有调用完全兼容；
   * · 票号：选填，缺省自动生成占位号「待补号-YYYYMMDD-NN」，可随后编辑补录；
   * · 票种：选填，缺省 vat_general；
   * · 客户：选填，缺省时由关联订单反推（多单必须同客户）。
   */
  async create(dto: CreateInvoiceDto) {
    const amounts = normalizeInvoiceAmounts(dto);
    const invoiceNoInput = (dto.invoiceNo ?? '').trim();
    const invoiceType: InvoiceType = dto.invoiceType ?? 'vat_general';
    const issueDate = (dto.issueDate ?? '').trim() || todayYmd();
    this.assertDate(issueDate, '开票日期（issueDate）');
    const orderIds = [...new Set((dto.orderIds ?? []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];

    // 先校验关联订单存在（否则超开闸门会先报「已开完」而不是更准确的「订单不存在」）
    if (orderIds.length) {
      const found = await db.select({ id: orders.id }).from(orders).where(inArray(orders.id, orderIds));
      if (found.length !== orderIds.length) {
        const has = new Set(found.map((r) => r.id));
        throw new BadRequestException(ordersMissingMessage(orderIds.filter((x) => !has.has(x))));
      }
    }

    // 超开闸门（I16 收敛⑤）：默认阻止；只有「高级」显式勾选 allowOverInvoiced 才放行（放行后仍回 warning）
    if (orderIds.length && !dto.allowOverInvoiced) {
      const totals = await this.ordersInvoiceTotals(orderIds);
      if (overInvoiceBlocked(totals.amountCents, totals.invoicedCents, amounts.amountInclCents, false)) {
        throw new BadRequestException(
          `所选订单已开完票：订单金额 ${yuanText(totals.amountCents)}，已开票 ${yuanText(totals.invoicedCents)}，本次 ${yuanText(amounts.amountInclCents)} 将超出；`
          + '如需继续请在「高级」里勾选「允许超开」后重试',
        );
      }
    }

    // 票号占位（在事务内取号，避免并发撞号）
    let invoiceNo = invoiceNoInput;
    const created = await db
      .transaction(async (tx: Tx) => {
        // 客户缺省：由关联订单反推（简化交互下前端只传订单 + 一个金额）
        const customerId = dto.customerId ?? (await this.customerIdFromOrders(tx, orderIds));
        const [cust] = await tx.select().from(customers).where(eq(customers.id, customerId));
        if (!cust) throw new NotFoundException('客户不存在');
        await this.assertOrders(tx, orderIds, customerId);
        if (!invoiceNo) invoiceNo = await this.nextPlaceholderNo(tx, issueDate.replace(/-/g, ''));
        const [dup] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(and(eq(invoices.invoiceNo, invoiceNo), ne(invoices.status, 'voided' as InvoiceStatus)));
        if (dup) {
          throw new BadRequestException(invoiceNoConflictMessage(invoiceNo));
        }
        const [inv] = await tx
          .insert(invoices)
          .values({
            invoiceNo,
            invoiceType,
            customerId,
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
    const isRed = cur.redFlushOf != null;
    if (isRed && dto.taxRate !== undefined) {
      throw new BadRequestException('红字发票的税率沿用被冲原票，不可修改（如需更正请作废该红字票后重新红冲）');
    }
    const nextRate = dto.taxRate !== undefined ? dto.taxRate : Number(cur.taxRate);
    const amounts = normalizeInvoiceAmounts(
      {
        amountExclCents: cur.amountExclCents,
        taxRate: nextRate,
        taxCents: dto.taxCents,
        amountInclCents: dto.amountInclCents,
      },
      { allowNegative: isRed },
    );
    const issueDate = dto.issueDate !== undefined ? String(dto.issueDate).trim() : cur.issueDate;
    this.assertDate(issueDate, '开票日期（issueDate）');
    const orderIds = dto.orderIds !== undefined
      ? [...new Set((dto.orderIds ?? []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))]
      : null;

    // 票号：占位号（待补号-…）允许补录为真实票号；真实票号不可改（换号请作废重开）
    let nextInvoiceNo: string | null = null;
    if (dto.invoiceNo !== undefined) {
      const raw = String(dto.invoiceNo).trim();
      if (!raw) throw new BadRequestException('发票号码（invoiceNo）不能为空');
      if (raw !== cur.invoiceNo) {
        if (!cur.invoiceNo.startsWith(INVOICE_PLACEHOLDER_PREFIX)) {
          throw new BadRequestException(invoiceNoImmutableMessage(cur.invoiceNo));
        }
        nextInvoiceNo = raw;
      }
    }

    await db
      .transaction(async (tx: Tx) => {
        if (orderIds) await this.assertOrders(tx, orderIds, cur.customerId);
        if (nextInvoiceNo) {
          const [dup] = await tx
            .select({ id: invoices.id })
            .from(invoices)
            .where(and(eq(invoices.invoiceNo, nextInvoiceNo), ne(invoices.status, 'voided' as InvoiceStatus)));
          if (dup) throw new BadRequestException(invoiceNoConflictMessage(nextInvoiceNo));
        }
        await tx
          .update(invoices)
          .set({
            ...(nextInvoiceNo ? { invoiceNo: nextInvoiceNo } : {}),
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
      })
      .catch((e: unknown) => {
        if (isUniqueViolation(e) && nextInvoiceNo) {
          throw new BadRequestException(invoiceNoConflictMessage(nextInvoiceNo));
        }
        throw e;
      });

    const item = await this.findOne(id);
    const warning = orderIds ? await this.overInvoiceWarning(orderIds) : undefined;
    return warning ? { ...item, warning } : item;
  }

  // ==================== 作废（当月错票） ====================
  /**
   * 作废：只置状态并留痕（原因/时间/作废人），不物理删除；作废后不计入统计但记录可查。
   * · 已被红冲的原票不可作废（会与红字发票的负数叠加成负净额），需先作废对应红字票；
   * · 作废红字发票时，若该原票已无有效红字票，自动把原票状态由「已红冲」还原为「正常」。
   */
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
        .returning({ id: invoices.id, redFlushOf: invoices.redFlushOf });
      if (!updated.length) {
        const [cur] = await tx
          .select({ no: invoices.invoiceNo, status: invoices.status, voidedAt: invoices.voidedAt, reason: invoices.voidReason })
          .from(invoices)
          .where(eq(invoices.id, id));
        if (!cur) throw new NotFoundException('发票不存在');
        if (cur.status === 'red_flushed') {
          throw new BadRequestException(
            `发票 ${cur.no} 已被红冲，不可再作废（否则正负叠加会算成负净额）：如需冲回请作废对应的红字发票`,
          );
        }
        const when = cur.voidedAt instanceof Date ? cur.voidedAt.toISOString().slice(0, 16).replace('T', ' ') : '';
        throw new BadRequestException(alreadyVoidedMessage(cur.no, when, cur.reason));
      }
      // 作废的是红字发票 → 原票若无其它有效红字票，状态还原为正常（净额由红字票负数决定，状态仅为可读性）
      const redOf = updated[0].redFlushOf;
      if (redOf != null) {
        const kids = await tx
          .select({ status: invoices.status })
          .from(invoices)
          .where(eq(invoices.redFlushOf, redOf));
        if (!kids.some((k) => k.status !== 'voided')) {
          await tx
            .update(invoices)
            .set({ status: 'normal', updatedAt: new Date() })
            .where(and(eq(invoices.id, redOf), eq(invoices.status, 'red_flushed' as InvoiceStatus)));
        }
      }
    });
    return this.findOne(id);
  }

  // ==================== 红冲（跨月错票 → 红字发票） ====================
  /**
   * 开具红字发票冲减原票（跨月错票不可作废，只能红冲）：
   * · 红字票 = 一张**负数金额**发票，票号必填（自带真实票号，不支持占位号），冲红原因必填；
   * · 金额缺省 = 原票含税（全额红冲）；可传更小的正数做部分红冲；
   * · 累计红冲不得超过原票金额（超出 400 中文提示）；
   * · 已作废票、红字票本身不可红冲；
   * · 红字票沿用原票客户、票种、税率与关联订单（这样订单净额才自动扣减）；
   * · 生成后原票状态置 red_flushed，并与其红字票互相可见。
   */
  async redFlush(id: number, dto: RedFlushDto) {
    const reason = (dto.reason ?? '').trim();
    if (!reason) throw new BadRequestException('冲红原因（reason）必填');
    const invoiceNo = (dto.invoiceNo ?? '').trim();
    if (!invoiceNo) {
      throw new BadRequestException('红字发票号（invoiceNo）必填：红字发票必须有自己的真实票号（不支持占位号）');
    }
    const issueDate = (dto.issueDate ?? '').trim() || todayYmd();
    this.assertDate(issueDate, '红冲日期（issueDate）');

    const original = await this.findOne(id);
    if (original.redFlushOf != null) {
      throw new BadRequestException(`发票 ${original.invoiceNo} 是红字发票，不可再红冲`);
    }
    if (original.status === 'voided') {
      throw new BadRequestException(`发票 ${original.invoiceNo} 已作废，不可红冲（当月错票直接用「作废」即可）`);
    }
    const originalCents = Math.abs(Math.round(original.amountInclCents));
    const existRedRows = await db
      .select({ status: invoices.status, cents: invoices.amountInclCents })
      .from(invoices)
      .where(eq(invoices.redFlushOf, id));
    const remainCents = redRemainCents(
      originalCents,
      existRedRows.map((r) => ({ status: r.status, amountExclCents: 0, taxCents: 0, amountInclCents: Math.round(Number(r.cents ?? 0)) })),
    );
    const flushedCents = originalCents - remainCents;

    const magnitude = dto.amountInclCents == null ? originalCents : Math.round(Number(dto.amountInclCents));
    if (!Number.isFinite(magnitude) || magnitude <= 0) {
      throw new BadRequestException(`红冲金额（amountInclCents，正数，单位：分）必须大于 0，实际：${dto.amountInclCents ?? null}`);
    }
    if (magnitude > remainCents) {
      throw new BadRequestException(
        `红冲金额超过可红冲余额：原票 ${yuanText(originalCents)}，已红冲 ${yuanText(flushedCents)}，`
        + `本次 ${yuanText(magnitude)}，还可红冲 ${yuanText(remainCents)}`,
      );
    }

    const rate = Number(original.taxRate);
    const solvedExcl = solveExclFromIncl(magnitude, rate);
    if (solvedExcl === null) {
      throw new BadRequestException(
        `按红冲金额 ${yuanText(magnitude)} 与税率 ${Number((rate * 100).toFixed(4))}% 无法拆分不含税与税额：请调整红冲金额`,
      );
    }
    const taxMag = magnitude - solvedExcl;
    const amounts = normalizeInvoiceAmounts(
      { amountExclCents: -solvedExcl, taxRate: rate, taxCents: -taxMag, amountInclCents: -magnitude },
      { allowNegative: true },
    );
    const orderIds = original.orderRefs.map((r) => r.orderId);

    const created = await db
      .transaction(async (tx: Tx) => {
        const [dup] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(and(eq(invoices.invoiceNo, invoiceNo), ne(invoices.status, 'voided' as InvoiceStatus)));
        if (dup) throw new BadRequestException(invoiceNoConflictMessage(invoiceNo));
        const [inv] = await tx
          .insert(invoices)
          .values({
            invoiceNo,
            invoiceType: original.invoiceType,
            customerId: original.customerId,
            taxRate: amounts.taxRate,
            amountExclCents: amounts.amountExclCents,
            taxCents: amounts.taxCents,
            amountInclCents: amounts.amountInclCents,
            issueDate,
            status: 'normal',
            redFlushOf: id,
            redReason: reason,
            remark: dto.remark ?? null,
            operatorId: currentOperatorId(),
          })
          .returning();
        if (orderIds.length) {
          await tx.insert(invoiceOrders).values(orderIds.map((orderId) => ({ invoiceId: inv.id, orderId })));
        }
        await tx
          .update(invoices)
          .set({ status: 'red_flushed', updatedAt: new Date() })
          .where(and(eq(invoices.id, id), eq(invoices.status, 'normal' as InvoiceStatus)));
        return inv;
      })
      .catch((e: unknown) => {
        if (isUniqueViolation(e)) throw new BadRequestException(invoiceNoConflictMessage(invoiceNo));
        throw e;
      });

    const item = await this.findOne(created.id);
    return {
      ...item,
      redFlushOfNo: original.invoiceNo,
      original: { id, invoiceNo: original.invoiceNo, amountInclCents: originalCents, redFlushedCents: flushedCents + magnitude, redRemainCents: remainCents - magnitude },
    };
  }

  // ==================== 开票设置（I16 收敛②，极简复用 app_settings） ====================
  /** 开票设置：当前只有「默认税率」（未配置时 0） */
  async getSettings() {
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, INVOICE_DEFAULT_TAX_RATE_KEY));
    return { defaultTaxRate: row ? normalizeDefaultTaxRate(row.value) : 0 };
  }

  /** 保存开票设置（admin/accounting） */
  async saveSettings(dto: { defaultTaxRate?: number }) {
    const rate = normalizeDefaultTaxRate(dto?.defaultTaxRate);
    const value = String(rate);
    await db
      .insert(appSettings)
      .values({ key: INVOICE_DEFAULT_TAX_RATE_KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
    return { defaultTaxRate: rate };
  }

  // ==================== 内部校验 ====================
  private assertDate(v: string, label: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
      throw new BadRequestException(`${label}格式须为 YYYY-MM-DD，实际：${v}`);
    }
  }

  /** 从关联订单推断开票客户：未挂单则必须显式给 customerId；多单分属不同客户则拒绝 */
  private async customerIdFromOrders(tx: Tx, orderIds: number[]): Promise<number> {
    if (!orderIds.length) {
      throw new BadRequestException('客户（customerId）必填：未关联订单时无法推断开票客户');
    }
    const rows = await tx
      .select({ id: orders.id, customerId: orders.customerId })
      .from(orders)
      .where(inArray(orders.id, orderIds));
    if (rows.length !== orderIds.length) {
      const found = new Set(rows.map((r) => r.id));
      throw new BadRequestException(ordersMissingMessage(orderIds.filter((x) => !found.has(x))));
    }
    const custIds = [...new Set(rows.map((r) => r.customerId))];
    if (custIds.length > 1) {
      throw new BadRequestException('关联订单分属不同客户，无法推断开票客户：请只选同一客户的订单，或显式指定 customerId');
    }
    return custIds[0];
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
