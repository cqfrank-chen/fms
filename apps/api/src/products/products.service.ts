import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  NewProduct,
  productProcesses,
  products,
  processes as processesTbl,
  workCenters,
} from '../db/schema';
import { CATALOG_GAS_TYPES } from '../db/schema';
import { CATALOG_SERIES } from '../ai/catalog-models';
import { hidePlaceholders, includePlaceholders } from '../common/placeholders';
import { ensurePendingProduct } from '../common/pending-entities';

/** 产品目录列表的筛选条件（全部可空 = 不筛） */
export interface ProductListFilter {
  /** 目录系列 / 款式（AMERICAN STYLE CUTTING TIP …）—— 精确匹配 */
  series?: string;
  /** 目录气体类型：LPG / ACE（ACETYLENE 的写法兼容） */
  gasType?: string;
  /** 目录锚定状态：matched（已锚定）/ unmatched（未锚定） */
  anchor?: string;
  /** 关键词：产品名 / 基础型号 / size / 系列 模糊匹配 */
  kw?: string;
}

/**
 * 「按系列排序」的口径（甲方本轮要求）：**同一系列的产品排在一起**，
 * 系列顺序取**官方目录顺序**（01 AMERICAN → 02 JAPANESE → 03 BRITISH → 04 FRENCH →
 * 05 AUSTRALIAN → 06 BRAZILIAN，见 tools/catalog/catalog_models.json）；
 * 没有系列（未锚定）的排最后。组内再按 基础型号 → size → id。
 */
function seriesOrderExpr(): SQL {
  const cases = CATALOG_SERIES.map((s, i) => sql`when ${s.series} then ${i}`);
  return sql`case ${products.series} ${sql.join(cases, sql` `)} else ${CATALOG_SERIES.length} end`;
}

@Injectable()
export class ProductsService {
  /**
   * 产品目录列表。
   * I17：默认**隐藏占位产品**「（未建档产品·待补）」；includePlaceholders=1 时显示。
   * 甲方裁定 2（2026-10-05）：列表页按开关隐藏不变；**选择下拉**一律显式带该参数（占位产品始终可选）。
   * 本轮新增（2026 目录更正）：支持 系列 / 气体类型 / 锚定状态 / 关键词 四个筛选，
   * 默认**按系列（官方目录顺序）分组排序**，同一系列的产品排在一起，无系列的排在最后。
   */
  async findAll(opts: { includePlaceholders?: string } & ProductListFilter = {}) {
    // 甲方裁定 2（2026-10-05）：客户/产品的**选择下拉始终显示两个占位档案**（不受开关影响）——
    // 下拉一律显式带 includePlaceholders=1；此处放行的同时**保证占位档案存在**（幂等），
    // 否则下拉在「还没有任何未建档草稿」的库上选不到「（未建档产品·待补）」。
    if (includePlaceholders(opts.includePlaceholders)) await ensurePendingProduct();

    const conds: SQL[] = [];
    const series = (opts.series ?? '').trim();
    if (series) conds.push(eq(products.series, series));
    // 气体类型：LPG / ACETYLENE（'ACE' 是目录 FOR ACE 的写法，一并放行；其余非法值忽略）
    const gasRaw = (opts.gasType ?? '').trim().toUpperCase();
    const gas = gasRaw === 'ACE' ? 'ACETYLENE' : gasRaw;
    if ((CATALOG_GAS_TYPES as readonly string[]).includes(gas)) conds.push(eq(products.gasType, gas));
    // 锚定状态：matched = 已锚定；unmatched = 未锚定（其余值忽略）
    const anchor = (opts.anchor ?? '').trim();
    if (anchor === 'matched' || anchor === 'unmatched') conds.push(eq(products.catalogAnchor, anchor));
    // 关键词：产品名 / 基础型号 / size / 系列 模糊匹配（与上述筛选是 AND 关系）
    const kw = (opts.kw ?? '').trim();
    if (kw) {
      const like = '%' + kw + '%';
      const parts: SQL[] = [
        ilike(products.name, like),
        ilike(products.catalogModel, like),
        ilike(products.sizeSpec, like),
        ilike(products.series, like),
      ];
      conds.push(or(...parts) as SQL);
    }

    const rows = await db
      .select()
      .from(products)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(
        asc(seriesOrderExpr()),            // ① 系列（官方目录顺序；无系列 = 最大 = 最后）
        sql`${products.catalogModel} asc nulls last`,  // ② 组内：基础型号
        sql`${products.sizeSpec} asc nulls last`,      // ③ 组内：size（0 00 000 1 … 文本序）
        asc(products.id),                  // ④ 兜底：最早建档在前
      );
    return hidePlaceholders(rows, opts.includePlaceholders);
  }

  async create(data: NewProduct) {
    const [row] = await db.insert(products).values(data).returning();
    return row;
  }

  async update(id: number, data: Partial<NewProduct>) {
    const [row] = await db.update(products).set({ ...data, updatedAt: new Date() }).where(eq(products.id, id)).returning();
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
      await tx.update(products).set({ updatedAt: new Date() }).where(eq(products.id, productId));
    });
    return { ok: true, count: items?.length ?? 0 };
  }
}
