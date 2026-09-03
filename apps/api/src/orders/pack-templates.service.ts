import { Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { packTemplates } from '../db/schema';

export interface PackTemplateDto {
  name: string;
  pack: Record<string, string>;
  note?: string;
  imageUrl?: string;
}

@Injectable()
export class PackTemplatesService {
  async findAll() {
    return db.select().from(packTemplates).orderBy(desc(packTemplates.id));
  }

  async create(dto: PackTemplateDto) {
    const [row] = await db
      .insert(packTemplates)
      .values({
        name: dto.name,
        pack: dto.pack,
        note: dto.note ?? null,
        imageUrl: dto.imageUrl ?? null,
      })
      .returning();
    return row;
  }

  async remove(id: number) {
    const [row] = await db.delete(packTemplates).where(eq(packTemplates.id, id)).returning();
    if (!row) throw new NotFoundException('模板不存在');
  }
}
