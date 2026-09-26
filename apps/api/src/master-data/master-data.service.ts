import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { planSheetLines, processes, productProcesses, workCenters } from '../db/schema';

export interface ProcessInput { name: string; wcKey: string; sortOrder?: number; key?: string }
export interface ProcessPatch { name?: string; wcKey?: string; sortOrder?: number }
export interface WorkCenterInput { name: string; machines?: number; sortOrder?: number; key?: string }
export interface WorkCenterPatch { name?: string; machines?: number; sortOrder?: number }

const KEY_RE = /^[a-z0-9_]{1,24}$/;

/**
 * 主数据维护：工序字典（processes）与工作中心·泳道（work_centers）。
 * 删除保护：被产品工艺路线引用的工序、仍挂工序或计划行的泳道均禁止删除（返回可读 400）。
 */
@Injectable()
export class MasterDataService {
  // ==================== 工序字典 ====================
  async listProcesses() {
    const [procs, wcs, uses] = await Promise.all([
      db.select().from(processes).orderBy(asc(processes.sortOrder), asc(processes.id)),
      db.select().from(workCenters),
      db
        .select({ processId: productProcesses.processId, n: sql<number>`count(*)::int` })
        .from(productProcesses)
        .groupBy(productProcesses.processId),
    ]);
    const wcName = new Map(wcs.map((w) => [w.key, w.name]));
    const useMap = new Map(uses.map((u) => [u.processId, u.n]));
    return procs.map((p) => ({ ...p, wcName: wcName.get(p.wcKey) ?? null, usedByProducts: useMap.get(p.id) ?? 0 }));
  }

  async createProcess(dto: ProcessInput) {
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('工序名必填');
    const [wc] = await db.select().from(workCenters).where(eq(workCenters.key, dto.wcKey));
    if (!wc) throw new BadRequestException('所属工作中心不存在');
    const key = dto.key?.trim() || (await this.nextKey('p_', (await db.select({ key: processes.key }).from(processes)).map((r) => r.key)));
    if (!KEY_RE.test(key)) throw new BadRequestException('工序编码只能是小写字母/数字/下划线，且不超过 24 位');
    if ((await db.select({ id: processes.id }).from(processes).where(eq(processes.key, key))).length)
      throw new BadRequestException(`工序编码 ${key} 已存在`);
    const [{ mx }] = await db.select({ mx: sql<number | null>`max(sort_order)` }).from(processes);
    const [created] = await db
      .insert(processes)
      .values({ key, name, wcKey: wc.key, sortOrder: dto.sortOrder ?? (mx ?? 0) + 1 })
      .returning();
    return created;
  }

  async updateProcess(id: number, dto: ProcessPatch) {
    const [row] = await db.select().from(processes).where(eq(processes.id, id));
    if (!row) throw new NotFoundException('工序不存在');
    if (dto.wcKey && !(await db.select({ key: workCenters.key }).from(workCenters).where(eq(workCenters.key, dto.wcKey))).length)
      throw new BadRequestException('所属工作中心不存在');
    const [updated] = await db
      .update(processes)
      .set({
        name: dto.name !== undefined ? dto.name.trim() : row.name,
        wcKey: dto.wcKey ?? row.wcKey,
        sortOrder: dto.sortOrder ?? row.sortOrder,
      })
      .where(eq(processes.id, id))
      .returning();
    return updated;
  }

  async removeProcess(id: number) {
    const [row] = await db.select().from(processes).where(eq(processes.id, id));
    if (!row) throw new NotFoundException('工序不存在');
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(productProcesses)
      .where(eq(productProcesses.processId, id));
    if (n > 0)
      throw new BadRequestException(`工序「${row.name}」已被 ${n} 个产品的工艺路线使用，请先在产品工序路线中移除`);
    await db.delete(processes).where(eq(processes.id, id));
    return { ok: true };
  }

  // ==================== 工作中心（泳道） ====================
  async listWorkCenters() {
    const [wcs, counts] = await Promise.all([
      db.select().from(workCenters).orderBy(asc(workCenters.sortOrder), asc(workCenters.key)),
      db
        .select({ wcKey: processes.wcKey, n: sql<number>`count(*)::int` })
        .from(processes)
        .groupBy(processes.wcKey),
    ]);
    const cnt = new Map(counts.map((c) => [c.wcKey, c.n]));
    return wcs.map((w) => ({ ...w, processCount: cnt.get(w.key) ?? 0 }));
  }

  async createWorkCenter(dto: WorkCenterInput) {
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('工作中心名称必填');
    const key = dto.key?.trim() || (await this.nextKey('wc_', (await db.select({ key: workCenters.key }).from(workCenters)).map((r) => r.key)));
    if (!KEY_RE.test(key)) throw new BadRequestException('工作中心编码只能是小写字母/数字/下划线，且不超过 24 位');
    if ((await db.select({ key: workCenters.key }).from(workCenters).where(eq(workCenters.key, key))).length)
      throw new BadRequestException(`工作中心编码 ${key} 已存在`);
    const [{ mx }] = await db.select({ mx: sql<number | null>`max(sort_order)` }).from(workCenters);
    const [created] = await db
      .insert(workCenters)
      .values({ key, name, machines: dto.machines ?? 1, sortOrder: dto.sortOrder ?? (mx ?? 0) + 1 })
      .returning();
    return created;
  }

  async updateWorkCenter(key: string, dto: WorkCenterPatch) {
    const [row] = await db.select().from(workCenters).where(eq(workCenters.key, key));
    if (!row) throw new NotFoundException('工作中心不存在');
    const [updated] = await db
      .update(workCenters)
      .set({
        name: dto.name !== undefined ? dto.name.trim() : row.name,
        machines: dto.machines ?? row.machines,
        sortOrder: dto.sortOrder ?? row.sortOrder,
      })
      .where(eq(workCenters.key, key))
      .returning();
    return updated;
  }

  async removeWorkCenter(key: string) {
    const [row] = await db.select().from(workCenters).where(eq(workCenters.key, key));
    if (!row) throw new NotFoundException('工作中心不存在');
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(processes).where(eq(processes.wcKey, key));
    if (n > 0) throw new BadRequestException(`工作中心「${row.name}」下仍有 ${n} 道工序，请先删除或迁移这些工序`);
    const [{ m }] = await db
      .select({ m: sql<number>`count(*)::int` })
      .from(planSheetLines)
      .where(eq(planSheetLines.wcKey, key));
    if (m > 0) throw new BadRequestException(`工作中心「${row.name}」仍有 ${m} 条计划行在排期/生产中，不能删除`);
    await db.delete(workCenters).where(eq(workCenters.key, key));
    return { ok: true };
  }

  /** 生成内部编码：prefix + (现有同前缀最大数字 + 1) */
  private nextKey(prefix: string, keys: string[]) {
    let max = 0;
    for (const k of keys) {
      const m = new RegExp(`^${prefix}(\\d+)$`).exec(k);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${prefix}${max + 1}`;
  }
}
