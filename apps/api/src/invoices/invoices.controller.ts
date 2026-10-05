import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { Roles } from '../auth/decorators';
import { INVOICE_STATUSES, INVOICE_TYPES } from '../db/schema';
import type { InvoiceStatus, InvoiceType } from '../db/schema';
import { InvoicesService } from './invoices.service';
import type { CreateInvoiceDto as CreateInvoiceBody, UpdateInvoiceDto as UpdateInvoiceBody } from './invoices.service';

class ListInvoicesDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '页码（page）须为整数' })
  @Min(1, { message: '页码（page）最小为 1' })
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '每页条数（pageSize）须为整数' })
  @Min(1)
  @Max(200, { message: '每页条数（pageSize）最大 200' })
  pageSize?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '客户 ID（customerId）须为整数' })
  customerId?: number;

  @IsOptional()
  @IsIn(INVOICE_STATUSES, { message: '状态（status）非法：须为 normal（正常）/ voided（已作废）' })
  status?: InvoiceStatus;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '订单 ID（orderId）须为整数' })
  orderId?: number;
}

class SummaryInvoicesDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}

class CreateInvoiceDto implements CreateInvoiceBody {
  @IsString({ message: '发票号码（invoiceNo）必填' })
  @IsNotEmpty({ message: '发票号码（invoiceNo）必填' })
  invoiceNo: string;

  @IsIn(INVOICE_TYPES, {
    message: '发票类型（invoiceType）非法：须为 vat_special（增值税专用发票）/ vat_general（增值税普通发票）/ electronic（电子发票）/ other（其他）',
  })
  invoiceType: InvoiceType;

  @IsInt({ message: '客户（customerId）必填' })
  customerId: number;

  @IsInt({ message: '不含税金额（amountExclCents，单位：分）必须是整数' })
  amountExclCents: number;

  @IsNumber({}, { message: '税率（taxRate）必填且须为数字（如 0.13；0 表示免税）' })
  taxRate: number;

  @IsOptional()
  @IsInt({ message: '税额（taxCents，单位：分）必须是整数' })
  taxCents?: number;

  @IsOptional()
  @IsInt({ message: '含税金额（amountInclCents，单位：分）必须是整数' })
  amountInclCents?: number;

  @IsOptional()
  @IsString({ message: '开票日期（issueDate）须为 YYYY-MM-DD 字符串' })
  issueDate?: string;

  @IsOptional()
  @IsArray({ message: '关联订单（orderIds）须为订单 ID 数组' })
  @IsInt({ each: true, message: '关联订单（orderIds）每项须为整数订单 ID' })
  orderIds?: number[];

  @IsOptional()
  @IsString()
  remark?: string;
}

class UpdateInvoiceDto implements UpdateInvoiceBody {
  @IsOptional()
  @IsString()
  remark?: string;

  @IsOptional()
  @IsString({ message: '开票日期（issueDate）须为 YYYY-MM-DD 字符串' })
  issueDate?: string;

  @IsOptional()
  @IsNumber({}, { message: '税率（taxRate）须为数字（如 0.13）' })
  taxRate?: number;

  @IsOptional()
  @IsInt({ message: '税额（taxCents，单位：分）必须是整数' })
  taxCents?: number;

  @IsOptional()
  @IsInt({ message: '含税金额（amountInclCents，单位：分）必须是整数' })
  amountInclCents?: number;

  @IsOptional()
  @IsInt({ message: '不含税金额（amountExclCents）不可修改' })
  amountExclCents?: number;

  @IsOptional()
  @IsArray({ message: '关联订单（orderIds）须为订单 ID 数组' })
  @IsInt({ each: true, message: '关联订单（orderIds）每项须为整数订单 ID' })
  orderIds?: number[];
}

class VoidInvoiceDto {
  @IsString({ message: '作废原因（reason）必填' })
  @IsNotEmpty({ message: '作废原因（reason）必填' })
  reason: string;
}

/**
 * 开票接口（I16，前缀 /api/invoices）
 * 权限：读操作登录即可（与既有约定一致）；写操作（新建/编辑/作废）限 admin / accounting。
 */
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly svc: InvoicesService) {}

  /** 列表：分页 + 客户/状态/开票日期区间/关键字（票号、备注、客户名、关联订单号） */
  @Get()
  list(@Query() q: ListInvoicesDto) {
    return this.svc.list(q);
  }

  /** 开票数目：张数 + 含税/不含税/税额合计 + 按客户/按月分组（只计未作废） */
  @Get('summary')
  summary(@Query() q: SummaryInvoicesDto) {
    return this.svc.summary(q.from, q.to);
  }

  /** 单订单开票/收款进度：订单金额 / 已开票 / 未开票 / 已收款 / 未收 + 发票清单 */
  @Get('order-status')
  orderStatus(@Query('orderId') orderId?: string) {
    const id = Number(orderId);
    if (!orderId || !Number.isInteger(id) || id <= 0) {
      throw new BadRequestException('订单 ID（orderId）必须是正整数');
    }
    return this.svc.orderStatus(id);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.svc.findOne(id);
  }

  @Roles('admin', 'accounting')
  @Post()
  create(@Body() dto: CreateInvoiceDto) {
    return this.svc.create(dto);
  }

  @Roles('admin', 'accounting')
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateInvoiceDto) {
    return this.svc.update(id, dto);
  }

  @Roles('admin', 'accounting')
  @Post(':id/void')
  voidInvoice(@Param('id', ParseIntPipe) id: number, @Body() dto: VoidInvoiceDto) {
    return this.svc.voidInvoice(id, dto.reason);
  }
}
