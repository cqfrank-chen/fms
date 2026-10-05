import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { operators, stickerAdjustments, stickers } from '../db/schema';
import type { Sticker } from '../db/schema';
import { currentOperatorId } from '../common/operator-context';
import { decodeUpload } from '../common/upload';
import { LlmGatewayService } from '../ai/llm-gateway.service';
import { buildStickerRemark, buildStickerTitle, cleanRemarkText, cleanStickerText, isAutoTitle } from './sticker-title';
import type { StickerField } from './sticker-title';
import { checkQtyDelta, resolveDelta } from './sticker-qty';
import type { StickerAdjustKind } from './sticker-qty';
import {
  imageBytes, looksLikeImage, mimeForImagePath, saveStickerImage, stickerImageExists,
} from './sticker-storage';
import { STICKER_VISION_PROMPT, buildSuggestion, emptySuggestion, parseStickerExtract } from './sticker-recognize';
import type { StickerSuggestion } from './sticker-recognize';

/**
 * ============================================================
 * 不干胶库存（I18）—— 图片识别建档 + 查询 + 数量维护
 * ------------------------------------------------------------
 * 链路：上传图片 → POST /stickers/recognize（视觉通道提取，**不写库**，返回建议字段 + rawText）
 *       → 用户确认/修改 → POST /stickers（图片落盘 + 建档）→ 列表查询 → POST /:id/adjust（入库/领用留痕）。
 *
 * 关键口径：
 *   · 标题由 sticker-title 的**纯函数**生成（品牌 + 样式/系列 + 规格，缺项省略并在备注说明），
 *     用户手工改过的标题在后续编辑中**不被覆盖**；
 *   · 识图 Key 未配置 / 调用失败 → 返回 ok=false + 中文提示（HTTP 200，不是 500），
 *     并把已落盘的 imagePath 一并返回，用户可**纯手工填写后直接建档**，绝不编造字段值；
 *   · 图片只存挂载卷目录，库里存相对路径（绝不 base64 入库）；
 *   · 数量调整写 sticker_adjustments 流水（变动前/变动量/变动后 + 操作人 + 备注），只增不改。
 */

export interface StickerListQuery {
  kw?: string;
  brand?: string;
  customer?: string;
  page?: number;
  pageSize?: number;
}

export interface StickerRow {
  id: number;
  title: string;
  brand: string | null;
  style: string | null;
  sizeSpec: string | null;
  qty: number;
  unit: string;
  customer: string | null;
  imagePath: string | null;
  /** 取图地址（有图才有；走登录态接口，不暴露静态目录） */
  imageUrl: string | null;
  /** 图片字节数（前端展示用；文件不在盘上时为 null） */
  imageBytes: number | null;
  rawText: string | null;
  remark: string | null;
  operatorId: number | null;
  operatorName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StickerInput {
  title?: string | null;
  brand?: string | null;
  style?: string | null;
  sizeSpec?: string | null;
  qty?: number | null;
  unit?: string | null;
  customer?: string | null;
  remark?: string | null;
  rawText?: string | null;
  /** 已有图片（recognize 返回的路径）—— 与 file 二选一 */
  imagePath?: string | null;
  /** 上传图片：dataURL（data:image/png;base64,…）或纯 base64（与识单/导入同一协议） */
  file?: string | null;
  fileName?: string | null;
  /** 建档时可附带「AI 不可用」等说明，写进备注留痕 */
  aiNote?: string | null;
}

export interface StickerAdjustInput {
  kind?: string | null;
  qty?: number | null;
  delta?: number | null;
  remark?: string | null;
}

export interface StickerAdjustmentRow {
  id: number;
  stickerId: number;
  kind: string;
  qtyBefore: number;
  qtyDelta: number;
  qtyAfter: number;
  remark: string | null;
  operatorId: number | null;
  operatorName: string | null;
  createdAt: Date;
}

/** 识图失败/降级的中文提示码（前端据此区分「没配 Key」与「调用失败」） */
export type StickerRecognizeCode = 'VISION_KEY_MISSING' | 'VISION_FAILED' | 'VISION_EMPTY';

export interface StickerRecognizeResult {
  ok: boolean;
  code?: StickerRecognizeCode;
  /** 中文提示（ok=false 时必有；界面直接展示，勿在前端重写文案） */
  message?: string;
  /** 已落盘的图片相对路径（**无论识图成功与否都返回**，用户可手工填字段后直接建档） */
  imagePath?: string;
  /** 建议建档字段（识图不可用时为全空，绝不编造） */
  suggestion: StickerSuggestion;
  /** 识图通道是否走了 mock/降级（如实标注） */
  mock?: boolean;
  degraded?: boolean;
}

const str = (v: unknown): string | null => {
  const s = cleanStickerText(v);
  return s || null;
};

@Injectable()
export class StickersService {
  private readonly logger = new Logger(StickersService.name);

  constructor(private readonly llm: LlmGatewayService) {}

  // ============ 列表 / 详情 ============

  /** 列表：关键词（标题/品牌/样式/规格/客户/备注/原文）+ 品牌 + 客户 筛选 + 分页 */
  async findAll(q: StickerListQuery): Promise<{ total: number; page: number; pageSize: number; rows: StickerRow[] }> {
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 20));
    const conds = [];
    if (q.kw) {
      const kw = '%' + q.kw + '%';
      conds.push(or(
        ilike(stickers.title, kw),
        ilike(stickers.brand, kw),
        ilike(stickers.style, kw),
        ilike(stickers.sizeSpec, kw),
        ilike(stickers.customer, kw),
        ilike(stickers.remark, kw),
        ilike(stickers.rawText, kw),
      )!);
    }
    if (q.brand) conds.push(eq(stickers.brand, q.brand));
    if (q.customer) conds.push(ilike(stickers.customer, '%' + q.customer + '%'));
    const where = conds.length ? and(...conds) : undefined;

    const [cnt] = await db.select({ n: sql<number>`count(*)` }).from(stickers).where(where);
    const rows = await db
      .select({ s: stickers, operatorName: operators.name })
      .from(stickers)
      .leftJoin(operators, eq(stickers.operatorId, operators.id))
      .where(where)
      .orderBy(desc(stickers.updatedAt), desc(stickers.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      total: Number(cnt?.n ?? 0),
      page,
      pageSize,
      rows: rows.map((r) => this.toRow(r.s, r.operatorName)),
    };
  }

  /** 品牌候选（筛选下拉用；去重、按名称排序） */
  async brands(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ brand: stickers.brand })
      .from(stickers)
      .where(sql`${stickers.brand} is not null and btrim(${stickers.brand}) <> ''`)
      .orderBy(stickers.brand);
    return rows.map((r) => r.brand).filter((b): b is string => !!b);
  }

  async findOne(id: number): Promise<StickerRow> {
    const rows = await db
      .select({ s: stickers, operatorName: operators.name })
      .from(stickers)
      .leftJoin(operators, eq(stickers.operatorId, operators.id))
      .where(eq(stickers.id, id));
    if (!rows.length) throw new NotFoundException('不干胶记录不存在');
    return this.toRow(rows[0].s, rows[0].operatorName);
  }

  /** 数量流水（留痕查询） */
  async adjustments(id: number, limit = 50): Promise<StickerAdjustmentRow[]> {
    await this.requireRow(id);
    const rows = await db
      .select({ a: stickerAdjustments, operatorName: operators.name })
      .from(stickerAdjustments)
      .leftJoin(operators, eq(stickerAdjustments.operatorId, operators.id))
      .where(eq(stickerAdjustments.stickerId, id))
      .orderBy(desc(stickerAdjustments.id))
      .limit(Math.min(200, Math.max(1, limit)));
    return rows.map((r) => ({
      id: r.a.id,
      stickerId: r.a.stickerId,
      kind: r.a.kind,
      qtyBefore: r.a.qtyBefore,
      qtyDelta: r.a.qtyDelta,
      qtyAfter: r.a.qtyAfter,
      remark: r.a.remark ?? null,
      operatorId: r.a.operatorId ?? null,
      operatorName: r.operatorName ?? null,
      createdAt: r.a.createdAt,
    }));
  }

  /** 取图（controller 返回文件流用）：不存在给中文 404；返回**相对路径**，读取时统一走取图入口 */
  async imageFile(id: number): Promise<{ relPath: string; mime: string; bytes: number }> {
    const row = await this.requireRow(id);
    if (!row.imagePath) throw new NotFoundException('该不干胶记录没有上传图片');
    if (!stickerImageExists(row.imagePath)) throw new NotFoundException('图片文件不存在（可能已被清理），请重新上传');
    return { relPath: row.imagePath, mime: mimeForImagePath(row.imagePath), bytes: imageBytes(row.imagePath) ?? 0 };
  }

  // ============ 识图（不写库） ============

  /**
   * 上传图片 → 视觉通道提取 → 返回建议字段（**不建库存记录**）。
   * 视觉 Key 未配置或调用失败：返回 ok=false + 中文提示（HTTP 200），
   * 同时把**已落盘**的 imagePath 返回，用户可手工填字段后直接 POST /stickers 建档。
   */
  async recognize(input: { file?: string | null; fileName?: string | null; customer?: string | null }): Promise<StickerRecognizeResult> {
    if (!input.file) throw new BadRequestException('请上传不干胶图片（file 必填：dataURL 或纯 base64）');
    const up = decodeUpload(input.file, input.fileName ?? undefined);
    if (!looksLikeImage(up.mime, up.name)) {
      throw new BadRequestException('只支持图片文件（jpg/png/webp/gif/bmp/tif），请重新选择不干胶图片');
    }
    // 先落盘：即使识图不可用，用户也能手工填写后用同一张图建档（避免再传一次）
    const saved = saveStickerImage(up.buffer, up.mime, up.name);
    const dataUrl = `data:${saved.mime};base64,${up.buffer.toString('base64')}`;

    let text = '';
    try {
      const res = await this.llm.vision([dataUrl], STICKER_VISION_PROMPT, { json: true, temperature: 0 });
      if (res.mock || res.degraded) {
        const why = res.reason ? `（${res.reason}）` : '';
        this.logger.warn('不干胶识图降级：' + (res.reason ?? 'mock'));
        const sug = emptySuggestion();
        sug.customer = cleanStickerText(input.customer);
        return {
          ok: false,
          code: 'VISION_FAILED',
          message: `识图调用失败${why}，未能自动提取信息；请手工填写下方字段后直接建档（本次不含任何编造的识别值）`,
          imagePath: saved.relPath,
          suggestion: sug,
          mock: true,
          degraded: true,
        };
      }
      text = res.text ?? '';
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const missingKey = /API Key 未配置|AI_VISION_KEY/.test(msg);
      const sug = emptySuggestion();
      sug.customer = cleanStickerText(input.customer);
      return {
        ok: false,
        code: missingKey ? 'VISION_KEY_MISSING' : 'VISION_FAILED',
        message: missingKey
          ? '识图 Key 未配置，请到「设置 · 主数据 → AI 服务」填写识图 API Key 后重试；也可手工填写下方字段直接建档'
          : `识图调用失败：${msg}；请手工填写下方字段后直接建档`,
        imagePath: saved.relPath,
        suggestion: sug,
        degraded: true,
      };
    }

    const { extract, parsed } = parseStickerExtract(text);
    const suggestion = buildSuggestion({
      ...extract,
      customer: extract.customer || cleanStickerText(input.customer),
    });
    if (!parsed || (!extract.brand && !extract.style && !extract.sizeSpec && !extract.rawText)) {
      return {
        ok: false,
        code: 'VISION_EMPTY',
        message: '识图通道返回为空（未提取到任何字段），请换更清晰的图片或手工填写后建档',
        imagePath: saved.relPath,
        suggestion,
      };
    }
    return { ok: true, imagePath: saved.relPath, suggestion };
  }

  // ============ 建档 / 编辑 ============

  /** 建档：图片（file 或 recognize 得到的 imagePath）+ 已确认字段 → 库存记录 */
  async create(input: StickerInput): Promise<StickerRow> {
    const imagePath = this.resolveImageForWrite(input);
    const brand = str(input.brand);
    const style = str(input.style);
    const sizeSpec = str(input.sizeSpec);
    const auto = buildStickerTitle({ brand, style, sizeSpec });
    const title = cleanStickerText(input.title) || auto.title;
    const qty = this.normalizeQty(input.qty ?? 0);
    const unit = cleanStickerText(input.unit) || '张';
    const rawText = cleanRemarkText(input.rawText); // 原文逐行保留换行（追溯用）
    const remark = buildStickerRemark({
      remark: input.remark, missing: auto.missing, allMissing: auto.parts.length === 0,
      rawText, aiNote: input.aiNote ?? undefined,
    });
    const op = currentOperatorId();

    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(stickers).values({
        title, brand, style, sizeSpec, qty, unit,
        customer: str(input.customer), imagePath, rawText: rawText || null,
        remark: remark || null, operatorId: op,
      }).returning({ id: stickers.id });
      // 建档时若带了初始数量，记一条「入库」流水，保证库存数量的来龙去脉可审计
      if (qty > 0) {
        await tx.insert(stickerAdjustments).values({
          stickerId: row.id, kind: 'in', qtyBefore: 0, qtyDelta: qty, qtyAfter: qty,
          remark: '建档初始数量', operatorId: op,
        });
      }
      return row.id;
    });
    return this.findOne(created);
  }

  /** 编辑字段（PUT）：只改传了的字段；标题未手动改过时随字段重算 */
  async update(id: number, input: StickerInput): Promise<StickerRow> {
    const cur = await this.requireRow(id);
    const patch: Partial<Sticker> = { updatedAt: new Date() };

    if (input.brand !== undefined) patch.brand = str(input.brand);
    if (input.style !== undefined) patch.style = str(input.style);
    if (input.sizeSpec !== undefined) patch.sizeSpec = str(input.sizeSpec);
    if (input.customer !== undefined) patch.customer = str(input.customer);
    if (input.rawText !== undefined) patch.rawText = cleanRemarkText(input.rawText) || null;
    if (input.qty !== undefined) patch.qty = this.normalizeQty(input.qty ?? 0);
    if (input.unit !== undefined) patch.unit = cleanStickerText(input.unit) || '张';
    if (input.imagePath !== undefined) {
      const p = str(input.imagePath);
      if (p && !stickerImageExists(p)) throw new BadRequestException('图片文件不存在（可能已被清理），请重新上传');
      patch.imagePath = p;
    }
    if (input.file) {
      const up = decodeUpload(input.file, input.fileName ?? undefined);
      if (!looksLikeImage(up.mime, up.name)) throw new BadRequestException('只支持图片文件（jpg/png/webp/gif/bmp/tif）');
      const saved = saveStickerImage(up.buffer, up.mime, up.name);
      patch.imagePath = saved.relPath;
    }

    const brand = patch.brand !== undefined ? patch.brand : cur.brand;
    const style = patch.style !== undefined ? patch.style : cur.style;
    const sizeSpec = patch.sizeSpec !== undefined ? patch.sizeSpec : cur.sizeSpec;
    const auto = buildStickerTitle({ brand, style, sizeSpec });
    const manualTitle = input.title !== undefined ? cleanStickerText(input.title) : '';
    if (manualTitle) patch.title = manualTitle;
    else if (input.title !== undefined
      || isAutoTitle(cur.title, { brand: cur.brand, style: cur.style, sizeSpec: cur.sizeSpec })) {
      // 标题未手动改过 → 跟着字段重算（用户手工命名的标题绝不覆盖）
      patch.title = auto.title;
    }
    if (input.remark !== undefined || input.rawText !== undefined) {
      const raw = patch.rawText !== undefined ? cleanRemarkText(patch.rawText) : cleanRemarkText(cur.rawText);
      patch.remark = buildStickerRemark({
        remark: input.remark !== undefined ? input.remark : cur.remark,
        missing: auto.missing, allMissing: auto.parts.length === 0,
        rawText: raw, aiNote: input.aiNote ?? undefined,
      }) || null;
    }
    const op = currentOperatorId();
    if (op != null) patch.operatorId = op;

    // 数量在 PUT 里被改动时同样写一条流水（备注「编辑修正数量」）——
    // 不留「数量变了但流水没记」的黑洞；日常出入库仍建议走 POST /:id/adjust。
    const nextQty = patch.qty !== undefined ? patch.qty : cur.qty;
    const qtyDelta = nextQty - cur.qty;
    await db.transaction(async (tx) => {
      await tx.update(stickers).set(patch).where(eq(stickers.id, id));
      if (qtyDelta !== 0) {
        await tx.insert(stickerAdjustments).values({
          stickerId: id, kind: qtyDelta > 0 ? 'in' : 'out',
          qtyBefore: cur.qty, qtyDelta, qtyAfter: nextQty,
          remark: '编辑修正数量', operatorId: op,
        });
      }
    });
    return this.findOne(id);
  }

  /** 数量调整（入库/领用，正负均可）：写流水留痕，库存不足给中文 400 */
  async adjust(id: number, input: StickerAdjustInput): Promise<{ sticker: StickerRow; adjustment: StickerAdjustmentRow }> {
    const cur = await this.requireRow(id);
    const r = resolveDelta({ kind: input.kind, qty: input.qty, delta: input.delta });
    if (!r.ok) throw new BadRequestException(r.message);
    const chk = checkQtyDelta(cur.qty, r.delta);
    if (!chk.ok) throw new BadRequestException(chk.message);
    const op = currentOperatorId();
    const remark = str(input.remark);

    const adjId = await db.transaction(async (tx) => {
      await tx.update(stickers)
        .set({ qty: chk.qtyAfter, updatedAt: new Date(), ...(op != null ? { operatorId: op } : {}) })
        .where(eq(stickers.id, id));
      const [row] = await tx.insert(stickerAdjustments).values({
        stickerId: id, kind: r.kind, qtyBefore: cur.qty, qtyDelta: r.delta, qtyAfter: chk.qtyAfter,
        remark, operatorId: op,
      }).returning({ id: stickerAdjustments.id });
      return row.id;
    });

    const sticker = await this.findOne(id);
    const list = await this.adjustments(id, 1);
    const adjustment = list.find((a) => a.id === adjId) ?? {
      id: adjId, stickerId: id, kind: r.kind, qtyBefore: cur.qty, qtyDelta: r.delta,
      qtyAfter: chk.qtyAfter, remark, operatorId: op, operatorName: null, createdAt: new Date(),
    };
    return { sticker, adjustment };
  }

  // ============ 内部 ============

  /** 建档时的图片解析：优先新上传的 file，其次 recognize 落盘的 imagePath */
  private resolveImageForWrite(input: StickerInput): string | null {
    if (input.file) {
      const up = decodeUpload(input.file, input.fileName ?? undefined);
      if (!looksLikeImage(up.mime, up.name)) throw new BadRequestException('只支持图片文件（jpg/png/webp/gif/bmp/tif）');
      return saveStickerImage(up.buffer, up.mime, up.name).relPath;
    }
    const p = str(input.imagePath);
    if (!p) return null;
    if (!stickerImageExists(p)) throw new BadRequestException('图片文件不存在（可能已被清理），请重新上传图片');
    return p;
  }

  private normalizeQty(v: number): number {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) throw new BadRequestException('库存数量须为非负整数');
    if (n > 1_000_000_000) throw new BadRequestException('库存数量超出上限（10 亿），请核对后重试');
    return n;
  }

  private async requireRow(id: number): Promise<Sticker> {
    const [row] = await db.select().from(stickers).where(eq(stickers.id, id));
    if (!row) throw new NotFoundException('不干胶记录不存在');
    return row;
  }

  private toRow(s: Sticker, operatorName: string | null): StickerRow {
    return {
      id: s.id,
      title: s.title,
      brand: s.brand ?? null,
      style: s.style ?? null,
      sizeSpec: s.sizeSpec ?? null,
      qty: Number(s.qty) || 0,
      unit: s.unit || '张',
      customer: s.customer ?? null,
      imagePath: s.imagePath ?? null,
      imageUrl: s.imagePath ? `/api/stickers/${s.id}/image` : null,
      imageBytes: s.imagePath ? imageBytes(s.imagePath) : null,
      rawText: s.rawText ?? null,
      remark: s.remark ?? null,
      operatorId: s.operatorId ?? null,
      operatorName: operatorName ?? null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }
}

/** 供 e2e/单测使用的字段名（避免笔误） */
export const STICKER_FIELDS: StickerField[] = ['brand', 'style', 'sizeSpec'];
export type { StickerAdjustKind };
