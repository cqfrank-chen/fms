import { BadRequestException, Body, Controller, Delete, Get, HttpException, HttpStatus, Post } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { db } from '../db';
import { aiParseDrafts } from '../db/schema';
import { Roles } from '../auth/decorators';
import { decodeUpload } from '../common/upload';
import { OrderParserService } from './order-parser.service';
import { TableParserService, detectUploadKind } from './table-parser.service';

// 上传协议（dataURL/纯 base64 + 8MB 护栏）已抽到 common/upload，主数据批量导入复用同一实现；
// 这里保持对外导出，既有调用与测试不受影响。
export { decodeUpload };

class ParseOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  text?: string;

  @IsOptional()
  @IsString()
  image?: string; // dataURL（data:image/...;base64,...）

  /** 上传文件：dataURL（data:<mime>;base64,xxx）或纯 base64；xlsx/csv/图片 都走这里 */
  @IsOptional()
  @IsString()
  file?: string;

  /** 原始文件名（带扩展名，浏览器上传时必带；类型判定仍以文件 magic bytes 为准） */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

  /** 仅 mock 模式（未配 AI_API_KEY）生效：直通 LLM 抽取结果，供验收/离线测试 */
  @IsOptional()
  stub?: Record<string, unknown>;

  @ValidateIf((o: ParseOrderDto) => !o.text && !o.image && !o.file && !o.stub)
  @IsString({ message: 'text / image / file / stub 至少提供一个' })
  _atLeastOne?: string;
}

@Controller('ai/orders')
export class AiOrdersController {
  constructor(
    private readonly parser: OrderParserService,
    private readonly tableParser: TableParserService,
  ) {}

  /** AI 订单解析：文本/图片/Excel(CSV) → 结构化草稿 + 规则校验 + 低置信标红（确认建单复用 POST /orders） */
  @Roles('admin', 'planner')
  @Post('parse')
  async parse(@Body() dto: ParseOrderDto) {
    try {
      // 文件分支：图片 → 既有 vision 通道；xls/xlsx/csv → 表格解析管线（PDF 给明确中文提示）
      // 类型判定以 magic bytes 为准（扩展名写错也能正确分流），扩展名/MIME 仅兜底
      if (dto.file) {
        const up = decodeUpload(dto.file, dto.fileName);
        const kind = detectUploadKind(up.buffer, up.name, up.mime);
        if (kind === 'image') {
          const dataUrl = up.mime ? `data:${up.mime};base64,${up.buffer.toString('base64')}` : `data:image/png;base64,${up.buffer.toString('base64')}`;
          return await this.parser.parseAndResolve({ image: dataUrl, text: dto.text, stub: dto.stub as never });
        }
        const t = await this.tableParser.parseUpload({ buffer: up.buffer, fileName: up.name, mimeType: up.mime });
        return await this.parser.parseAndResolve({
          table: { rows: t.rows, source: t.kind === 'csv' ? 'csv' : 'excel' },
          text: dto.text,
          hint: dto.text,
          stub: dto.stub as never,
        });
      }
      return await this.parser.parseAndResolve({
        text: dto.text,
        image: dto.image,
        stub: dto.stub as never,
      });
    } catch (e) {
      if (e instanceof HttpException) throw e; // 表格解析的 400 中文提示原样透传
      const msg = (e as Error).message;
      if (msg.includes('AI_VISION_KEY')) {
        throw new HttpException({ message: msg, code: 'VISION_KEY_MISSING' }, HttpStatus.BAD_REQUEST);
      }
      throw new HttpException({ message: `AI 解析失败：${msg}` }, HttpStatus.BAD_GATEWAY);
    }
  }

  // ============ I14 草稿单槽持久化（刷新/误关不丢人工修正） ============

  /** 读当前未提交草稿（无则 draft=null） */
  @Get('draft')
  async getDraft() {
    const [row] = await db.select().from(aiParseDrafts).where(eq(aiParseDrafts.id, 1));
    if (!row) return { draft: null };
    return { draft: { result: row.result, draft: row.draft, updatedAt: row.updatedAt } };
  }

  /** 保存/覆盖草稿（单槽 upsert id=1；保持 createdAt，刷新 updatedAt） */
  @Roles('admin', 'planner')
  @Post('draft')
  async saveDraft(@Body() body: { result?: unknown; draft?: unknown }) {
    if (!body.result || typeof body.result !== 'object' || Array.isArray(body.result)) {
      throw new BadRequestException('result（AI 解析快照）缺失或格式错误');
    }
    if (!body.draft || typeof body.draft !== 'object' || Array.isArray(body.draft)) {
      throw new BadRequestException('draft（可编辑草稿）缺失或格式错误');
    }
    const [row] = await db
      .insert(aiParseDrafts)
      .values({ id: 1, result: body.result as Record<string, unknown>, draft: body.draft as Record<string, unknown> })
      .onConflictDoUpdate({
        target: aiParseDrafts.id,
        set: {
          result: body.result as Record<string, unknown>,
          draft: body.draft as Record<string, unknown>,
          updatedAt: new Date(),
        },
      })
      .returning({ id: aiParseDrafts.id, updatedAt: aiParseDrafts.updatedAt });
    return { ok: true, id: row?.id ?? 1, updatedAt: row?.updatedAt ?? new Date() };
  }

  /** 清除草稿（确认建单成功 / 显式放弃） */
  @Roles('admin', 'planner')
  @Delete('draft')
  async clearDraft() {
    await db.delete(aiParseDrafts).where(eq(aiParseDrafts.id, 1));
    return { ok: true };
  }
}
