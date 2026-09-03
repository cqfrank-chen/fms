import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { IsInt, Min } from 'class-validator';
import type { PlanStatus } from '../db/schema';
import { PlanSheetsService } from './plan-sheets.service';

/** 行报工 DTO：本次完成数量（增量，办公室 PC 代录） */
class ReportDto {
  @IsInt({ message: '计划单行 ID 须为整数' })
  lineId: number;

  @IsInt({ message: '本次完成数量须为整数' })
  @Min(1, { message: '本次完成数量至少为 1' })
  doneQty: number;
}

@Controller('plan-sheets')
export class PlanSheetsController {
  constructor(private readonly service: PlanSheetsService) {}

  /** 订单确认：草稿 → 已确认 + 自动生成计划单草稿（POST /orders/:id/confirm 由 orders 模块复用） */
  @Post(':id/audit')
  audit(@Param('id', ParseIntPipe) id: number) {
    return this.service.audit(id);
  }

  /** 行报工（I06）：录完成数量 → 状态聚合 → 触发入库单草稿 */
  @Post(':id/report')
  report(@Param('id', ParseIntPipe) id: number, @Body() dto: ReportDto) {
    return this.service.report(id, dto);
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
