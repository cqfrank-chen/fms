import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, like, ne, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  customers, operators, orderLines, orders, outbounds,
  planSheetLines, planSheets, products, receivables, ORDERS_DUE_DATE_TBD,
} from '../db/schema';
import type { Currency, NewOrderLine, OrderStatus, PendingItem } from '../db/schema';
import { currentOperatorId } from '../common/operator-context';
import { normalizeCurrency } from '../common/currency';
import { includePlaceholders } from '../common/placeholders';
import { ensurePendingCustomer, ensurePendingProduct, findPendingCustomerId, findPendingProductId } from '../common/pending-entities';
import { fromCents, sumLineCents, toCents } from '../common/money';
import { InvoicesService } from '../invoices/invoices.service';
import { orderInvoiceState } from '../invoices/invoice-stats';
import { QuotesService } from '../quotes/quotes.service';
import { describeHit } from '../quotes/quote-pricing';
import { normName } from '../ai/order-parser.service';
import { sameProductDigits } from '../ai/table-parser.service';
import { findProductCandidates } from '../ai/product-model';
import { computeLinePending, computeOrderPending, PENDING_CODES, pendingText } from './pending-items';
import { orderToSortValues, parseOrderSort, sortOrdersByKeys } from './order-sort';
import { quoteFillTargets, resolveQuoteFills } from './draft-quote-fill';
import type { DraftQuoteFill } from './draft-quote-fill';

/** 事务句柄类型（drizzle transaction callback 参数） */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface OrderLineDto {
  productId: number;
  quantity: number;
  unitPrice: number;
  /** 币种：写入前一律过 normalizeCurrency（RMB / ￥ / 人民币 → CNY，见 common/currency.ts） */
  currency?: Currency;
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
  /** '1' = 只看「有未补全项的草稿单」（识单落草稿后缺价/缺交期/未建档的单据） */
  hasPending?: string;
  /**
   * '1' = 包含占位档案相关单据（未建档客户·待补 / 未建档产品·待补）。
   * I17 裁定：**默认隐藏**占位档案相关的订单；打开「显示占位档案」开关（或按「有未补全项的草稿单」筛选）时显示。
   */
  includePlaceholders?: string;
  /**
   * 多列组合排序：'dueDate:desc,customer:asc,...'（逗号分隔，从左到右 = 优先级从高到低）。
   * 字段必须在白名单内（见 orders/order-sort.ts），非法字段/方向 → 400 中文提示；缺省 = 交期 DESC。
   */
  sort?: string;
}

/** 落草稿的单行入参（识单结果一行；数量/单价可空 = 原始单据本来就没有） */
export interface DraftOrderLineDto {
  productId?: number | null;
  /** 产品原文（productId 为空/未建档时用于建档比对与占位留痕） */
  productName?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  /** 币种：写入前一律过 normalizeCurrency（RMB / ￥ / 人民币 → CNY） */
  currency?: Currency;
  engraving?: string;
  packaging?: Record<string, string>;
  /** 单价来源（识单补价时为 'quote'，用于「补价成功的行不再算缺价」判定） */
  priceFrom?: 'quote' | null;
  quoteId?: number | null;
}

/**
 * 「落草稿订单」入参：识单结果（含 .doc 管线结果）→ 草稿订单。
 * 缺价/缺交期/缺客户/产品未建档都不再阻断落库，改为**逐行标记待补**（见 orders/pending-items.ts）。
 */
export interface CreateDraftOrderDto {
  customerId?: number | null;
  customerName?: string | null;
  /** 文件夹客户（甲方裁定「文件夹=客户」）：优先于 customerName */
  folderCustomer?: string | null;
  poNo?: string | null;
  dueDate?: string | null;
  note?: string | null;
  lines: DraftOrderLineDto[];
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
/** 紧凑年月日（单号用：SO-YYYYMMDD-NN） */
const ymd = (d: Date) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
/** 带分隔符的业务日 YYYY-MM-DD（交期等日期字段一律用它，勿与单号口径 ymd 混用） */
const ymdDash = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly invoices: InvoicesService,
    private readonly quotes: QuotesService,
  ) {}

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
          currency: normalizeCurrency(l.currency),
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

  /**
   * 列表（可选筛选：状态/客户/单号PO关键字；可选多列排序 sort）。
   *
   * 排序：sort 参数先过**字段白名单**（非法字段/方向 → 400 中文提示），默认 `dueDate:desc`。
   * 交期待定（哨兵日 2099-12-31 / due_date_tbd=true）视为「无交期」恒定沉底，
   * 全部键相等时按「创建时间 DESC → 取数顺序（SQL 的 id DESC）」兜底 —— 规则详见 orders/order-sort.ts。
   * 这里在 SQL 取数（保持 id DESC 的稳定基准序）之后做**视图排序**：订单金额/已开票/开票状态/
   * 待补项数/产品行数都是 attachLines 实时派生的列，SQL 里没有同源值，放在 JS 侧排序才能保证
   * 「排序依据」与「列表显示」严格一致。
   */
  async findAll(q: OrderListQuery) {
    const sortKeys = parseOrderSort(q.sort); // 非法参数在此抛 400
    const conds = [];
    if (q.status) conds.push(eq(orders.status, q.status));
    if (q.customerId) conds.push(eq(orders.customerId, q.customerId));
    if (q.kw) {
      const kw = `%${q.kw}%`;
      conds.push(or(like(orders.orderNo, kw), like(orders.poNo, kw)));
    }
    // 只看有未补全项的草稿单：pending_items 非空数组（null = 不参与待补机制的普通订单，不算）
    const hasPendingOnly = q.hasPending === '1' || q.hasPending === 'true';
    if (hasPendingOnly) {
      conds.push(sql`jsonb_array_length(coalesce(${orders.pendingItems}, '[]'::jsonb)) > 0`);
    }
    // I17 甲方裁定：占位档案（未建档客户·待补 / 未建档产品·待补）相关单据**默认隐藏**。
    // 例外：① 显式打开「显示占位档案」开关（includePlaceholders=1）→ 显示（排查用）；
    //       ② 按「有未补全项的草稿单」筛选 → 属于补全工作流，必须能看到这些草稿，否则无从补全。
    if (!includePlaceholders(q.includePlaceholders) && !hasPendingOnly) {
      const pendingCustomerId = await findPendingCustomerId();
      const pendingProductId = await findPendingProductId();
      if (pendingCustomerId != null) conds.push(ne(orders.customerId, pendingCustomerId));
      if (pendingProductId != null) {
        conds.push(sql`not exists (select 1 from order_lines ol where ol.order_id = ${orders.id} and ol.product_id = ${pendingProductId})`);
      }
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
    const list = await this.attachLines(rows);
    return sortOrdersByKeys(list, sortKeys, orderToSortValues);
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

  /**
   * 编辑（仅草稿；单头字段+行整体替换）。
   * I17：识单落草稿的单据（pending_items 非 null）在编辑后**重算待补项**——
   * 补全的项自动消失，未补的继续标记；人工改交期/客户后「待定」「未建档」标记同步清除。
   */
  async update(id: number, dto: Partial<CreateOrderDto>) {
    const existing = await this.requireDraft(id);
    const tracked = Array.isArray(existing.pendingItems); // 只有识单落草稿的单据参与待补机制
    const pendingProductId = tracked ? await findPendingProductId() : null;
    await db.transaction(async (tx) => {
      const dueDate = dto.dueDate ? new Date(dto.dueDate) : existing.dueDate;
      const patch: Record<string, unknown> = {
        customerId: dto.customerId ?? existing.customerId,
        poNo: dto.poNo !== undefined ? (dto.poNo ?? null) : existing.poNo,
        dueDate,
        note: dto.note !== undefined ? (dto.note ?? null) : existing.note,
        updatedAt: new Date(),
      };
      // 人工给出交期 → 清掉「待定」哨兵标记（dueDateTbd 与哨兵日必须成对）
      if (dto.dueDate) patch.dueDateTbd = false;
      await tx.update(orders).set(patch).where(eq(orders.id, id));
      if (dto.lines) {
        // 保留「占位产品行」的原始产品名（识别原文），便于人工建档时对照；按行序对齐（整单替换，UI 顺序不变）
        const oldTexts = tracked
          ? (await tx.select({ t: orderLines.productNameText }).from(orderLines)
              .where(eq(orderLines.orderId, id)).orderBy(orderLines.id)).map((r) => r.t)
          : [];
        await tx.delete(orderLines).where(eq(orderLines.orderId, id));
        await tx.insert(orderLines).values(
          dto.lines.map((l, i) => {
            const isPlaceholder = tracked && l.productId === pendingProductId;
            const pending = tracked
              ? computeLinePending({
                  productId: isPlaceholder ? null : l.productId,
                  productName: oldTexts[i] ?? null,
                  quantity: l.quantity,
                  unitPrice: l.unitPrice,
                  priceFrom: null,
                })
              : [];
            return {
              orderId: id,
              productId: l.productId,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              currency: normalizeCurrency(l.currency),
              engraving: l.engraving ?? null,
              packaging: l.packaging ?? null,
              pendingItems: pending.length ? pending : null,
              productNameText: isPlaceholder ? (oldTexts[i] ?? null) : null,
            };
          }),
        );
      }
      if (tracked) await this.recomputeOrderPending(tx, id);
    });
    return this.findOne(id);
  }

  // ============ I17 识单落草稿 + 待补标记 ============

  /**
   * 落草稿订单：识单结果（含 .doc 管线结果）→ 订单（status='draft'）。
   *
   * 与既有 POST /orders 的区别：**不再因为缺价/缺交期/未建档而拒绝**，
   * 而是逐行/逐单写入中文「待补」诊断（pending_items），后续人工在订单列表按「有未补全项的草稿单」
   * 筛选并逐项补全；补价可一键从报价记录取价（fillQuotePrices）。
   *
   * NOT NULL 约束的处理（不改既有表结构，详见 db/schema.ts 的常量注释）：
   *   · 缺交期 → due_date 写哨兵日 ORDERS_DUE_DATE_TBD + due_date_tbd=true（界面显示「待定」）；
   *   · 缺客户 → customer_id 指向**惰性创建**的占位客户「（未建档客户·待补）」，原名记 draft_customer_name；
   *   · 缺产品 → product_id 指向占位产品「（未建档产品·待补）」，原文记 order_lines.product_name_text；
   *   · 缺数量/缺价 → 存 0（数量/单价列 NOT NULL）并标待补，**确认前必须补齐**（confirmOrder 会拦截）。
   */
  async createDraftFromParse(dto: CreateDraftOrderDto) {
    const headName = (dto.folderCustomer ?? dto.customerName ?? '').trim() || null;
    const customer = await this.resolveDraftCustomer(dto.customerId ?? null, headName);
    const due = this.resolveDraftDueDate(dto.dueDate ?? null);

    // ---- 第一遍：解析产品 + 数量（报价补价要先有 productId / 产品原文） ----
    interface PreparedLine {
      line: DraftOrderLineDto;
      product: { id: number; filed: boolean; name: string | null };
      qtyOk: boolean;
      quantity: number;
      priceOk: boolean;
      unitPrice: number;
    }
    const prepared: PreparedLine[] = [];
    for (const line of dto.lines ?? []) {
      const product = await this.resolveDraftProduct(line.productId ?? null, line.productName ?? null);
      const qtyOk = line.quantity != null && String(line.quantity).trim() !== ''
        && Number.isFinite(Number(line.quantity)) && Number(line.quantity) > 0;
      const priceOk = line.unitPrice != null && String(line.unitPrice).trim() !== ''
        && Number.isFinite(Number(line.unitPrice)) && Number(line.unitPrice) >= 0;
      prepared.push({
        line,
        product,
        qtyOk,
        quantity: qtyOk ? Math.round(Number(line.quantity)) : 0,
        priceOk,
        unitPrice: priceOk ? Number(line.unitPrice) : 0,
      });
    }

    // ---- 第二遍：缺价的行走**同一条报价补价路径**（I17 甲方裁定④） ----
    // 口径：按「客户（优先真实档案 id，未建档时只能命中通用价）+ 该行产品（id 或产品名文本）」取价，
    // 命中 → 补价 + priceFrom='quote'（来源可追溯）；未命中 → 保持缺价待补，绝不编造价格。
    // 说明：识单通道（/ai/orders/parse）已经补过一次价，这里再补一次是为了让**任何**落草稿来源
    //（含 .doc 切片管线、批量脚本、直接调接口）都走同一条路径 —— 已有价格的行不会被覆盖。
    const targets = quoteFillTargets(
      customer.filed ? customer.id : null,
      prepared.map((p) => ({
        productId: p.product.filed ? p.product.id : null,
        productName: p.product.name ?? p.line.productName ?? null,
        hasPrice: p.priceOk,
      })),
    );
    let fills: Array<DraftQuoteFill | null> = new Array(prepared.length).fill(null);
    if (targets.length) {
      try {
        const hits = await this.quotes.lookupMany(targets.map((t) => t.query));
        fills = resolveQuoteFills(prepared.length, targets, hits);
      } catch (e) {
        // 取价异常不阻断落草稿：如实告警，该行保持缺价待补
        this.logger.warn('落草稿补价失败（按缺价处理）：' + (e as Error).message);
      }
    }

    // ---- 第三遍：装配行 + 标待补 ----
    const values: Array<Omit<NewOrderLine, 'orderId'>> = [];
    const linePendings: PendingItem[][] = [];
    prepared.forEach((p, i) => {
      const { line, product } = p;
      const hit = fills[i];
      const quantity = p.quantity;
      const priceOk = p.priceOk || !!hit;
      const unitPrice = p.priceOk ? p.unitPrice : (hit ? fromCents(hit.unitPriceCents) : 0);
      const priceFrom = priceOk && (!!hit || line.priceFrom === 'quote') ? ('quote' as const) : null;
      const pending = computeLinePending({
        productId: product.filed ? product.id : null,
        productName: product.name,
        quantity: p.qtyOk ? quantity : null,
        unitPrice: priceOk ? unitPrice : null,
        priceFrom,
      });
      linePendings.push(pending);
      values.push({
        productId: product.id,
        quantity,
        unitPrice,
        currency: normalizeCurrency(line.currency),
        engraving: line.engraving ?? null,
        packaging: line.packaging ?? null,
        pendingItems: pending.length ? pending : null,
        priceSource: priceFrom,
        productNameText: product.filed ? null : (product.name ?? line.productName ?? null),
      });
    });

    const orderPending = computeOrderPending({
      customerId: customer.filed ? customer.id : null,
      customerName: customer.name,
      dueDate: due.tbd ? null : due.date,
    }, linePendings);

    const now = new Date();
    const orderNo = await this.nextOrderNo(now);
    const created = await db.transaction(async (tx) => {
      const [order] = await tx.insert(orders).values({
        orderNo,
        customerId: customer.id,
        poNo: dto.poNo ? String(dto.poNo) : null,
        dueDate: new Date(due.tbd ? ORDERS_DUE_DATE_TBD : (due.date as string)),
        dueDateTbd: due.tbd,
        draftCustomerName: customer.filed ? null : (customer.name ?? '(未提供客户名)'),
        pendingItems: orderPending,
        note: dto.note ? String(dto.note) : null,
        status: 'draft',
        operatorId: currentOperatorId(),
      }).returning();
      if (values.length) await tx.insert(orderLines).values(values.map((v) => ({ ...v, orderId: order.id })));
      return order;
    });
    return this.findOne(created.id);
  }

  /**
   * 一键从报价记录补价（I17）：对**所有标了「缺单价」的行**按报价规则取价，
   * 命中则写回单价 + priceSource='quote'（来源可追溯）并清掉该行的缺价标记；未命中保持待补。
   */
  async fillQuotePrices(orderId: number) {
    const order = await this.requireDraft(orderId);
    const rows = await db
      .select({ line: orderLines, productName: products.name })
      .from(orderLines)
      .leftJoin(products, eq(orderLines.productId, products.id))
      .where(eq(orderLines.orderId, orderId))
      .orderBy(orderLines.id);
    const pendingProductId = await findPendingProductId();
    const targets = rows.filter((r) => (r.line.pendingItems ?? []).some((x) => x.code === PENDING_CODES.PRICE_MISSING));
    const label = (r: typeof rows[number]) => r.line.productNameText ?? r.productName ?? ('产品#' + r.line.productId);
    if (!targets.length) {
      return { order: await this.findOne(orderId), filled: [], missed: [], message: '该订单没有「缺单价」的行，无需补价' };
    }
    const hits = await this.quotes.lookupMany(targets.map((r) => ({
      customerId: order.customerId,
      productId: r.line.productId === pendingProductId ? null : r.line.productId,
      productName: r.line.productNameText ?? r.productName ?? null,
    })));

    const filled: Array<{ lineId: number; productName: string; unitPrice: number; quoteId: number; ruleText: string; message: string }> = [];
    const missed: Array<{ lineId: number; productName: string; message: string }> = [];
    await db.transaction(async (tx) => {
      for (let i = 0; i < targets.length; i++) {
        const r = targets[i];
        const h = hits[i];
        const name = label(r);
        if (!h) {
          missed.push({ lineId: r.line.id, productName: name, message: '未命中有效报价（客户+产品 / 客户+产品名文本 / 通用价 都无有效记录），仍标待补' });
          continue;
        }
        const price = fromCents(h.unitPriceCents);
        const remain = (r.line.pendingItems ?? []).filter((x) => x.code !== PENDING_CODES.PRICE_MISSING);
        await tx.update(orderLines).set({
          unitPrice: price,
          // 币种同步取报价的币种（归一后）：避免「人民币行 + 美元价」这类跨币种混价
          currency: normalizeCurrency(h.currency),
          priceSource: 'quote',
          pendingItems: remain.length ? remain : null,
        }).where(eq(orderLines.id, r.line.id));
        filled.push({ lineId: r.line.id, productName: name, unitPrice: price, quoteId: h.quoteId, ruleText: h.ruleText, message: describeHit(h) });
      }
      await this.recomputeOrderPending(tx, orderId);
    });
    return {
      order: await this.findOne(orderId),
      filled,
      missed,
      message: '补价完成：命中 ' + filled.length + ' 行，未命中 ' + missed.length + ' 行'
        + (missed.length ? '（未命中行仍标待补，可先录入报价记录后重试）' : ''),
    };
  }

  /** 单头待补重算（编辑/补价后调用）：读库内最新行状态 → 覆盖 orders.pending_items */
  private async recomputeOrderPending(tx: Tx, orderId: number): Promise<PendingItem[]> {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId));
    if (!o) return [];
    const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId));
    const pendingCustomerId = await findPendingCustomerId();
    const pendingProductId = await findPendingProductId();
    const linePendings = lines.map((l: { pendingItems?: PendingItem[] | null; productId: number }) => {
      const own = Array.isArray(l.pendingItems) ? l.pendingItems : [];
      // 行上没标待补、但产品仍指着占位档案 → 补一条（防人工直接改库造成漏标）
      return l.productId === pendingProductId && !own.some((x) => x.code === PENDING_CODES.PRODUCT_NOT_FILED)
        ? [...own, ...computeLinePending({ productId: null, productName: null })]
        : own;
    });
    const items = computeOrderPending({
      customerId: o.customerId === pendingCustomerId ? null : o.customerId,
      customerName: o.draftCustomerName ?? null,
      dueDate: o.dueDateTbd ? null : ymdDash(new Date(o.dueDate)),
    }, linePendings);
    await tx.update(orders).set({
      pendingItems: items,
      draftCustomerName: o.customerId === pendingCustomerId ? (o.draftCustomerName ?? null) : null,
      updatedAt: new Date(),
    }).where(eq(orders.id, orderId));
    return items;
  }

  /** 落草稿时确定客户：命中档案用真实档案；未命中 → 占位客户 + 待补（不臆造客户、不合并别名） */
  private async resolveDraftCustomer(customerId: number | null, nameRaw: string | null) {
    if (customerId != null) {
      const [c] = await db.select().from(customers).where(eq(customers.id, Number(customerId)));
      if (!c) throw new BadRequestException('客户 #' + customerId + ' 不存在');
      return { id: c.id, filed: true, name: c.name };
    }
    const name = (nameRaw ?? '').trim();
    if (name) {
      const all = await db.select({ id: customers.id, name: customers.name }).from(customers);
      const exact = all.find((c) => c.name.trim() === name);
      if (exact) return { id: exact.id, filed: true, name: exact.name };
      const nn = normName(name);
      const cands = all.filter((c) => nn && (nn.includes(normName(c.name)) || normName(c.name).includes(nn)));
      if (cands.length === 1) return { id: cands[0].id, filed: true, name: cands[0].name };
      if (cands.length > 1) {
        throw new BadRequestException('客户「' + name + '」匹配到多个档案（' + cands.map((c) => c.name).join('、') + '），请先指定 customerId 再落草稿');
      }
    }
    return { id: await ensurePendingCustomer(), filed: false, name: name || null };
  }

  /** 落草稿时确定产品：命中目录用真实产品；未命中/多候选 → 占位产品 + 行级待补 */
  private async resolveDraftProduct(productId: number | null, nameRaw: string | null) {
    if (productId != null) {
      const [p] = await db.select().from(products).where(eq(products.id, Number(productId)));
      if (!p) throw new BadRequestException('产品 #' + productId + ' 不存在');
      return { id: p.id, filed: true, name: p.name };
    }
    const name = (nameRaw ?? '').trim();
    if (name) {
      const all = await db.select({ id: products.id, name: products.name }).from(products);
      // 与识单同一套候选口径（ai/product-model.ts）：名称完全相同 → **基础型号+size 相同** → 子串容错（带数字守卫）。
      // 「基础型号 + size」必须逐字符一致，否则「1-101」会错落到「1-101 割嘴 00#」（不同尺寸各自建档，价格/工艺都错）。
      const found = findProductCandidates(name, all, { sameDigits: sameProductDigits, normName });
      const pick = found.kind === 'exact' && found.hits.length ? found.hits[0] : (found.hits.length === 1 ? found.hits[0] : null);
      if (pick) return { id: pick.id, filed: true, name: pick.name };
    }
    return { id: await ensurePendingProduct(), filed: false, name: name || null };
  }

  /** 交期归一：给不出合法 YYYY-MM-DD 就返回「待定」（哨兵日由调用方写入） */
  private resolveDraftDueDate(dueDate: string | null): { date: string | null; tbd: boolean } {
    const s = (dueDate ?? '').trim();
    if (s) {
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) {
        const d = new Date(s.length > 10 ? s : s + 'T00:00:00Z');
        if (!Number.isNaN(d.getTime())) return { date: m[1] + '-' + m[2] + '-' + m[3], tbd: false };
      }
      const d2 = new Date(s);
      if (!Number.isNaN(d2.getTime())) return { date: ymdDash(d2), tbd: false };
    }
    return { date: null, tbd: true };
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
    // 已开票金额实时聚合（不落冗余字段）：与发票统计同一口径（只计未作废、按含税分）
    const invoicedMap = await this.invoices.invoicedCentsByOrder(orderIds);
    return rows.map(({ order, customerName, operatorName }) => {
      const ordLines = byOrder.get(order.id) ?? [];
      // 订单金额按「分」定点求和（数量×分单价，整数域），替代原 binary64 逐行累加
      const totalCents = sumLineCents(ordLines.map((l) => ({ quantity: l.quantity, unitPrice: Number(l.unitPrice) })));
      const invoicedCents = invoicedMap.get(order.id) ?? 0;
      return {
        ...order,
        customerName,
        operatorName: operatorName ?? null,
        // I17：单头待补项的中文汇总（列表「待补」列直接展示；空串 = 无待补）
        pendingText: pendingText(order.pendingItems),
        totalAmount: fromCents(totalCents),
        totalAmountCents: totalCents,
        invoicedCents,
        uninvoicedCents: Math.max(0, totalCents - invoicedCents),
        overInvoiced: invoicedCents > totalCents,
        // 简化交互的三态开票状态：none 未开票 / partial 部分开票 / done 已开完（按「分」整数比较）
        invoiceState: orderInvoiceState(totalCents, invoicedCents),
        lines: ordLines,
      };
    });
  }
}
