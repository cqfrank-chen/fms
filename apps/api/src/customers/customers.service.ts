import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { customers, NewCustomer } from '../db/schema';
import { hidePlaceholders } from '../common/placeholders';

@Injectable()
export class CustomersService {
  /**
   * 客户列表。
   * I17：默认**隐藏占位档案**「（未建档客户·待补）」（甲方裁定）；includePlaceholders=1 时显示（排查用）。
   */
  async findAll(opts: { includePlaceholders?: string } = {}) {
    const rows = await db.select().from(customers).orderBy(customers.id);
    return hidePlaceholders(rows, opts.includePlaceholders);
  }

  async create(data: NewCustomer) {
    const [row] = await db.insert(customers).values(data).returning();
    return row;
  }

  async update(id: number, data: Partial<NewCustomer>) {
    const [row] = await db.update(customers).set({ ...data, updatedAt: new Date() }).where(eq(customers.id, id)).returning();
    return row;
  }

  async remove(id: number) {
    await db.delete(customers).where(eq(customers.id, id));
  }
}
