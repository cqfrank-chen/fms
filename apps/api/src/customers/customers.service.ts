import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { customers, NewCustomer } from '../db/schema';
import { hidePlaceholders, includePlaceholders } from '../common/placeholders';
import { ensurePendingCustomer } from '../common/pending-entities';

@Injectable()
export class CustomersService {
  /**
   * 客户列表。
   * I17：默认**隐藏占位档案**「（未建档客户·待补）」；includePlaceholders=1 时显示。
   * 甲方裁定 2（2026-10-05）：列表页按开关隐藏不变；**选择下拉**一律显式带该参数（占位客户始终可选）。
   */
  async findAll(opts: { includePlaceholders?: string } = {}) {
    // 甲方裁定 2（2026-10-05）：客户/产品的**选择下拉始终显示两个占位档案**（不受开关影响）——
    // 下拉一律显式带 includePlaceholders=1；此处放行的同时**保证占位档案存在**（幂等），
    // 否则下拉在「还没有任何未建档草稿」的库上选不到「（未建档客户·待补）」。
    if (includePlaceholders(opts.includePlaceholders)) await ensurePendingCustomer();
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
