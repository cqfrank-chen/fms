import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IsBoolean, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Roles } from '../auth/decorators';
import { decodeUpload } from '../common/upload';
import { QuotesService } from './quotes.service';
import type { QuoteInput } from './quotes.service';

/**
 * 报价记录（I17）—— 独立单据「报价单」。
 * 权限：写操作与既有主数据维护一致（admin / planner，见 auth/permissions.ts 矩阵）；读操作不设 @Roles。
 * 上传协议与 AI 识单 / 主数据导入完全一致：file = dataURL(data:<mime>;base64,…) 或纯 base64 + fileName。
 */
class QuoteInputDto implements QuoteInput {
  @IsOptional() @IsInt() customerId?: number | null;
  @IsOptional() @IsInt() productId?: number | null;
  @IsOptional() @IsString() @MaxLength(200) productName?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }, { message: '单价须为数字（最多 2 位小数）' }) @Min(0) unitPrice?: number;
  @IsOptional() @IsInt() @Min(0) unitPriceCents?: number;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsString() @MaxLength(20) validFrom?: string | null;
  @IsOptional() @IsString() @MaxLength(20) validTo?: string | null;
  @IsOptional() @IsString() @MaxLength(20) source?: string;
  @IsOptional() @IsString() @MaxLength(255) sourceFile?: string | null;
  @IsOptional() @IsString() @MaxLength(500) remark?: string | null;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

/** 改价 DTO：单价必需，其余（币种/有效期/备注）可选 */
class QuotePriceDto {
  @IsNotEmpty({ message: '改价必须给出新单价' })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: '单价须为数字（最多 2 位小数）' })
  @Min(0)
  unitPrice: number;

  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsString() @MaxLength(20) validFrom?: string | null;
  @IsOptional() @IsString() @MaxLength(20) validTo?: string | null;
  @IsOptional() @IsString() @MaxLength(500) remark?: string | null;
}

class EnabledDto {
  @IsBoolean() enabled: boolean;
}

class QuoteImportDto {
  @IsOptional() @IsString() mode?: string;
  @IsOptional() @IsString() @MaxLength(255) fileName?: string;
  @IsNotEmpty({ message: 'file（上传文件内容）必填' })
  @IsString()
  file: string;
}

@Controller('quotes')
export class QuotesController {
  constructor(private readonly svc: QuotesService) {}

  /** 取价试算：按客户 + 产品（id 或名称文本）命中报价，返回价格与命中的规则说明 */
  @Get('lookup')
  lookup(
    @Query('customerId') customerId?: string,
    @Query('productId') productId?: string,
    @Query('productName') productName?: string,
    @Query('onDate') onDate?: string,
  ) {
    return this.svc.lookup({
      customerId: customerId ? Number(customerId) : null,
      productId: productId ? Number(productId) : null,
      productName: productName ?? null,
      onDate: onDate ?? null,
    });
  }

  /** 下载导入模板（CSV，中文表头 + 示例行） */
  @Get('template')
  template(@Res() res: Response) {
    const { name, csv } = this.svc.template();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(name));
    res.send('\uFEFF' + csv);
  }

  /** 列表：按客户/产品/关键词/是否有效筛选 + 分页 */
  @Get()
  findAll(
    @Query('customerId') customerId?: string,
    @Query('productId') productId?: string,
    @Query('kw') kw?: string,
    @Query('effective') effective?: string,
    @Query('enabled') enabled?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.findAll({
      customerId: customerId ? Number(customerId) : undefined,
      productId: productId ? Number(productId) : undefined,
      kw,
      effective,
      enabled,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /** 批量导入 · 预览（只读，不写库）：返回 新增/改价/跳过/错误 分类与原因 */
  @Roles('admin', 'planner')
  @Post('import/preview')
  preview(@Body() dto: QuoteImportDto) {
    const up = decodeUpload(dto.file, dto.fileName);
    return this.svc.preview({ buffer: up.buffer, fileName: up.name, mimeType: up.mime, mode: dto.mode });
  }

  /** 批量导入 · 确认（先重新解析校验，失败即中止不发写，再逐行写库） */
  @Roles('admin', 'planner')
  @Post('import/commit')
  commit(@Body() dto: QuoteImportDto) {
    const up = decodeUpload(dto.file, dto.fileName);
    return this.svc.commit({ buffer: up.buffer, fileName: up.name, mimeType: up.mime, mode: dto.mode });
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.svc.findOne(id);
  }

  @Roles('admin', 'planner')
  @Post()
  create(@Body() dto: QuoteInputDto) {
    return this.svc.create(dto);
  }

  @Roles('admin', 'planner')
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: QuoteInputDto) {
    return this.svc.update(id, dto);
  }

  /** 改价：只改单价（可选带币种/有效期/备注），写 updated_at + operator_id 留痕 */
  @Roles('admin', 'planner')
  @Put(':id/price')
  changePrice(@Param('id', ParseIntPipe) id: number, @Body() dto: QuotePriceDto) {
    return this.svc.changePrice(id, dto);
  }

  /** 停用 / 启用（不物理删除，历史行保留） */
  @Roles('admin', 'planner')
  @Patch(':id/enabled')
  setEnabled(@Param('id', ParseIntPipe) id: number, @Body() dto: EnabledDto) {
    return this.svc.setEnabled(id, dto.enabled);
  }
}
