import { BadRequestException, Body, Controller, Delete, Get, HttpException, HttpStatus, Post } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { db } from '../db';
import { aiParseDrafts } from '../db/schema';
import { OrderParserService } from './order-parser.service';

class ParseOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  text?: string;

  @IsOptional()
  @IsString()
  image?: string; // dataURL（data:image/...;base64,...）

  /** 仅 mock 模式（未配 AI_API_KEY）生效：直通 LLM 抽取结果，供验收/离线测试 */
  @IsOptional()
  stub?: Record<string, unknown>;

  @ValidateIf((o: ParseOrderDto) => !o.text && !o.image && !o.stub)
  @IsString({ message: 'text / image / stub 至少提供一个' })
  _atLeastOne?: string;
}

@Controller('ai/orders')
export class AiOrdersController {
  constructor(private readonly parser: OrderParserService) {}

  /** AI 订单解析：文本/图片 → 结构化草稿 + 规则校验 + 低置信标红（确认建单复用 POST /orders） */
  @Post('parse')
  async parse(@Body() dto: ParseOrderDto) {
    try {
      return await this.parser.parseAndResolve({
        text: dto.text,
        image: dto.image,
        stub: dto.stub as never,
      });
    } catch (e) {
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
  @Delete('draft')
  async clearDraft() {
    await db.delete(aiParseDrafts).where(eq(aiParseDrafts.id, 1));
    return { ok: true };
  }
}
