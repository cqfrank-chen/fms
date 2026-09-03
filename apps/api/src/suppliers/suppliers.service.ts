import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { suppliers, NewSupplier } from '../db/schema';

@Injectable()
export class SuppliersService {
  async findAll() {
    return db.select().from(suppliers).orderBy(suppliers.id);
  }

  async create(data: NewSupplier) {
    const [row] = await db.insert(suppliers).values(data).returning();
    return row;
  }

  async update(id: number, data: Partial<NewSupplier>) {
    const [row] = await db.update(suppliers).set(data).where(eq(suppliers.id, id)).returning();
    return row;
  }

  async remove(id: number) {
    await db.delete(suppliers).where(eq(suppliers.id, id));
  }
}
