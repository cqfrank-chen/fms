import { boolean, date, integer, jsonb, numeric, pgEnum, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/** 技术验证演示实体（I01）：最小 CRUD 的载体，订单线完成后下线 */
export const testProducts = pgTable('test_products', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  sku: text('sku').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ============================================================
// 主数据（I03，spec §3）——术语对齐 CONTEXT.md
// 单厂单租户：不建多厂表，模型以本表为基（多厂扩展路径见 spec §13）
// ============================================================

/** 产品类型（四种）：英式乙炔/英式丙烷/美式乙炔/美式丙烷 */
export const PRODUCT_TYPES = [
  'uk_acetylene', // 英式乙炔（ANM 系）
  'uk_propane', //   英式丙烷（PNM 系）
  'us_acetylene', // 美式乙炔（6290 系）
  'us_propane', //   美式丙烷（101 系）
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];
export const productTypeEnum = pgEnum('product_type', PRODUCT_TYPES);

/** 结算方式（客户/供应商共用词表，可自由扩展） */
export const SETTLEMENTS = [
  'deposit_30_balance_before_ship', // 30%定金+70%发货前
  'monthly_30', //  月结30天
  'monthly_60', //  月结60天
  'before_ship', // 发货前付清
  'prepay_30', //   预付30%（供应商侧）
  'monthly', //     月结（供应商侧）
  'cash', //        现结
] as const;
export type Settlement = (typeof SETTLEMENTS)[number];
export const settlementEnum = pgEnum('settlement', SETTLEMENTS);

/** 产品目录（Product Catalog）：订单与计划单产品信息唯一来源 */
export const products = pgTable('products', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(), // 产品名，如 ANM 1/32" 乙炔
  type: productTypeEnum('type').notNull(), // 英式/美式 × 乙炔/丙烷
  defaultPackaging: text('default_packaging'), // 默认包装描述（如：包装盒×50+纸箱）
  defaultRouting: text('default_routing'), // 默认工序路线文本（结构化工序主数据后续票补）
  safetyStock: integer('safety_stock').default(0).notNull(), // 安全库存（低于标红）
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(), // 最后修改时间
});

/** 客户档案（Customer）：订单与应收归集主体 */
export const customers = pgTable('customers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  contact: text('contact'), // 联系人
  settlement: settlementEnum('settlement'), // 结算方式
  creditDays: integer('credit_days').default(0).notNull(), // 账期天数（账龄到期日=出库日+账期）
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(), // 最后修改时间
});

/** 供应商档案（Supplier）：与客户同构，来料与应付归集主体 */
export const suppliers = pgTable('suppliers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  contact: text('contact'),
  settlement: settlementEnum('settlement'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(), // 最后修改时间
});

/** 操作人（Operator）：固定名单，免登录留痕用 */
export const operators = pgTable('operators', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(), // 姓名
  boundPc: text('bound_pc'), // 绑定 PC（如：办公室1号机；空=机动）
  note: text('note'), // 备注（如：订单录入/计划单审核）
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(), // 最后修改时间
});

export type TestProduct = typeof testProducts.$inferSelect;
export type NewTestProduct = typeof testProducts.$inferInsert;

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type Supplier = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;
export type Operator = typeof operators.$inferSelect;
export type NewOperator = typeof operators.$inferInsert;

// ============================================================
// 订单域（I04 起，spec §4）——术语对齐 CONTEXT.md
// ============================================================

/** 订单/计划单五态（票 03）：草稿 → 已确认 → 生产中 → 已完成/已取消(作废) */
export const STATUSES = ['draft', 'confirmed', 'production', 'completed', 'cancelled'] as const;
export type OrderStatus = (typeof STATUSES)[number];
export const orderStatusEnum = pgEnum('order_status', STATUSES);

/** 币种（一期单币种 RMB 记账，字段保留出海预留） */
export const CURRENCIES = ['RMB', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];
export const currencyEnum = pgEnum('currency', CURRENCIES);

/** 包装要求类型（复合勾选，值=规格/数量描述） */
export const PACK_TYPES = ['box', 'bag', 'carton', 'label'] as const;
export type PackType = (typeof PACK_TYPES)[number];
/** 包装要求快照：{ box?: '包装盒×50', carton?: '纸箱×4盒', ... } */
export type PackagingSpec = Partial<Record<PackType, string>>;

/** 订单（Order）：客户下达的生产需求单据 */
export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  orderNo: text('order_no').notNull().unique(), // 订单号（自动生成 SO-YYYYMMDD-NN）
  customerId: integer('customer_id')
    .notNull()
    .references(() => customers.id), // 客户档案
  poNo: text('po_no'), // 客户 PO 号
  dueDate: timestamp('due_date', { withTimezone: true }).notNull(), // 交期
  note: text('note'), // 备注
  status: orderStatusEnum('status').default('draft').notNull(), // 五态
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(), // 最后修改时间（状态流转/编辑刷新）
});

/** 订单行（Order Line）：一单多产品 */
export const orderLines = pgTable('order_lines', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  productId: integer('product_id')
    .notNull()
    .references(() => products.id), // 产品目录引用
  quantity: integer('quantity').notNull(), // 数量
  unitPrice: numeric('unit_price', { precision: 10, scale: 2, mode: 'number' }).notNull(), // 单价
  currency: currencyEnum('currency').default('RMB').notNull(), // 币种（出海预留）
  engraving: text('engraving'), // 刻字需求
  packaging: jsonb('packaging').$type<PackagingSpec>(), // 包装要求（复合，JSONB）
});

/** 包装模板库：整行包装要求保存/复用 + 样式图（I04） */
export const packTemplates = pgTable('pack_templates', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(), // 模板名，如 Weldclass 定制盒
  pack: jsonb('pack').$type<PackagingSpec>().notNull(), // 包装要求快照（可复合多选）
  note: text('note'), // 规格说明
  imageUrl: text('image_url'), // 样式图（上传路径，I12 前可空）
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderLine = typeof orderLines.$inferSelect;
export type NewOrderLine = typeof orderLines.$inferInsert;
export type PackTemplate = typeof packTemplates.$inferSelect;
export type NewPackTemplate = typeof packTemplates.$inferInsert;

/** 计划单五态（票 03）：草稿 → 已确认 → 生产中 → 已完成 / 已作废 */
export const planStatusEnum = pgEnum('plan_status', [
  'draft',
  'confirmed',
  'production',
  'completed',
  'voided',
]);
export type PlanStatus = (typeof planStatusEnum.enumValues)[number];

/** 计划单（Plan Sheet）：一单一计划单，从订单整单生成（I05） */
export const planSheets = pgTable('plan_sheets', {
  id: serial('id').primaryKey(),
  planNo: text('plan_no').notNull().unique(), // 计划单号（自动生成 PS-YYYYMMDD-NN）
  orderId: integer('order_id')
    .notNull()
    .references(() => orders.id), // 来源订单（一单一计划单）
  status: planStatusEnum('status').default('draft').notNull(), // 五态
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(), // 最后修改时间（审核/驳回/报工刷新）
});

/** 计划单行（Plan Sheet Line）：产品/计划数量/包装/刻字/完成数量 */
export const planSheetLines = pgTable('plan_sheet_lines', {
  id: serial('id').primaryKey(),
  planSheetId: integer('plan_sheet_id')
    .notNull()
    .references(() => planSheets.id, { onDelete: 'cascade' }),
  orderLineId: integer('order_line_id')
    .notNull()
    .references(() => orderLines.id), // 来源订单行（反查/变更联动锚点）
  productId: integer('product_id')
    .notNull()
    .references(() => products.id),
  quantity: integer('quantity').notNull(), // 计划数量（=订单行数量）
  completedQuantity: integer('completed_quantity').default(0).notNull(), // 成品完成数（末道工序报工累计；无路由产品=直接成品口径）
  // 工序推进（I06 整批逐道）：当前工序序号（1-based），随报工推进 +1；产品无工序路由时忽略（成品直报）
  routeSeq: integer('route_seq').default(1).notNull(),
  engraving: text('engraving'), // 刻字（快照自订单行）
  packaging: jsonb('packaging').$type<PackagingSpec>(), // 包装要求快照
  // 排期域（I11）——独立排期状态字段，不进五态
  wcKey: text('wc_key'), // 排入泳道（工序产能池 key，随报工推进换下一道泳道）；null=未排期
  startDate: date('start_date'), // 排期开始日 YYYY-MM-DD；null=未排期
  coverDays: integer('cover_days'), // 工期覆盖（天）；null=按产品×工序单件耗时自动推算
});

export type PlanSheet = typeof planSheets.$inferSelect;
export type NewPlanSheet = typeof planSheets.$inferInsert;
export type PlanSheetLine = typeof planSheetLines.$inferSelect;
export type NewPlanSheetLine = typeof planSheetLines.$inferInsert;

// ============================================================
// 排期主数据（I11，spec §5 / research/04-process-data.md）
// 工作中心（6 泳道）→ 工序字典（13 道种子）→ 产品×工序路线（运行期前端填写耗时）
// ============================================================

/** 工作中心（工序产能池）：设备数=可并行台数；key 即甘特图横排泳道键 */
export const workCenters = pgTable('work_centers', {
  key: text('key').primaryKey(), // 主键即泳道键（如 'cut'/'turn'/'drill'/'thread'/'finish'/'pack'）
  name: text('name').notNull(), // 中文名（泳道标题）
  machines: integer('machines').default(1).notNull(), // 可并行设备数
  sortOrder: integer('sort_order').default(0).notNull(), // 看板纵轴顺序
});

/** 工序字典（13 道种子） */
export const processes = pgTable('processes', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(), // 工序编码（'cut'/'turn'/'drill_c'/'drill_p'/'thread'/'mill'/'braze'/'ream'/'polish'/'wash'/'test'/'pack'/'iqc'）
  name: text('name').notNull(), // 工序中文名
  wcKey: text('wc_key').notNull().references(() => workCenters.key), // 所属泳道
  sortOrder: integer('sort_order').default(0).notNull(), // 字典顺序
});

/** 产品×工序路线（运行期前端配置）：含单件耗时（秒）与换型时间（分钟） */
export const productProcesses = pgTable(
  'product_processes',
  {
    productId: integer('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    processId: integer('process_id').notNull().references(() => processes.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(), // 该产品工序顺序（从 1 起）
    unitSeconds: numeric('unit_seconds', { precision: 8, scale: 2 }), // 单件耗时（秒）；null 表示未填
    changeoverMinutes: integer('changeover_minutes').default(0).notNull(), // 换型时间（分钟）
  },
  (t) => ({
    pk: uniqueIndex('product_processes_pk').on(t.productId, t.processId),
  }),
);

export type WorkCenter = typeof workCenters.$inferSelect;
export type Process = typeof processes.$inferSelect;
export type ProductProcess = typeof productProcesses.$inferSelect;

// ============================================================
// 仓储（I06 报工触发入库草稿；I08 完整：确认入账/库存/出库/来料/盘点/冲销）
// ============================================================

/** 入库单三态：草稿（报工自动触发）→ 已确认（仓管入账）→ 已冲销（纠错抵销） */
export const receiptStatusEnum = pgEnum('receipt_status', ['draft', 'confirmed', 'voided']);

/** 入库单（Goods Receipt）：报工触发草稿（预填产品/数量/批次）→ 仓管确认 → 库存+（I08） */
export const goodsReceipts = pgTable('goods_receipts', {
  id: serial('id').primaryKey(),
  receiptNo: text('receipt_no').notNull().unique(), // 入库单号（自动生成 GR-YYYYMMDD-NN）
  planSheetId: integer('plan_sheet_id')
    .references(() => planSheets.id), // 来源计划单（报工累计入同一张）；空=手动无单入库（备货/打样/返工回仓）
  batchNo: text('batch_no').notNull(), // 成品批次 FG-YYYYMMDD-NN（一计划单一批次，首报日定号）
  status: receiptStatusEnum('status').default('draft').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(), // 最后修改时间
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }), // 仓管确认时间（I08）
});

/** 入库单行：产品×数量，锚定计划单行（反查） */
export const goodsReceiptLines = pgTable('goods_receipt_lines', {
  id: serial('id').primaryKey(),
  receiptId: integer('receipt_id')
    .notNull()
    .references(() => goodsReceipts.id, { onDelete: 'cascade' }),
  planSheetLineId: integer('plan_sheet_line_id')
    .references(() => planSheetLines.id), // 空=手动无单入库行
  productId: integer('product_id')
    .notNull()
    .references(() => products.id),
  quantity: integer('quantity').notNull(), // 入库数量（多次报工在同一草稿行累计）
});

export type GoodsReceipt = typeof goodsReceipts.$inferSelect;
export type NewGoodsReceipt = typeof goodsReceipts.$inferInsert;
export type GoodsReceiptLine = typeof goodsReceiptLines.$inferSelect;
export type NewGoodsReceiptLine = typeof goodsReceiptLines.$inferInsert;

/** 成品库存（SKU×批次）：只管成品；允许负库存；安全库存标红预警在前端 */
export const inventory = pgTable('inventory', {
  id: serial('id').primaryKey(),
  productId: integer('product_id')
    .notNull()
    .references(() => products.id),
  batchNo: text('batch_no').notNull(), // 成品批次 FG-YYYYMMDD-NN
  quantity: integer('quantity').default(0).notNull(), // 当前库存（可为负）
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('inventory_product_batch_uq').on(t.productId, t.batchNo)]);

/** OQC 判定：待检/合格放行/免检 */
export const oqcStatusEnum = pgEnum('oqc_status', ['pending', 'passed', 'exempt']);
/** 出库单状态：草稿 → 待检（已提交，正常单）→ 已出库（OQC 放行/免检直出）→ 已冲销 */
export const outboundStatusEnum = pgEnum('outbound_status', ['draft', 'pending', 'shipped', 'voided']);

/** 出库单：挂订单、可分批（行引用订单行）、OQC 先检后出；确认后扣库存 + 自动生成应收（I09 消费） */
export const outbounds = pgTable('outbounds', {
  id: serial('id').primaryKey(),
  shipNo: text('ship_no').notNull().unique(), // 出库单号 OUT-YYYYMMDD-NN
  orderId: integer('order_id')
    .notNull()
    .references(() => orders.id), // 挂订单（发货对象）
  oqc: oqcStatusEnum('oqc').notNull(), // 本单 OQC 模式：exempt 免检直出 / 其余走待检
  status: outboundStatusEnum('status').default('draft').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(), // 最后修改时间
  shippedAt: timestamp('shipped_at', { withTimezone: true }),
});

/** 出库单行：引用订单行 × 本批发货数量（≤ 订单行剩余），包装快照 */
export const outboundLines = pgTable('outbound_lines', {
  id: serial('id').primaryKey(),
  outboundId: integer('outbound_id')
    .notNull()
    .references(() => outbounds.id, { onDelete: 'cascade' }),
  orderLineId: integer('order_line_id')
    .notNull()
    .references(() => orderLines.id),
  productId: integer('product_id')
    .notNull()
    .references(() => products.id),
  quantity: integer('quantity').notNull(),
  packaging: jsonb('packaging').$type<PackagingSpec>(), // 包装要求快照（自订单行）
});

/** 来料检验状态（IQC 预留，一期线下纸质） */
export const iqcStatusEnum = pgEnum('iqc_status', ['pending', 'passed']);

/** 来料登记单（超轻量）：不维护库存；带金额自动生成应付 */
export const incomingGoods = pgTable('incoming_goods', {
  id: serial('id').primaryKey(),
  incomingNo: text('incoming_no').notNull().unique(), // 登记单号 IN-YYYYMMDD-NN
  supplierId: integer('supplier_id')
    .notNull()
    .references(() => suppliers.id),
  materialName: text('material_name').notNull(), // 物料名（如 黄铜棒 φ20）
  quantity: integer('quantity').notNull(),
  amount: numeric('amount', { precision: 10, scale: 2, mode: 'number' }).notNull(), // 金额（元）
  batchNo: text('batch_no'), // 供应商批次（追溯）
  iqcStatus: iqcStatusEnum('iqc_status').default('pending').notNull(), // IQC 预留
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(), // 最后修改时间
});

/** 盘点单：账面→实盘→差异；确认后校准库存（盘盈/盘亏调整，全程留痕） */
export const stocktakes = pgTable('stocktakes', {
  id: serial('id').primaryKey(),
  stocktakeNo: text('stocktake_no').notNull().unique(), // ST-YYYYMMDD-NN
  productId: integer('product_id')
    .notNull()
    .references(() => products.id),
  batchNo: text('batch_no').notNull(),
  bookQty: integer('book_qty').notNull(), // 账面数（建档时库存快照）
  actualQty: integer('actual_qty').notNull(), // 实盘数
  diffQty: integer('diff_qty').notNull(), // 差异（实盘-账面）
  status: receiptStatusEnum('status').default('draft').notNull(), // 复用：草稿→已确认（校准）→已冲销
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(), // 最后修改时间
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
});

// ============================================================
// 账目事件落点（I08 事件写入；I09 界面/核销/对账）
// ============================================================

/** 应收（出库自动生成；金额按订单币种记录） */
export const receivables = pgTable('receivables', {
  id: serial('id').primaryKey(),
  recvNo: text('recv_no').notNull().unique(), // 应收号 REC-YYYYMMDD-NN
  customerId: integer('customer_id')
    .notNull()
    .references(() => customers.id),
  sourceType: text('source_type').notNull(), // 'outbound'（本期仅出库）
  sourceId: integer('source_id').notNull(), // 来源出库单 id
  amount: numeric('amount', { precision: 10, scale: 2, mode: 'number' }).notNull(),
  currency: text('currency').default('RMB').notNull(), // 订单币种快照
  settledAmount: numeric('settled_amount', { precision: 10, scale: 2, mode: 'number' }).default(0).notNull(), // 已核销（I09）
  status: receiptStatusEnum('status').default('draft').notNull(), // 复用三态：开立→(核销完 I09)→冲销
  dueDate: timestamp('due_date', { withTimezone: true }), // 到期（客户账期计算，I09 对账）
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(), // 最后修改时间
});

/** 应付（来料登记自动生成） */
export const payables = pgTable('payables', {
  id: serial('id').primaryKey(),
  payNo: text('pay_no').notNull().unique(), // 应付号 PAY-YYYYMMDD-NN
  supplierId: integer('supplier_id')
    .notNull()
    .references(() => suppliers.id),
  sourceType: text('source_type').notNull(), // 'incoming'
  sourceId: integer('source_id').notNull(),
  amount: numeric('amount', { precision: 10, scale: 2, mode: 'number' }).notNull(),
  settledAmount: numeric('settled_amount', { precision: 10, scale: 2, mode: 'number' }).default(0).notNull(), // I09
  status: receiptStatusEnum('status').default('draft').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(), // 最后修改时间
});

export type Inventory = typeof inventory.$inferSelect;
export type NewInventory = typeof inventory.$inferInsert;
export type Outbound = typeof outbounds.$inferSelect;
export type NewOutbound = typeof outbounds.$inferInsert;
export type OutboundLine = typeof outboundLines.$inferSelect;
export type NewOutboundLine = typeof outboundLines.$inferInsert;
export type IncomingGoods = typeof incomingGoods.$inferSelect;
export type NewIncomingGoods = typeof incomingGoods.$inferInsert;
export type Stocktake = typeof stocktakes.$inferSelect;
export type NewStocktake = typeof stocktakes.$inferInsert;
export type Receivable = typeof receivables.$inferSelect;
export type NewReceivable = typeof receivables.$inferInsert;
export type Payable = typeof payables.$inferSelect;
export type NewPayable = typeof payables.$inferInsert;

// ============================================================
// 账目单据（I09）：收款/付款单一步生效（核销+预收/预付双模式）+ 月度成本
// ============================================================

/** 收付款单状态：一步生效 → 冲销纠错（无草稿态） */
export const slipStatusEnum = pgEnum('slip_status', ['confirmed', 'voided']);
/** 收付款模式：核销（冲抵应收/应付） / 预收预付（挂余额，后续出库/来料再核销） */
export const slipModeEnum = pgEnum('slip_mode', ['settle', 'prepay']);

/** 收款单：核销 + 预收双模式；营收=收款核销（现金收付制） */
export const collectionSlips = pgTable('collection_slips', {
  id: serial('id').primaryKey(),
  collectNo: text('collect_no').notNull().unique(), // CO-YYYYMMDD-NN
  customerId: integer('customer_id')
    .notNull()
    .references(() => customers.id),
  mode: slipModeEnum('mode').notNull(), // settle 核销应收 / prepay 预收（挂客户贷方余额）
  amount: numeric('amount', { precision: 10, scale: 2, mode: 'number' }).notNull(),
  status: slipStatusEnum('status').default('confirmed').notNull(), // 一步生效
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(), // 最后修改时间
  voidedAt: timestamp('voided_at', { withTimezone: true }),
});

/** 收款核销明细：收款单 → 应收（支持一张收款单核销多笔应收 / 部分核销） */
export const collectionSlipLines = pgTable('collection_slip_lines', {
  id: serial('id').primaryKey(),
  slipId: integer('slip_id')
    .notNull()
    .references(() => collectionSlips.id, { onDelete: 'cascade' }),
  receivableId: integer('receivable_id')
    .notNull()
    .references(() => receivables.id),
  amount: numeric('amount', { precision: 10, scale: 2, mode: 'number' }).notNull(),
});

/** 付款单（与收款单同构）：核销 + 预付双模式 */
export const paymentSlips = pgTable('payment_slips', {
  id: serial('id').primaryKey(),
  payNo: text('pay_no').notNull().unique(), // PM-YYYYMMDD-NN
  supplierId: integer('supplier_id')
    .notNull()
    .references(() => suppliers.id),
  mode: slipModeEnum('mode').notNull(),
  amount: numeric('amount', { precision: 10, scale: 2, mode: 'number' }).notNull(),
  status: slipStatusEnum('status').default('confirmed').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(), // 最后修改时间
  voidedAt: timestamp('voided_at', { withTimezone: true }),
});

/** 付款核销明细 */
export const paymentSlipLines = pgTable('payment_slip_lines', {
  id: serial('id').primaryKey(),
  slipId: integer('slip_id')
    .notNull()
    .references(() => paymentSlips.id, { onDelete: 'cascade' }),
  payableId: integer('payable_id')
    .notNull()
    .references(() => payables.id),
  amount: numeric('amount', { precision: 10, scale: 2, mode: 'number' }).notNull(),
});

/** 月度成本固定六类（材料自动从来料汇总，不在此手填） */
export const costCategoryEnum = pgEnum('cost_category', [
  'labor', // 人工
  'electricity', // 电费
  'gas', // 燃气
  'rent', // 房租
  'depreciation', // 折旧
  'other', // 其他
]);

/** 月度成本：每月每类一笔（unique month+category） */
export const monthlyCosts = pgTable('monthly_costs', {
  id: serial('id').primaryKey(),
  month: text('month').notNull(), // 'YYYY-MM'
  category: costCategoryEnum('category').notNull(),
  amount: numeric('amount', { precision: 10, scale: 2, mode: 'number' }).notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(), // 最后修改时间
}, (t) => [uniqueIndex('monthly_cost_month_cat_uq').on(t.month, t.category)]);

export type CollectionSlip = typeof collectionSlips.$inferSelect;
export type NewCollectionSlip = typeof collectionSlips.$inferInsert;
export type CollectionSlipLine = typeof collectionSlipLines.$inferSelect;
export type NewCollectionSlipLine = typeof collectionSlipLines.$inferInsert;
export type PaymentSlip = typeof paymentSlips.$inferSelect;
export type NewPaymentSlip = typeof paymentSlips.$inferInsert;
export type PaymentSlipLine = typeof paymentSlipLines.$inferSelect;
export type NewPaymentSlipLine = typeof paymentSlipLines.$inferInsert;
export type MonthlyCost = typeof monthlyCosts.$inferSelect;
export type NewMonthlyCost = typeof monthlyCosts.$inferInsert;

// ============================================================
// AI 学习闭环（I12，spec §8）——人工修正回流 few-shot + 校验规则
// 只存差异与原始快照；回流消费（示例库/规则热更新）由后续迭代挂接
// ============================================================

/** AI 解析反馈：一次「解析 → 人工确认」过程的学习样本 */
export const aiParseFeedback = pgTable('ai_parse_feedback', {
  id: serial('id').primaryKey(),
  source: text('source').notNull(), // 'text' | 'image' | 'manual'
  parsed: jsonb('parsed').$type<Record<string, unknown>>().notNull(), // AI 解析原始结果（人工确认前）
  corrected: jsonb('corrected').$type<Record<string, unknown>>(), // 人工确认稿（确认后）
  corrections: jsonb('corrections').$type<Array<Record<string, unknown>>>(), // 差异项描述（可解释）
  directPass: boolean('direct_pass').notNull().default(false), // 是否直通（免人工改动）
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type AiParseFeedback = typeof aiParseFeedback.$inferSelect;
export type NewAiParseFeedback = typeof aiParseFeedback.$inferInsert;

// ============================================================
// AI 导入草稿（I14）——解析→人工修正→确认建单中途的未提交草稿
// 单槽自动保存（id 恒为 1），刷新/误关弹窗/换机均可恢复，确认建单或显式放弃后清除
// ============================================================

export const aiParseDrafts = pgTable('ai_parse_drafts', {
  id: integer('id').primaryKey(), // 恒为 1：单槽草稿
  result: jsonb('result').$type<Record<string, unknown>>().notNull(), // AI 解析原始快照（恢复后重渲染 issues/直通/置信度）
  draft: jsonb('draft').$type<Record<string, unknown>>().notNull(), // 可编辑草稿（客户/PO/交期/备注/行修正）
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type AiParseDraft = typeof aiParseDrafts.$inferSelect;
export type NewAiParseDraft = typeof aiParseDrafts.$inferInsert;

// ============================================================
// 应用级设置（运行时可改，DB 优先于 .env）——AI 服务配置等
// 设置页写入后立即生效（网关每次请求读取）
// ============================================================

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type AppSetting = typeof appSettings.$inferSelect;
export type NewAppSetting = typeof appSettings.$inferInsert;
