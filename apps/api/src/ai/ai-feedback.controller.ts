import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { desc, sql } from 'drizzle-orm';
import { Roles } from '../auth/decorators';
import { db } from '../db';
import { aiParseFeedback } from '../db/schema';
import type { NewAiParseFeedback } from '../db/schema';

/**
 * 学习闭环（I12，spec §8）：人工确认「解析→建单」后的差异回流入库，
 * 作为 few-shot 样本与校验规则演进的原料（逐季提升直通率，业界 70-90%）。
 */

@Controller('ai/feedback')
export class AiFeedbackController {
  /** 记录一次 AI 解析的人工确认反馈 */
  @Roles('admin', 'planner')
  @Post()
  async record(@Body() body: {
    source: string;
    parsed: Record<string, unknown>;
    corrected?: Record<string, unknown>;
    corrections?: Array<Record<string, unknown>>;
    directPass?: boolean;
  }) {
    const row: NewAiParseFeedback = {
      source: body.source || 'manual',
      parsed: body.parsed ?? {},
      corrected: body.corrected,
      corrections: Array.isArray(body.corrections) ? body.corrections : [],
      directPass: !!body.directPass,
    };
    const [ins] = await db.insert(aiParseFeedback).values(row).returning({ id: aiParseFeedback.id });
    return { ok: true, id: ins.id };
  }

  /** 回流样本列表（few-shot 语料导出）；附直通率统计（=directPass 占比） */
  @Get()
  async list(@Query('limit') limit?: string) {
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    const rows = await db
      .select()
      .from(aiParseFeedback)
      .orderBy(desc(aiParseFeedback.id))
      .limit(n);
    const [{ total, pass }] = await db
      .select({
        total: sql<number>`count(*)::int`,
        pass: sql<number>`count(*) filter (where direct_pass)::int`,
      })
      .from(aiParseFeedback);
    return {
      rows,
      stats: { total, directPass: pass, rate: total ? Math.round((pass / total) * 1000) / 10 : 0 },
    };
  }
}
