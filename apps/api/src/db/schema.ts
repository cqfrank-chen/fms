import { integer, jsonb, numeric, pgEnum, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

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
});

/** 客户档案（Customer）：订单与应收归集主体 */
export const customers = pgTable('customers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  contact: text('contact'), // 联系人
  settlement: settlementEnum('settlement'), // 结算方式
  creditDays: integer('credit_days').default(0).notNull(), // 账期天数（账龄到期日=出库日+账期）
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** 供应商档案（Supplier）：与客户同构，来料与应付归集主体 */
export const suppliers = pgTable('suppliers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  contact: text('contact'),
  settlement: settlementEnum('settlement'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** 操作人（Operator）：固定名单，免登录留痕用 */
export const operators = pgTable('operators', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(), // 姓名
  boundPc: text('bound_pc'), // 绑定 PC（如：办公室1号机；空=机动）
  note: text('note'), // 备注（如：订单录入/计划单审核）
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
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
