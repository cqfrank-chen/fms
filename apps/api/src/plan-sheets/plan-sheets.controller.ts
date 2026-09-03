import { Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import type { PlanStatus } from '../db/schema';
import { PlanSheetsService } from './plan-sheets.service';

@Controller('plan-sheets')
export class PlanSheetsController {
  constructor(private readonly service: PlanSheetsService) {}

  /** 订单确认：草稿 → 已确认 + 自动生成计划单草稿（POST /orders/:id/confirm 由 orders 模块复用） */
  @Post(':id/audit')
  audit(@Param('id', ParseIntPipe) id: number) {
    return this.service.audit(id);
  }

  @Get()
  findAll(
    @Query('status') status?: PlanStatus,
    @Query('customerId') customerId?: string,
    @Query('kw') kw?: string,
  ) {
    return this.service.findAll({ status, customerId: customerId ? Number(customerId) : undefined, kw });
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }
}
