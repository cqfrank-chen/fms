import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import { IsArray, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { Response } from 'express';
import { AccountingService } from './accounting.service';

class SlipLineDto {
  @IsInt()
  id: number;

  @IsNumber({}, { message: '核销金额须为数字' })
  @Min(0.01, { message: '核销金额须为正数' })
  amount: number;
}

class CreateSlipDto {
  @IsInt({ message: '客户/供应商 ID 须为整数' })
  partyId: number;

  @IsIn(['settle', 'prepay'], { message: '模式须为 settle(核销) 或 prepay(预收/预付)' })
  mode: 'settle' | 'prepay';

  @IsNumber({}, { message: '金额须为数字' })
  @Min(0.01, { message: '金额须为正数' })
  amount: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SlipLineDto)
  lines?: SlipLineDto[];
}

class CostDto {
  @IsNotEmpty({ message: '月份必填（YYYY-MM）' })
  month: string;

  @IsIn(['labor', 'electricity', 'gas', 'rent', 'depreciation', 'other'], { message: '类别非法' })
  category: string;

  @IsNumber({}, { message: '金额须为数字' })
  @Min(0, { message: '金额不能为负' })
  amount: number;

  @IsOptional()
  @IsString()
  note?: string;
}

@Controller()
export class AccountingController {
  constructor(private readonly svc: AccountingService) {}

  // 应收/应付
  @Get('receivables') receivables() { return this.svc.receivablesList(); }
  @Get('payables') payables() { return this.svc.payablesList(); }

  // 收款单
  @Get('collection-slips') collectionSlips() { return this.svc.collectionSlipsList(); }
  @Post('collection-slips')
  createCollection(@Body() dto: CreateSlipDto) {
    return this.svc.createCollectionSlip({
      customerId: dto.partyId, mode: dto.mode, amount: dto.amount, note: dto.note,
      lines: dto.lines?.map((l) => ({ receivableId: l.id, amount: l.amount })),
    });
  }
  @Post('collection-slips/:id/void') voidCollection(@Param('id', ParseIntPipe) id: number) { return this.svc.voidCollectionSlip(id); }

  // 付款单
  @Get('payment-slips') paymentSlips() { return this.svc.paymentSlipsList(); }
  @Post('payment-slips')
  createPayment(@Body() dto: CreateSlipDto) {
    return this.svc.createPaymentSlip({
      supplierId: dto.partyId, mode: dto.mode, amount: dto.amount, note: dto.note,
      lines: dto.lines?.map((l) => ({ payableId: l.id, amount: l.amount })),
    });
  }
  @Post('payment-slips/:id/void') voidPayment(@Param('id', ParseIntPipe) id: number) { return this.svc.voidPaymentSlip(id); }

  // 对账单 / 利润 / 成本
  @Get('statements') statements() { return this.svc.statements(); }
  @Get('profit') profit(@Query('month') month: string) { return this.svc.profit(month || this.currentMonth()); }
  @Get('monthly-costs') costs(@Query('month') month: string) { return this.svc.listMonthlyCosts(month || this.currentMonth()); }
  @Post('monthly-costs') upsertCost(@Body() dto: CostDto) { return this.svc.upsertMonthlyCost(dto); }

  // 四表导出
  @Get('export/:kind')
  async export(@Param('kind') kind: string, @Res() res: Response) {
    const { name, csv } = await this.svc.exportCsv(kind);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send('\uFEFF' + csv);
  }

  private currentMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
}
