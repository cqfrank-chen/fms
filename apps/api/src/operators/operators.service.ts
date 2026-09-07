import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { operators, NewOperator } from '../db/schema';

@Injectable()
export class OperatorsService {
  async findAll() {
    return db.select().from(operators).orderBy(operators.id);
  }

  async create(data: NewOperator) {
    const [row] = await db.insert(operators).values(data).returning();
    return row;
  }

  async update(id: number, data: Partial<NewOperator>) {
    const [row] = await db.update(operators).set({ ...data, updatedAt: new Date() }).where(eq(operators.id, id)).returning();
    return row;
  }

  async remove(id: number) {
    await db.delete(operators).where(eq(operators.id, id));
  }
}
