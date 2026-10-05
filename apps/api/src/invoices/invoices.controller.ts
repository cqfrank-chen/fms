import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { Roles } from '../auth/decorators';
import { INVOICE_STATUSES, INVOICE_TYPES } from '../db/schema';
import type { InvoiceStatus, InvoiceType } from '../db/schema';
import { InvoicesService } from './invoices.service';
import type {
  CreateInvoiceDto as CreateInvoiceBody, RedFlushDto as RedFlushBody, UpdateInvoiceDto as UpdateInvoiceBody,
} from './invoices.service';

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

  /** 按客户 PO 号模糊筛选（I18）：匹配关联订单的 po_no，与 keyword 并存（AND） */
  @IsOptional()
  @IsString({ message: 'PO 号（poNo）须为字符串' })
  poNo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '订单 ID（orderId）须为整数' })
  orderId?: number;

  /** 只看待补票号（占位号且未作废）：?missingNo=true */
  @IsOptional()
  // 只接受 true/false/1/0；其它字符串原样透传 → 触发 @IsBoolean 报 400（避免非法值被静默当成 false）
  @Transform(({ value }) =>
    value === true || value === 'true' || value === '1'
      ? true
      : value === false || value === 'false' || value === '0'
        ? false
        : value,
  )
  @IsBoolean({ message: 'missingNo 须为布尔值（true/false）' })
  missingNo?: boolean;
}

class SummaryInvoicesDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}

/** 新建开票：简化路径只需 customerId + amountInclCents（含税，分），其余全部可选 */
class CreateInvoiceDto implements CreateInvoiceBody {
  @IsOptional()
  @IsString({ message: '发票号码（invoiceNo）须为字符串' })
  invoiceNo?: string;

  @IsOptional()
  @IsIn(INVOICE_TYPES, {
    message: '发票类型（invoiceType）非法：须为 vat_special（增值税专用发票）/ vat_general（增值税普通发票）/ electronic（电子发票）/ other（其他）',
  })
  invoiceType?: InvoiceType;

  @IsOptional()
  @IsInt({ message: '客户（customerId）须为整数；不传则由关联订单反推（未挂单时必填）' })
  customerId?: number;

  @IsOptional()
  @IsInt({ message: '不含税金额（amountExclCents，单位：分）必须是整数' })
  amountExclCents?: number;

  @IsOptional()
  @IsNumber({}, { message: '税率（taxRate）须为数字（如 0.13；0 表示免税）' })
  taxRate?: number;

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

  /** 允许超开（高级区显式勾选）：默认不允许，超出订单金额直接 400 */
  @IsOptional()
  @IsBoolean({ message: 'allowOverInvoiced 须为布尔值' })
  allowOverInvoiced?: boolean;

  /** 允许同 PO 重复开票（I18，高级区显式勾选）：默认返回重复开票 warning（不阻断），勾选后跳过该提示 */
  @IsOptional()
  @IsBoolean({ message: 'allowDuplicatePo 须为布尔值' })
  allowDuplicatePo?: boolean;
}

/** 红冲入参：红字票必须有自己的真实票号 + 冲红原因；金额为正数红冲额（缺省=全额） */
class RedFlushDto implements RedFlushBody {
  @IsString({ message: '冲红原因（reason）必填' })
  @IsNotEmpty({ message: '冲红原因（reason）必填' })
  reason: string;

  @IsString({ message: '红字发票号（invoiceNo）必填' })
  @IsNotEmpty({ message: '红字发票号（invoiceNo）必填' })
  invoiceNo: string;

  @IsOptional()
  @IsInt({ message: '红冲金额（amountInclCents，正数，单位：分）必须是整数' })
  @Min(1, { message: '红冲金额（amountInclCents）必须大于 0' })
  amountInclCents?: number;

  @IsOptional()
  @IsString({ message: '红冲日期（issueDate）须为 YYYY-MM-DD 字符串' })
  issueDate?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

/** 开票设置（当前只有默认税率） */
class InvoiceSettingsDto {
  @IsNumber({}, { message: '开票默认税率（defaultTaxRate）须为数字（0 / 0.01 / 0.06 / 0.09 / 0.13）' })
  defaultTaxRate: number;
}

class UpdateInvoiceDto implements UpdateInvoiceBody {
  @IsOptional()
  @IsString({ message: '发票号码（invoiceNo）须为字符串' })
  invoiceNo?: string;

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

  /** 列表：分页 + 客户/状态/开票日期区间/关键字（票号、备注、客户名、关联订单号）+ PO 号（I18） */
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

  /** 开票设置：默认税率（登录即可读） */
  @Get('settings')
  settings() {
    return this.svc.getSettings();
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

  /** 保存开票设置（默认税率）—— 必须声明在 PUT :id 之前，否则 'settings' 会被 :id 路由吞掉 */
  @Roles('admin', 'accounting')
  @Put('settings')
  saveSettings(@Body() dto: InvoiceSettingsDto) {
    return this.svc.saveSettings(dto);
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

  /** 红冲（跨月错票）：开具负数金额的红字发票冲减原票，原票状态置「已红冲」 */
  @Roles('admin', 'accounting')
  @Post(':id/red-flush')
  redFlush(@Param('id', ParseIntPipe) id: number, @Body() dto: RedFlushDto) {
    return this.svc.redFlush(id, dto);
  }

}
