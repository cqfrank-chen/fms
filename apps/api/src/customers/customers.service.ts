import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { customers, NewCustomer } from '../db/schema';

@Injectable()
export class CustomersService {
  async findAll() {
    return db.select().from(customers).orderBy(customers.id);
  }

  async create(data: NewCustomer) {
    const [row] = await db.insert(customers).values(data).returning();
    return row;
  }

  async update(id: number, data: Partial<NewCustomer>) {
    const [row] = await db.update(customers).set(data).where(eq(customers.id, id)).returning();
    return row;
  }

  async remove(id: number) {
    await db.delete(customers).where(eq(customers.id, id));
  }
}
