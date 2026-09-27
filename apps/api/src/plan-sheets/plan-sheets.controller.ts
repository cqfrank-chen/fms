import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { IsInt, IsOptional, Min } from 'class-validator';
import type { PlanStatus } from '../db/schema';
import { PlanSheetsService } from './plan-sheets.service';

/** 行报工 DTO：本次完成数量（增量，办公室 PC 代录）
 *  routeSeq / completedQuantity 为页面展示的当前状态（可选）；
 *  传入后服务端会做乐观校验，重复提交不会跨工序推进、直报不会重复累计。 */
class ReportDto {
  @IsInt({ message: '计划单行 ID 须为整数' })
  lineId: number;

  @IsInt({ message: '本次完成数量须为整数' })
  @Min(1, { message: '本次完成数量至少为 1' })
  doneQty: number;

  @IsOptional()
  @IsInt()
  routeSeq?: number;

  @IsOptional()
  @IsInt()
  completedQuantity?: number;
}

@Controller('plan-sheets')
export class PlanSheetsController {
  constructor(private readonly service: PlanSheetsService) {}

  /** 订单确认：草稿 → 已确认 + 自动生成计划单草稿（POST /orders/:id/confirm 由 orders 模块复用） */
  @Post(':id/audit')
  audit(@Param('id', ParseIntPipe) id: number) {
    return this.service.audit(id);
  }

  /** 审核不通过：计划单作废 + 订单退回草稿（可编辑后重新确认） */
  @Post(':id/reject')
  reject(@Param('id', ParseIntPipe) id: number) {
    return this.service.reject(id);
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

  /** 报工流水（留痕展示） */
  @Get(':id/report-logs')
  reportLogs(@Param('id', ParseIntPipe) id: number) {
    return this.service.reportLogs(id);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }
}
