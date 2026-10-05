import { eq } from 'drizzle-orm';
import { db } from '../db';
import { customers, PENDING_CUSTOMER_NAME, PENDING_PRODUCT_NAME, products } from '../db/schema';

/**
 * 占位档案（「（未建档客户·待补）」/「（未建档产品·待补）」）的查找与**保证存在**
 * ------------------------------------------------------------------
 * 背景：占位档案平时是**惰性创建**的 —— 只有真的落了「客户/产品未建档」的草稿才会出现。
 *
 * 甲方裁定 2（2026-10-05）要求：客户/产品的**选择下拉始终显示两个占位档案**（不受「显示占位档案」
 * 开关影响），目的是让人工把订单/行**改指**到正确的客户或产品，或**保留占位**以维持待补状态。
 * 因为下拉要能选到占位档案，**选项接口**（GET /customers、GET /products 带 includePlaceholders=1）
 * 在放行的同时调用这里的 ensure*，保证这两行一定存在（幂等：已存在则直接返回 id，不重复插入）。
 *
 * 说明：本模块是 orders.service（落草稿惰性创建）与 customers/products（选项接口保证存在）
 * 的**同一份实现**，避免两处规则漂移。
 */

/** 占位客户 id（不存在返回 null） */
export async function findPendingCustomerId(): Promise<number | null> {
  const [hit] = await db.select({ id: customers.id }).from(customers).where(eq(customers.name, PENDING_CUSTOMER_NAME));
  return hit?.id ?? null;
}

/** 占位产品 id（不存在返回 null） */
export async function findPendingProductId(): Promise<number | null> {
  const [hit] = await db.select({ id: products.id }).from(products).where(eq(products.name, PENDING_PRODUCT_NAME));
  return hit?.id ?? null;
}

/** 占位客户：**保证存在**（不存在则惰性创建），名字显式标注「待补」 */
export async function ensurePendingCustomer(): Promise<number> {
  const hit = await findPendingCustomerId();
  if (hit != null) return hit;
  const [row] = await db.insert(customers).values({ name: PENDING_CUSTOMER_NAME, creditDays: 0 }).returning({ id: customers.id });
  return row.id;
}

/**
 * 占位产品：**保证存在**（不存在则惰性创建）。
 * I17 甲方裁定③：类型字段用**中立值 'tbd'（待定）**，不借用业务类型。
 * 该产品**永远不能进入生产**：引用它的订单一定带「产品未建档」待补项，确认订单会被拦截
 * （见 plan-sheets.service）；已有占位产品数据由 db/migrate.ts 的幂等数据修正统一刷成 'tbd'。
 */
export async function ensurePendingProduct(): Promise<number> {
  const hit = await findPendingProductId();
  if (hit != null) return hit;
  const [row] = await db.insert(products).values({ name: PENDING_PRODUCT_NAME, type: 'tbd', safetyStock: 0 }).returning({ id: products.id });
  return row.id;
}
