import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

/** 技术验证演示实体（I01）：最小 CRUD 的载体 */
export const testProducts = pgTable('test_products', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  sku: text('sku').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type TestProduct = typeof testProducts.$inferSelect;
export type NewTestProduct = typeof testProducts.$inferInsert;
