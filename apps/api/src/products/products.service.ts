import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { products, NewProduct } from '../db/schema';

@Injectable()
export class ProductsService {
  async findAll() {
    return db.select().from(products).orderBy(products.id);
  }

  async create(data: NewProduct) {
    const [row] = await db.insert(products).values(data).returning();
    return row;
  }

  async update(id: number, data: Partial<NewProduct>) {
    const [row] = await db.update(products).set(data).where(eq(products.id, id)).returning();
    return row;
  }

  async remove(id: number) {
    await db.delete(products).where(eq(products.id, id));
  }
}
