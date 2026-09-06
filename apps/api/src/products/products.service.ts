import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import {
  NewProduct,
  productProcesses,
  products,
  processes as processesTbl,
  workCenters,
} from '../db/schema';

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

  // ============ I13 工序路线配置 ============

  /** 工序字典（含所属泳道名）—— 编辑器右侧字典面板 */
  async listProcessDictionary() {
    return db
      .select({
        id: processesTbl.id,
        key: processesTbl.key,
        name: processesTbl.name,
        wcKey: processesTbl.wcKey,
        wcName: workCenters.name,
        sortOrder: processesTbl.sortOrder,
      })
      .from(processesTbl)
      .leftJoin(workCenters, eq(workCenters.key, processesTbl.wcKey))
      .orderBy(processesTbl.sortOrder);
  }

  /** 某产品已配置的工序路线（按 seq 排序，含字典字段） */
  async listProcessRoutes(productId: number) {
    return db
      .select({
        processId: productProcesses.processId,
        seq: productProcesses.seq,
        unitSeconds: productProcesses.unitSeconds,
        changeoverMinutes: productProcesses.changeoverMinutes,
        processKey: processesTbl.key,
        processName: processesTbl.name,
        wcKey: processesTbl.wcKey,
        wcName: workCenters.name,
      })
      .from(productProcesses)
      .innerJoin(processesTbl, eq(processesTbl.id, productProcesses.processId))
      .leftJoin(workCenters, eq(workCenters.key, processesTbl.wcKey))
      .where(eq(productProcesses.productId, productId))
      .orderBy(productProcesses.seq);
  }

  /**
   * 整表替换某产品的工序路线（事务）：
   *  - items 可空 → 清空
   *  - 重复 processId → 400
   *  - unitSeconds 允许 null（未填 → 排期工期 1 天占位）；填则 > 0
   *  - changeoverMinutes ≥ 0；默认 0
   *  - seq 服务端重排 1..N（不依赖客户端，避免冲突）
   */
  async replaceProcessRoutes(
    productId: number,
    items: Array<{ processId: number; unitSeconds?: number | null; changeoverMinutes?: number | null }>,
  ) {
    const [prod] = await db.select({ id: products.id }).from(products).where(eq(products.id, productId));
    if (!prod) throw new NotFoundException(`产品 ${productId} 不存在`);

    const seen = new Set<number>();
    for (const it of items ?? []) {
      if (!Number.isInteger(it.processId) || it.processId <= 0) {
        throw new BadRequestException('processId 必须为正整数');
      }
      if (seen.has(it.processId)) {
        throw new BadRequestException(`重复工序 processId=${it.processId}`);
      }
      seen.add(it.processId);
      if (it.unitSeconds != null && (typeof it.unitSeconds !== 'number' || it.unitSeconds <= 0)) {
        throw new BadRequestException(`工序 ${it.processId} 单件耗时必须为正数`);
      }
      if (it.changeoverMinutes != null && (typeof it.changeoverMinutes !== 'number' || it.changeoverMinutes < 0)) {
        throw new BadRequestException(`工序 ${it.processId} 换型时间不能为负`);
      }
    }
    // 校验 processId 全部存在
    const procRows = await db.select({ id: processesTbl.id }).from(processesTbl);
    const validIds = new Set(procRows.map((p) => p.id));
    for (const it of items ?? []) {
      if (!validIds.has(it.processId)) throw new BadRequestException(`未知工序 processId=${it.processId}`);
    }

    await db.transaction(async (tx) => {
      await tx.delete(productProcesses).where(eq(productProcesses.productId, productId));
      if (items?.length) {
        await tx.insert(productProcesses).values(
          items.map((it, idx) => ({
            productId,
            processId: it.processId,
            seq: idx + 1,
            unitSeconds: it.unitSeconds == null ? null : String(it.unitSeconds),
            changeoverMinutes: it.changeoverMinutes ?? 0,
          })),
        );
      }
    });
    return { ok: true, count: items?.length ?? 0 };
  }
}
