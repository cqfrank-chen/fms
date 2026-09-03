import { integer, pgEnum, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

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
