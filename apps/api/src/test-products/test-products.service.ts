import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { testProducts, NewTestProduct } from '../db/schema';

@Injectable()
export class TestProductsService {
  async findAll() {
    return db.select().from(testProducts).orderBy(testProducts.id);
  }

  async create(data: NewTestProduct) {
    const [row] = await db.insert(testProducts).values(data).returning();
    return row;
  }

  async update(id: number, data: Partial<NewTestProduct>) {
    const [row] = await db.update(testProducts).set(data).where(eq(testProducts.id, id)).returning();
    return row;
  }

  async remove(id: number) {
    await db.delete(testProducts).where(eq(testProducts.id, id));
  }
}
